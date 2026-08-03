import { beforeEach, describe, expect, it, vi } from "vitest";

const agentMocks = vi.hoisted(() => ({ agentLoop: vi.fn() }));
vi.mock("@earendil-works/pi-agent-core", () => ({ agentLoop: agentMocks.agentLoop }));

import { Contemplator } from "../src/agents/contemplator/agent.js";
import { Runtime } from "../src/runtime.js";
import {
	observation,
	observationsRecordedEntry,
	textCustomMessage,
	type TestEntry,
} from "./fixtures/session.js";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function stream(waitFor: Promise<void> = Promise.resolve()) {
	return {
		async *[Symbol.asyncIterator]() {
			await waitFor;
		},
		result: async () => [],
	};
}

function setup(initialEntries: TestEntry[] = []) {
	let entries = [...initialEntries];
	const handlers: Record<string, Array<(event: any, ctx: any) => void>> = {};
	const pi = {
		on: vi.fn((event: string, handler: (event: any, ctx: any) => void) => {
			(handlers[event] ??= []).push(handler);
		}),
		appendEntry: vi.fn((customType: string, data: unknown) => {
			entries = [...entries, {
				id: `appended-${pi.appendEntry.mock.calls.length}`,
				type: "custom",
				parentId: entries.at(-1)?.id ?? null,
				timestamp: "2026-05-02T10:00:00.000Z",
				customType,
				data,
			} as TestEntry];
		}),
		sendMessage: vi.fn(),
	};
	const runtime = new Runtime();
	runtime.configLoaded = true;
	runtime.config = {
		...runtime.config,
		contemplatorEnabled: true,
		contemplatorMinNewObservations: 1,
		contemplatorMinNewReflections: 1,
		contemplatorMinTurns: 1,
		passive: false,
	};
	const ctx = {
		cwd: "/tmp/project",
		hasUI: false,
		model: { provider: "session", id: "model", contextWindow: 100_000 },
		modelRegistry: {
			find: vi.fn(),
			getApiKeyAndHeaders: vi.fn(async () => ({ ok: true, apiKey: "key" })),
		},
		sessionManager: { getBranch: () => entries },
	};
	const contemplator = new Contemplator(pi as any, runtime);
	contemplator.register();
	const fire = (event: string, payload: unknown = {}) => {
		for (const handler of handlers[event] ?? []) handler(payload, ctx);
	};
	return {
		pi,
		runtime,
		ctx,
		contemplator,
		fire,
		setEntries(next: TestEntry[]) {
			entries = [...next];
		},
		getEntries: () => entries,
	};
}

beforeEach(() => {
	agentMocks.agentLoop.mockReset();
	agentMocks.agentLoop.mockImplementation(() => stream());
});

describe("Contemplator lifecycle", () => {
	it("does not requeue a probe whose custom message is already on the branch", () => {
		const entries = [
			{
				id: "probe-message",
				type: "custom_message",
				customType: "om.contemplator.suggestion",
				content: "Background contemplator probe (advisory):\nQuestion?",
				details: { probeId: "probe-1", question: "Question?" },
			},
			{
				id: "probe-tracking",
				type: "custom",
				customType: "om.contemplator.suggestion",
				data: { probeId: "probe-1", suggestion: "Question?", delivered: false },
			},
		] as TestEntry[];
		const harness = setup(entries);

		harness.fire("session_start");

		expect(harness.pi.sendMessage).not.toHaveBeenCalled();
		expect(harness.pi.appendEntry).not.toHaveBeenCalled();
	});

	it("resets branch-local tracking and pending work on tree navigation", () => {
		const branchA = [textCustomMessage("raw-a", "branch a")];
		const branchB = [textCustomMessage("raw-b", "branch b")];
		const harness = setup(branchA);
		harness.fire("session_start");
		const state = harness.contemplator as any;
		state.pending = { observations: ["[aaaaaaaaaaaa] branch a"], reflections: [] };
		state.turnsSinceRun = 9;
		state.seenObservationIds.add("aaaaaaaaaaaa");

		harness.setEntries(branchB);
		harness.fire("session_tree", { oldLeafId: "raw-a", newLeafId: "raw-b" });

		expect(state.pending).toBeUndefined();
		expect(state.turnsSinceRun).toBe(0);
		expect([...state.seenObservationIds]).toEqual([]);
		expect(state.restoredTipId).toBe("raw-b");
	});

	it("marks every newly visible probe delivered, not just the first", () => {
		const harness = setup();
		harness.fire("session_start");
		const messages = [
			{ role: "custom", customType: "om.contemplator.suggestion", content: "one", details: { probeId: "probe-1", question: "Question one?" } },
			{ role: "custom", customType: "om.contemplator.suggestion", content: "two", details: { probeId: "probe-2", question: "Question two?" } },
		];

		harness.fire("context", { messages });
		harness.fire("context", { messages });

		expect(harness.pi.appendEntry).toHaveBeenCalledTimes(2);
		expect(harness.pi.appendEntry).toHaveBeenCalledWith("om.contemplator.suggestion", expect.objectContaining({ probeId: "probe-1", delivered: true }));
		expect(harness.pi.appendEntry).toHaveBeenCalledWith("om.contemplator.suggestion", expect.objectContaining({ probeId: "probe-2", delivered: true }));
	});

	it("rechecks turn throttling before processing updates queued during a run", async () => {
		const gate = deferred();
		agentMocks.agentLoop
			.mockImplementationOnce(() => stream(gate.promise))
			.mockImplementation(() => stream());
		const rawA = textCustomMessage("raw-a", "branch a");
		const obsA = observationsRecordedEntry("obs-a", {
			observations: [observation("aaaaaaaaaaaa", { sourceEntryIds: ["raw-a"] })],
			coversUpToId: "raw-a",
		});
		const harness = setup([]);
		harness.fire("session_start");
		harness.setEntries([rawA, obsA]);

		harness.fire("turn_end");
		await vi.waitFor(() => expect(agentMocks.agentLoop).toHaveBeenCalledTimes(1));

		const rawB = textCustomMessage("raw-b", "branch b");
		const obsB = observationsRecordedEntry("obs-b", {
			observations: [observation("bbbbbbbbbbbb", { sourceEntryIds: ["raw-b"] })],
			coversUpToId: "raw-b",
		});
		harness.setEntries([...harness.getEntries(), rawB, obsB]);
		harness.runtime.notifyMemoryUpdate(harness.ctx as any);
		gate.resolve();
		await vi.waitFor(() => expect(harness.pi.appendEntry).toHaveBeenCalledWith("om.contemplator.message", expect.anything()));

		expect(agentMocks.agentLoop).toHaveBeenCalledTimes(1);
		harness.fire("turn_end");
		await vi.waitFor(() => expect(agentMocks.agentLoop).toHaveBeenCalledTimes(2));
	});

	it("records agentLoop usage into runtime.agentUsage", async () => {
		const usage = {
			input: 1000,
			output: 200,
			cacheRead: 5000,
			cacheWrite: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.0015 },
		};
		agentMocks.agentLoop.mockImplementation(() => ({
			async *[Symbol.asyncIterator]() {},
			result: async () => [
				{ role: "assistant", content: [{ type: "text", text: "ok" }], usage, stopReason: "stop", timestamp: Date.now() },
			],
		}));
		const harness = setup();
		harness.fire("session_start");
		const rawA = textCustomMessage("raw-a", "branch a");
		const obsA = observationsRecordedEntry("obs-a", {
			observations: [observation("aaaaaaaaaaaa", { sourceEntryIds: ["raw-a"] })],
			coversUpToId: "raw-a",
		});
		harness.setEntries([rawA, obsA]);

		harness.fire("turn_end");

		await vi.waitFor(() => expect(harness.runtime.agentUsage.runs).toBe(1));
		expect(harness.runtime.agentUsage.input).toBe(1000);
		expect(harness.runtime.agentUsage.output).toBe(200);
		expect(harness.runtime.agentUsage.cacheRead).toBe(5000);
		expect(harness.runtime.agentUsage.cacheWrite).toBe(0);
		expect(harness.runtime.agentUsage.cost).toBeCloseTo(0.0015);
	});
});

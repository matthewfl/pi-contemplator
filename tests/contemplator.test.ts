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

	it("does not requeue a live probe at turn_end before Pi delivers its steer", () => {
		const harness = setup();
		harness.fire("session_start", { reason: "startup" });
		(harness.contemplator as any).queueProbe(harness.ctx, "Question?", "send_probe", "probe-1");
		harness.setEntries([
			...harness.getEntries(),
			{ id: "main-agent-result", type: "message", message: { role: "toolResult", content: [] } } as TestEntry,
		]);

		harness.fire("turn_end");

		expect(harness.pi.sendMessage).toHaveBeenCalledTimes(1);
		expect(harness.pi.appendEntry.mock.calls.filter(([type]) => type === "om.contemplator.suggestion")).toHaveLength(1);
	});

	it("does not requeue an undelivered steer preserved across extension reload", () => {
		const harness = setup([{
			id: "probe-tracking",
			type: "custom",
			customType: "om.contemplator.suggestion",
			data: { probeId: "probe-1", suggestion: "Question?", delivered: false },
		}] as TestEntry[]);

		harness.fire("session_start", { reason: "reload" });

		expect(harness.pi.sendMessage).not.toHaveBeenCalled();
		expect(harness.pi.appendEntry).not.toHaveBeenCalled();
	});

	it("restores an undelivered probe on fresh session startup", () => {
		const harness = setup([{
			id: "probe-tracking",
			type: "custom",
			customType: "om.contemplator.suggestion",
			data: { probeId: "probe-1", suggestion: "Question?", delivered: false },
		}] as TestEntry[]);

		harness.fire("session_start", { reason: "startup" });

		expect(harness.pi.sendMessage).toHaveBeenCalledTimes(1);
		expect(harness.pi.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
			details: expect.objectContaining({ probeId: "probe-1", source: "restore" }),
		}), { deliverAs: "steer", triggerTurn: false });
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

	it("includes cumulative primary-agent output tokens and tool calls on the current branch", async () => {
		const earlierAssistant = {
			type: "message",
			id: "assistant-before-memory",
			message: { role: "assistant", content: [{ type: "toolCall", name: "read" }], usage: { output: 123 } },
		} as TestEntry;
		const latestAssistant = {
			type: "message",
			id: "assistant-memory-source",
			message: { role: "assistant", content: [{ type: "toolCall", name: "edit" }, { type: "toolCall", name: "read" }], usage: { output: 77 } },
		} as TestEntry;
		const memory = observationsRecordedEntry("obs-memory", {
			observations: [observation("aaaaaaaaaaaa", { sourceEntryIds: ["assistant-memory-source"] })],
			coversUpToId: "assistant-memory-source",
		});
		const harness = setup([earlierAssistant, latestAssistant, memory]);

		harness.fire("turn_end");
		await vi.waitFor(() => expect(agentMocks.agentLoop).toHaveBeenCalledTimes(1));

		const prompt = agentMocks.agentLoop.mock.calls[0][0][0];
		expect(prompt.content[0].text).toContain("ACTIVITY SIGNAL cumulative primary-agent generated tokens: 200; cumulative primary-agent tool calls: 3");
	});

	it("resumes a pending reviewer transcript with a keep-going prompt on session start", async () => {
		const reviewRequest = {
			id: "review-pending", scope: "workflow", evidence: "[aaaaaaaaaaaa] recurring work",
			concern: "A structural issue may exist.", reviewFocus: "Decide whether a proposal is warranted.",
			createdAt: 1, requestedBy: "contemplator",
		};
		const persistedAssistant = { role: "assistant", content: [{ type: "text", text: "I need more evidence." }], timestamp: 1, usage: { output: 10 } };
		const harness = setup([
			{ id: "review-request", type: "custom", customType: "om.review.request", data: { version: 1, request: reviewRequest } },
			{ id: "review-message", type: "custom", customType: "om.reviewer.message", data: { version: 1, reviewRequestId: reviewRequest.id, scope: "workflow", message: persistedAssistant } },
		] as TestEntry[]);

		harness.fire("session_start");
		await vi.waitFor(() => expect(agentMocks.agentLoop).toHaveBeenCalledTimes(1));

		const [prompts, context] = agentMocks.agentLoop.mock.calls[0];
		expect(prompts[0].content[0].text).toContain("You have not yet produced a terminal review outcome");
		expect(context.messages).toEqual([persistedAssistant]);
		expect(harness.pi.appendEntry).toHaveBeenCalledWith("om.reviewer.message", expect.objectContaining({ reviewRequestId: "review-pending", message: expect.objectContaining({ role: "user" }) }));
	});

	it("persists reviewer compaction state as entry references without copying history", () => {
		const reviewRequest = {
			id: "review-pending", scope: "workflow", evidence: "[aaaaaaaaaaaa] recurring work",
			concern: "A structural issue may exist.", reviewFocus: "Decide whether a proposal is warranted.",
			createdAt: 1, requestedBy: "contemplator",
		};
		const largeMessage = { role: "toolResult", content: [{ type: "text", text: "x".repeat(100_000) }], timestamp: 1 };
		const harness = setup([
			{ id: "review-request", type: "custom", customType: "om.review.request", data: { version: 1, request: reviewRequest } },
			{ id: "review-message-1", type: "custom", customType: "om.reviewer.message", data: { version: 1, reviewRequestId: reviewRequest.id, scope: "workflow", message: largeMessage } },
		] as TestEntry[]);
		harness.runtime.config = { ...harness.runtime.config, reviewerEnabled: false };
		harness.fire("session_start");

		harness.fire("session_compact");

		const firstState = harness.pi.appendEntry.mock.calls.find(([type]) => type === "om.reviewer.state")?.[1] as Record<string, unknown>;
		expect(firstState).toEqual({
			version: 2,
			reviewRequestId: "review-pending",
			scope: "workflow",
			previousStateEntryId: undefined,
			messageEntryIds: ["review-message-1"],
		});
		expect(firstState).not.toHaveProperty("history");
		expect(JSON.stringify(firstState).length).toBeLessThan(250);

		// No transcript changes means there is no reason to append another checkpoint.
		harness.fire("session_compact");
		expect(harness.pi.appendEntry.mock.calls.filter(([type]) => type === "om.reviewer.state")).toHaveLength(1);

		const secondMessage = {
			id: "review-message-2", type: "custom", customType: "om.reviewer.message",
			data: { version: 1, reviewRequestId: reviewRequest.id, scope: "workflow", message: { role: "assistant", content: [], timestamp: 2 } },
		} as TestEntry;
		harness.setEntries([...harness.getEntries(), secondMessage]);
		harness.fire("session_tree");
		harness.fire("session_compact");

		const states = harness.pi.appendEntry.mock.calls.filter(([type]) => type === "om.reviewer.state");
		expect(states).toHaveLength(2);
		expect(states[1][1]).toEqual(expect.objectContaining({
			version: 2,
			previousStateEntryId: "appended-1",
			messageEntryIds: ["review-message-2"],
		}));
	});

	it("restores referenced reviewer checkpoints and legacy inline snapshots", async () => {
		const reviewRequest = {
			id: "review-pending", scope: "workflow", evidence: "[aaaaaaaaaaaa] recurring work",
			concern: "A structural issue may exist.", reviewFocus: "Decide whether a proposal is warranted.",
			createdAt: 1, requestedBy: "contemplator",
		};
		const legacyMessage = { role: "assistant", content: [{ type: "text", text: "legacy" }], timestamp: 1, usage: { output: 10 } };
		const newerMessage = { role: "assistant", content: [{ type: "text", text: "newer" }], timestamp: 2, usage: { output: 10 } };
		const harness = setup([
			{ id: "review-request", type: "custom", customType: "om.review.request", data: { version: 1, request: reviewRequest } },
			{ id: "legacy-state", type: "custom", customType: "om.reviewer.state", data: { version: 1, reviewRequestId: reviewRequest.id, scope: "workflow", history: [legacyMessage] } },
			{ id: "review-message", type: "custom", customType: "om.reviewer.message", data: { version: 1, reviewRequestId: reviewRequest.id, scope: "workflow", message: newerMessage } },
			{ id: "reference-state", type: "custom", customType: "om.reviewer.state", data: { version: 2, reviewRequestId: reviewRequest.id, scope: "workflow", previousStateEntryId: "legacy-state", messageEntryIds: ["review-message"] } },
		] as TestEntry[]);

		harness.fire("session_start");
		await vi.waitFor(() => expect(agentMocks.agentLoop).toHaveBeenCalledTimes(1));

		const [, context] = agentMocks.agentLoop.mock.calls[0];
		expect(context.messages).toEqual([legacyMessage, newerMessage]);
	});

	it("does not credit a concurrently-appended foreign entry as a reviewer message", async () => {
		const reviewRequest = {
			id: "review-pending", scope: "workflow", evidence: "[aaaaaaaaaaaa] recurring work",
			concern: "A structural issue may exist.", reviewFocus: "Decide whether a proposal is warranted.",
			createdAt: 1, requestedBy: "contemplator",
		};
		const harness = setup([
			{ id: "review-request", type: "custom", customType: "om.review.request", data: { version: 1, request: reviewRequest } },
		] as TestEntry[]);
		agentMocks.agentLoop.mockImplementation(() => ({
			async *[Symbol.asyncIterator]() {},
			result: async () => [{ role: "assistant", content: [{ type: "text", text: "investigating" }], timestamp: Date.now() }],
		}));
		// Simulate a concurrent append landing immediately after each of ours,
		// ahead of any branch-tail based id inference. (Capture the pre-wrap
		// implementation: re-entering the vi.fn itself would recurse.)
		const baseAppend = harness.pi.appendEntry.getMockImplementation()!;
		harness.pi.appendEntry.mockImplementation((customType: string, data: unknown) => {
			baseAppend(customType, data);
			harness.setEntries([...harness.getEntries(), { id: `foreign-${harness.pi.appendEntry.mock.calls.length}`, type: "custom", customType: "om.other", data: {} } as TestEntry]);
		});

		harness.fire("session_start");
		await vi.waitFor(() => expect(harness.pi.appendEntry.mock.calls.filter(([type]) => type === "om.reviewer.message")).toHaveLength(2));

		harness.fire("session_compact");
		const states = harness.pi.appendEntry.mock.calls.filter(([type]) => type === "om.reviewer.state");
		expect(states).toHaveLength(1);
		expect(states[0][1]).toEqual(expect.objectContaining({ version: 2, messageEntryIds: ["appended-1", "appended-2"] }));
	});

	it("does not duplicate reviewer session state when the branch tip advances between turns", () => {
		const message = (text: string, timestamp: number) => ({ role: "user", content: [{ type: "text", text }], timestamp });
		const harness = setup([
			{ id: "rm-1", type: "custom", customType: "om.reviewer.message", data: { version: 1, reviewRequestId: "review-pending", scope: "workflow", message: message("one", 1) } },
		] as TestEntry[]);
		harness.runtime.config = { ...harness.runtime.config, reviewerEnabled: false };
		harness.fire("session_start");
		expect(agentMocks.agentLoop).not.toHaveBeenCalled();

		harness.setEntries([...harness.getEntries(), { id: "rm-2", type: "custom", customType: "om.reviewer.message", data: { version: 1, reviewRequestId: "review-pending", scope: "workflow", message: message("two", 2) } } as TestEntry]);
		harness.fire("turn_end");
		harness.setEntries([...harness.getEntries(), { id: "rm-3", type: "custom", customType: "om.reviewer.message", data: { version: 1, reviewRequestId: "review-pending", scope: "workflow", message: message("three", 3) } } as TestEntry]);
		harness.fire("turn_end");

		harness.fire("session_compact");
		const states = harness.pi.appendEntry.mock.calls.filter(([type]) => type === "om.reviewer.state");
		expect(states).toHaveLength(1);
		expect(states[0][1]).toEqual(expect.objectContaining({ version: 2, messageEntryIds: ["rm-1", "rm-2", "rm-3"] }));
	});

	it("runs persisted review requests one at a time", async () => {
		const firstGate = deferred();
		agentMocks.agentLoop
			.mockImplementationOnce(() => stream(firstGate.promise))
			.mockImplementation(() => stream());
		const reviewRequest = (id: string) => ({
			id, scope: "workflow", evidence: "[aaaaaaaaaaaa] recurring work",
			concern: "A structural issue may exist.", reviewFocus: "Decide whether a proposal is warranted.",
			createdAt: 1, requestedBy: "contemplator",
		});
		const harness = setup([
			{ id: "request-one", type: "custom", customType: "om.review.request", data: { version: 1, request: reviewRequest("review-one") } },
			{ id: "request-two", type: "custom", customType: "om.review.request", data: { version: 1, request: reviewRequest("review-two") } },
		] as TestEntry[]);

		harness.fire("session_start");
		await vi.waitFor(() => expect(agentMocks.agentLoop).toHaveBeenCalledTimes(1));
		expect(harness.runtime.reviewInFlight).toBe(true);

		firstGate.resolve();
		await vi.waitFor(() => expect(agentMocks.agentLoop).toHaveBeenCalledTimes(2));
		const firstPrompt = agentMocks.agentLoop.mock.calls[0][0][0].content[0].text;
		const secondPrompt = agentMocks.agentLoop.mock.calls[1][0][0].content[0].text;
		expect(firstPrompt).toContain("review-one");
		expect(secondPrompt).toContain("review-two");
	});

	it("removes reviewer instructions and tools when reviewers are disabled", async () => {
		const harness = setup();
		harness.runtime.config = { ...harness.runtime.config, reviewerEnabled: false };
		harness.fire("session_start");
		harness.setEntries([
			textCustomMessage("raw-a", "branch a"),
			observationsRecordedEntry("obs-a", {
				observations: [observation("aaaaaaaaaaaa", { sourceEntryIds: ["raw-a"] })],
				coversUpToId: "raw-a",
			}),
		]);

		harness.fire("turn_end");
		await vi.waitFor(() => expect(agentMocks.agentLoop).toHaveBeenCalledTimes(1));

		const [, context] = agentMocks.agentLoop.mock.calls[0];
		expect(context.systemPrompt).not.toContain("Structural reviews are enabled");
		expect(context.tools.map((tool: { name: string }) => tool.name)).toEqual(["search_memories", "recall", "send_probe"]);
		const prompt = agentMocks.agentLoop.mock.calls[0][0][0];
		expect(prompt.content[0].text).not.toContain("request_review");
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

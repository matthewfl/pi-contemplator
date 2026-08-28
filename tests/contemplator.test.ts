import { beforeEach, describe, expect, it, vi } from "vitest";

const agentMocks = vi.hoisted(() => ({ agentLoop: vi.fn() }));
vi.mock("@earendil-works/pi-agent-core", () => ({ agentLoop: agentMocks.agentLoop }));

import { Contemplator } from "../src/agents/contemplator/agent.js";
import { REVIEWER_TOTAL_TOKEN_LIMIT } from "../src/model-budget.js";
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

function stream(waitFor: Promise<void> = Promise.resolve(), messages: any[] = []) {
	return {
		async *[Symbol.asyncIterator]() {
			await waitFor;
		},
		result: async () => messages,
	};
}

function selectNoIntervention(context: { tools?: Array<{ name: string; execute: (id: string, args: any) => Promise<unknown> }> }): void {
	const tool = context.tools?.find((candidate) => candidate.name === "no_intervention");
	if (tool) void tool.execute("test-no-intervention", {});
}

function selectProbe(context: { tools?: Array<{ name: string; execute: (id: string, args: any) => Promise<unknown> }> }, question = "Check the current approach?"): void {
	const tool = context.tools?.find((candidate) => candidate.name === "send_probe");
	if (tool) void tool.execute("test-send-probe", { question });
}

function setup(initialEntries: TestEntry[] = []) {
	let entries = [...initialEntries];
	const handlers: Record<string, Array<(event: any, ctx: any) => void>> = {};
	const pi = {
		on: vi.fn((event: string, handler: (event: any, ctx: any) => void) => {
			(handlers[event] ??= []).push(handler);
		}),
		registerMessageRenderer: vi.fn(),
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
		contemplatorMinNewSummaries: 1,
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
	agentMocks.agentLoop.mockImplementation((_prompts, context) => {
		selectNoIntervention(context);
		return stream();
	});
});

describe("Contemplator lifecycle", () => {
	it("registers purple renderers for visible contemplator messages", () => {
		const harness = setup();

		expect(harness.pi.registerMessageRenderer).toHaveBeenCalledTimes(2);
		expect(harness.pi.registerMessageRenderer).toHaveBeenCalledWith("om.contemplator.suggestion", expect.any(Function));
		expect(harness.pi.registerMessageRenderer).toHaveBeenCalledWith("om.review.proposal", expect.any(Function));

		const probeRenderer = harness.pi.registerMessageRenderer.mock.calls.find(([type]) => type === "om.contemplator.suggestion")?.[1];
		const theme = {
			fg: vi.fn((_color: string, text: string) => text),
			bg: vi.fn((_color: string, text: string) => text),
			bold: vi.fn((text: string) => text),
		};
		probeRenderer?.({
			content: "Background contemplator probe (advisory):\nQuestion?\n\nReferenced memories can be reviewed using the recall tool.",
			details: { question: "Question?" },
		}, { expanded: false }, theme);
		expect(theme.fg).toHaveBeenCalledWith("thinkingHigh", "◆ CONTEMPLATOR PROBE\nQuestion?");
		expect(theme.fg).not.toHaveBeenCalledWith("thinkingHigh", expect.stringContaining("Referenced memories"));
	});

	it("shows contemplator lifecycle notifications when worker notifications are enabled", async () => {
		const raw = textCustomMessage("raw-notify", "work to remember");
		const memory = observationsRecordedEntry("obs-notify", {
			observations: [observation("aaaaaaaaaaaa", { sourceEntryIds: ["raw-notify"] })],
			coversUpToId: "raw-notify",
		});
		const harness = setup([]);
		const notify = vi.fn();
		harness.ctx.hasUI = true;
		(harness.ctx as any).ui = { notify };
		harness.runtime.config = { ...harness.runtime.config, showWorkerNotifications: true };

		harness.fire("session_start");
		harness.setEntries([raw, memory]);
		harness.fire("turn_end");

		await vi.waitFor(() => expect(notify).toHaveBeenCalledWith("pi-contemplator: contemplator completed", "info"));
		expect(notify).toHaveBeenCalledWith("pi-contemplator: contemplator running", "info");
		expect(notify.mock.calls.map(([message]) => message)).toEqual([
			"pi-contemplator: contemplator running",
			"pi-contemplator: contemplator completed",
		]);
	});

	it("surfaces a model stream error directly without misreporting missing tool calls", async () => {
		agentMocks.agentLoop.mockImplementation(() => stream(Promise.resolve(), [
			{ role: "assistant", content: [], stopReason: "error", errorMessage: "400: reasoning is mandatory", timestamp: Date.now() },
		]));
		const harness = setup([]);
		const notify = vi.fn();
		harness.ctx.hasUI = true;
		(harness.ctx as any).ui = { notify };
		harness.runtime.config = { ...harness.runtime.config, showWorkerNotifications: true };
		harness.setEntries([
			textCustomMessage("raw-error", "work to remember"),
			observationsRecordedEntry("obs-error", {
				observations: [observation("aaaaaaaaaaaa", { sourceEntryIds: ["raw-error"] })],
				coversUpToId: "raw-error",
			}),
		]);

		harness.fire("turn_end");

		await vi.waitFor(() => expect(notify).toHaveBeenCalledWith("pi-contemplator: contemplator failed — 400: reasoning is mandatory", "warning"));
		expect(agentMocks.agentLoop).toHaveBeenCalledTimes(1);
		expect(harness.runtime.contemplatorState.lastError).toBe("400: reasoning is mandatory");
		expect(harness.runtime.contemplatorState.pendingObservations).toBe(1);
		expect(harness.runtime.contemplatorState.responsesSinceRun).toBe(0);
		expect(harness.runtime.contemplatorState.waitingFor).toBe("responses");

		// One fresh primary response permits one bounded retry. A second failure
		// releases this poisoned update instead of charging every later checkpoint.
		harness.fire("message_end", { message: { role: "assistant" } });
		await vi.waitFor(() => expect(agentMocks.agentLoop).toHaveBeenCalledTimes(2));
		expect(harness.runtime.contemplatorState.pendingObservations).toBe(0);

		// Future memory still gets its own opportunity; the released batch does not
		// permanently disable the contemplator.
		harness.setEntries([
			...harness.getEntries(),
			textCustomMessage("raw-after-error", "future work"),
			observationsRecordedEntry("obs-after-error", {
				observations: [observation("bbbbbbbbbbbb", { sourceEntryIds: ["raw-after-error"] })],
				coversUpToId: "raw-after-error",
			}),
		]);
		harness.fire("message_end", { message: { role: "assistant" } });
		await vi.waitFor(() => expect(agentMocks.agentLoop).toHaveBeenCalledTimes(3));
		expect(harness.runtime.contemplatorState.pendingObservations).toBe(1);
	});

	it("persists each update prompt once when agentLoop returns that input prompt", async () => {
		agentMocks.agentLoop.mockImplementation((prompts, context) => {
			selectNoIntervention(context);
			return stream(Promise.resolve(), [
				prompts[0],
				{ role: "assistant", content: [{ type: "text", text: "No intervention." }], stopReason: "stop" },
			]);
		});
		const raw = textCustomMessage("raw-prompt-once", "work to contemplate");
		const memory = observationsRecordedEntry("obs-prompt-once", {
			observations: [observation("aaaaaaaaaaaa", { sourceEntryIds: ["raw-prompt-once"] })],
			coversUpToId: "raw-prompt-once",
		});
		const harness = setup([]);
		harness.fire("session_start");
		harness.setEntries([raw, memory]);
		harness.fire("turn_end");

		await vi.waitFor(() => expect(harness.pi.appendEntry).toHaveBeenCalledWith("om.contemplator.message", expect.anything()));
		const persistedMessages = harness.pi.appendEntry.mock.calls
			.filter(([type]) => type === "om.contemplator.message")
			.map(([, data]) => (data as { message: { role: string } }).message);
		expect(persistedMessages.filter((message) => message.role === "user")).toHaveLength(1);
		expect(persistedMessages.filter((message) => message.role === "assistant")).toHaveLength(1);
	});

	it("requeues an unconfirmed probe on fresh startup even when its custom message was persisted", () => {
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

		harness.fire("session_start", { reason: "startup" });

		expect(harness.pi.sendMessage).toHaveBeenCalledTimes(1);
		expect(harness.pi.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
			details: expect.objectContaining({ probeId: "probe-1", source: "restore" }),
		}), { deliverAs: "steer" });
	});

	it("does not requeue a live probe at turn_end before Pi inserts it", () => {
		const harness = setup();
		harness.fire("session_start", { reason: "startup" });
		harness.fire("agent_start");
		(harness.contemplator as any).queueProbe(harness.ctx, "Question?", "send_probe", "probe-1");
		harness.setEntries([
			...harness.getEntries(),
			{ id: "main-agent-result", type: "message", message: { role: "toolResult", content: [] } } as TestEntry,
		]);

		harness.fire("turn_end");

		expect(harness.pi.sendMessage).toHaveBeenCalledTimes(1);
		expect(harness.pi.appendEntry.mock.calls.filter(([type]) => type === "om.contemplator.suggestion")).toHaveLength(1);
	});

	it("does not duplicate an idle queued probe when a memory update restores the ledger", () => {
		const harness = setup();
		harness.fire("session_start", { reason: "startup" });
		(harness.contemplator as any).queueProbe(harness.ctx, "Question?", "send_probe", "probe-idle");

		// A background observer completion changes the branch tip and invokes the
		// contemplator while Pi still owns the original idle steer.
		harness.runtime.notifyMemoryUpdate(harness.ctx as any);

		expect(harness.pi.sendMessage).toHaveBeenCalledTimes(1);
		expect(harness.pi.appendEntry.mock.calls.filter(([type]) => type === "om.contemplator.suggestion")).toHaveLength(1);
		expect((harness.contemplator as any).queuedProbeIds.has("probe-idle")).toBe(true);
	});

	it("does not deadlock contemplation when observer setup is unavailable", async () => {
		const firstSource = textCustomMessage("raw-degraded", "old source");
		const observed = observation("abcdef654321", { timestamp: "2026-05-02 10:00", sourceEntryIds: ["raw-degraded"] });
		const firstBatch = observationsRecordedEntry("batch-degraded", { observations: [observed], coversUpToId: "raw-degraded" });
		const backlog = textCustomMessage("raw-unavailable", "x".repeat(80_000));
		const harness = setup([firstSource, firstBatch, backlog]);
		harness.runtime.lastObserverError = "no model available";
		(harness.contemplator as any).turnsSinceRun = 1;

		harness.runtime.notifyMemoryUpdate(harness.ctx as any);

		await vi.waitFor(() => expect(agentMocks.agentLoop).toHaveBeenCalledTimes(1));
		expect((harness.contemplator as any).seenObservationIds.has("abcdef654321")).toBe(true);
	});

	it("waits for the observer to drain a catch-up backlog before consuming its memories", async () => {
		const firstSource = textCustomMessage("raw-old", "old source");
		const observed = observation("abcdef123456", { timestamp: "2026-05-02 10:00", sourceEntryIds: ["raw-old"] });
		const firstBatch = observationsRecordedEntry("batch-old", { observations: [observed], coversUpToId: "raw-old" });
		const backlog = textCustomMessage("raw-backlog", "x".repeat(80_000));
		const harness = setup([firstSource, firstBatch, backlog]);
		(harness.contemplator as any).turnsSinceRun = 1;

		harness.runtime.notifyMemoryUpdate(harness.ctx as any);

		expect(agentMocks.agentLoop).not.toHaveBeenCalled();
		expect(harness.runtime.contemplatorState.waitingFor).toBe("observer");
		expect((harness.contemplator as any).seenObservationIds.has("abcdef123456")).toBe(false);

		harness.setEntries([
			...harness.getEntries(),
			observationsRecordedEntry("batch-backlog", { observations: [], coversUpToId: "raw-backlog" }),
		]);
		harness.runtime.notifyMemoryUpdate(harness.ctx as any);

		await vi.waitFor(() => expect(agentMocks.agentLoop).toHaveBeenCalledTimes(1));
		expect((harness.contemplator as any).seenObservationIds.has("abcdef123456")).toBe(true);
	});

	it("does not let source arriving during a completed observer snapshot block contemplation", async () => {
		const firstSource = textCustomMessage("raw-snapshot", "old source");
		const observed = observation("abcdef123456", { timestamp: "2026-05-02 10:00", sourceEntryIds: ["raw-snapshot"] });
		const firstBatch = observationsRecordedEntry("batch-snapshot", { observations: [observed], coversUpToId: "raw-snapshot" });
		const concurrentSource = textCustomMessage("raw-concurrent", "x".repeat(80_000));
		const harness = setup([firstSource, firstBatch, concurrentSource]);
		harness.runtime.consolidationInFlight = true;
		harness.runtime.observerBacklogBlocking = false;
		(harness.contemplator as any).turnsSinceRun = 1;

		// This models the completed snapshot's notification before its tracked
		// consolidation lock is released. raw-concurrent is deferred, not part of
		// the snapshot that contemplation was waiting for.
		harness.runtime.notifyMemoryUpdate(harness.ctx as any);

		await vi.waitFor(() => expect(agentMocks.agentLoop).toHaveBeenCalledTimes(1));
		expect((harness.contemplator as any).seenObservationIds.has("abcdef123456")).toBe(true);
	});

	it("keeps visible and hidden probes on the steer delivery path", () => {
		const visible = setup();
		(visible.contemplator as any).queueProbe(visible.ctx, "Visible?", "send_probe", "probe-visible");
		expect(visible.pi.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
			customType: "om.contemplator.suggestion",
			content: "Background contemplator probe (advisory):\nVisible?\n\nReferenced memories can be reviewed using the recall tool.",
			display: true,
		}), { deliverAs: "steer" });

		const hidden = setup();
		hidden.runtime.config = { ...hidden.runtime.config, showContemplatorMessages: false };
		(hidden.contemplator as any).queueProbe(hidden.ctx, "Hidden?", "send_probe", "probe-hidden");
		expect(hidden.pi.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
			customType: "om.contemplator.suggestion",
			display: false,
		}), { deliverAs: "steer" });
	});

	it("omits triggerTurn so Pi queues an active steer at the next model boundary", () => {
		const harness = setup();
		harness.fire("agent_start");

		(harness.contemplator as any).queueProbe(harness.ctx, "Active?", "send_probe", "probe-active");

		expect(harness.pi.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
			details: expect.objectContaining({ probeId: "probe-active" }),
		}), { deliverAs: "steer" });
		expect((harness.contemplator as any).queuedProbeIds.has("probe-active")).toBe(true);

		harness.fire("message_end", {
			message: { role: "custom", customType: "om.contemplator.suggestion", details: { probeId: "probe-active" } },
		});
		expect((harness.contemplator as any).queuedProbeIds.has("probe-active")).toBe(false);
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

	it("retries an unprocessed memory backlog immediately after reload", async () => {
		const harness = setup([
			textCustomMessage("raw-reload", "work that failed contemplation"),
			observationsRecordedEntry("obs-reload", {
				observations: [observation("aaaaaaaaaaaa", { sourceEntryIds: ["raw-reload"] })],
				coversUpToId: "raw-reload",
			}),
		]);
		(harness.ctx.model as any).reasoning = true;

		harness.fire("session_start", { reason: "reload" });

		await vi.waitFor(() => expect(agentMocks.agentLoop).toHaveBeenCalledTimes(1));
		expect(agentMocks.agentLoop.mock.calls[0][2].reasoning).toBe("medium");
	});

	it("does not replay memories covered by a persisted contemplator update", async () => {
		const coveredId = "aaaaaaaaaaaa";
		const harness = setup([
			textCustomMessage("raw-covered", "already contemplated work"),
			observationsRecordedEntry("obs-covered", {
				observations: [observation(coveredId, { sourceEntryIds: ["raw-covered"] })],
				coversUpToId: "raw-covered",
			}),
			{
				id: "contemplator-prompt", type: "custom", customType: "om.contemplator.message",
				data: { version: 1, message: { role: "user", content: [{ type: "text", text: `NEW MEMORY UPDATE\n\nOBSERVATIONS:\n[${coveredId}] already processed` }] } },
			} as TestEntry,
		]);

		harness.fire("session_start", { reason: "reload" });
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(agentMocks.agentLoop).not.toHaveBeenCalled();
		expect(harness.runtime.contemplatorState.pendingObservations).toBe(0);
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
		}), { deliverAs: "steer" });
	});

	it("does not mistake a persisted custom message for a live queue after tree navigation", () => {
		const harness = setup([
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
		] as TestEntry[]);

		harness.fire("session_tree");

		expect(harness.pi.sendMessage).toHaveBeenCalledTimes(1);
		expect(harness.pi.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
			details: expect.objectContaining({ probeId: "probe-1", source: "restore" }),
		}), { deliverAs: "steer" });
	});

	it("resets branch-local tracking and pending work on tree navigation", () => {
		const branchA = [textCustomMessage("raw-a", "branch a")];
		const branchB = [textCustomMessage("raw-b", "branch b")];
		const harness = setup(branchA);
		harness.fire("session_start");
		const state = harness.contemplator as any;
		state.pending = { observations: ["[aaaaaaaaaaaa] branch a"], summaries: [] };
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
		(harness.contemplator as any).queuedProbeIds.add("probe-1");
		(harness.contemplator as any).queuedProbeIds.add("probe-2");

		harness.fire("context", { messages });
		harness.fire("context", { messages });

		expect(harness.pi.appendEntry).toHaveBeenCalledTimes(2);
		expect(harness.pi.appendEntry).toHaveBeenCalledWith("om.contemplator.suggestion", expect.objectContaining({ probeId: "probe-1", delivered: true }));
		expect(harness.pi.appendEntry).toHaveBeenCalledWith("om.contemplator.suggestion", expect.objectContaining({ probeId: "probe-2", delivered: true }));
		expect((harness.contemplator as any).queuedProbeIds.has("probe-1")).toBe(false);
		expect((harness.contemplator as any).queuedProbeIds.has("probe-2")).toBe(false);
	});

	it("records active run time without counting idle user waits or parallel tools twice", () => {
		const now = vi.spyOn(Date, "now");
		let time = 1_000;
		now.mockImplementation(() => time);
		const harness = setup();
		harness.runtime.config = { ...harness.runtime.config, contemplatorEnabled: false };

		harness.fire("agent_start");
		harness.fire("tool_execution_start", { toolCallId: "one" });
		harness.fire("tool_execution_start", { toolCallId: "two" });
		time = 6_000;
		harness.fire("turn_end");
		time = 7_000;
		harness.fire("agent_end");

		// Ninety-three seconds waiting for user input is outside any agent run.
		time = 100_000;
		harness.fire("agent_start");
		time = 102_000;
		harness.fire("agent_end");
		now.mockRestore();

		const durations = harness.getEntries()
			.filter((entry) => entry.customType === "om.agent.activity")
			.map((entry) => (entry.data as { durationMs: number }).durationMs);
		expect(durations).toEqual([5_000, 1_000, 2_000]);
		expect(durations.reduce((sum, duration) => sum + duration, 0)).toBe(8_000);
	});

	it("checkpoints active time during assistant and tool progress without waiting for agent_end", () => {
		const now = vi.spyOn(Date, "now");
		let time = 1_000;
		now.mockImplementation(() => time);
		const harness = setup();
		harness.runtime.config = { ...harness.runtime.config, contemplatorEnabled: false };
		const checkpointTotals: number[] = [];
		harness.runtime.setAgentActivityListener(() => checkpointTotals.push(harness.getEntries()
			.filter((entry) => entry.customType === "om.agent.activity")
			.reduce((sum, entry) => sum + (entry.data as { durationMs: number }).durationMs, 0)));

		harness.fire("agent_start");
		time = 6_000;
		harness.fire("message_end", { message: { role: "assistant", content: [] } });
		time = 9_000;
		harness.fire("tool_execution_end", { toolCallId: "long-tool" });

		const beforeAgentEnd = harness.getEntries()
			.filter((entry) => entry.customType === "om.agent.activity")
			.map((entry) => (entry.data as { durationMs: number }).durationMs);
		expect(beforeAgentEnd).toEqual([5_000, 3_000]);
		expect(checkpointTotals).toEqual([5_000, 8_000]);

		time = 10_000;
		harness.fire("agent_end");
		now.mockRestore();
		expect(harness.getEntries()
			.filter((entry) => entry.customType === "om.agent.activity")
			.map((entry) => (entry.data as { durationMs: number }).durationMs))
			.toEqual([5_000, 3_000, 1_000]);
	});

	it("counts model responses within one long user turn toward contemplator spacing", async () => {
		const raw = textCustomMessage("raw-long-turn", "autonomous work");
		const memory = observationsRecordedEntry("obs-long-turn", {
			observations: [observation("aaaaaaaaaaaa", { sourceEntryIds: ["raw-long-turn"] })],
			coversUpToId: "raw-long-turn",
		});
		const harness = setup([]);
		harness.runtime.config = { ...harness.runtime.config, contemplatorMinTurns: 2 };
		harness.fire("session_start");
		harness.setEntries([raw, memory]);

		// No turn_end occurs: these are two tool-using model rounds in one agent run.
		harness.fire("message_end", { message: { role: "assistant", content: [{ type: "toolCall", name: "read" }] } });
		expect(agentMocks.agentLoop).not.toHaveBeenCalled();
		expect(harness.runtime.contemplatorState).toMatchObject({
			responsesSinceRun: 1,
			waitingFor: "responses",
			pendingObservations: 1,
		});

		harness.fire("message_end", { message: { role: "assistant", content: [{ type: "toolCall", name: "edit" }] } });
		await vi.waitFor(() => expect(agentMocks.agentLoop).toHaveBeenCalledTimes(1));
		expect(harness.runtime.contemplatorState.lastStartedAt).toEqual(expect.any(Number));
		await vi.waitFor(() => expect(harness.runtime.contemplatorState.running).toBe(false));
		expect(harness.runtime.contemplatorState.responsesSinceRun).toBe(0);
	});

	it("measures response spacing from contemplator completion rather than start", async () => {
		const gate = deferred();
		agentMocks.agentLoop
			.mockImplementationOnce((_prompts, context) => {
				selectNoIntervention(context);
				return stream(gate.promise);
			})
			.mockImplementation((_prompts, context) => {
				selectNoIntervention(context);
				return stream();
			});
		const rawA = textCustomMessage("raw-finish-a", "first work");
		const obsA = observationsRecordedEntry("obs-finish-a", {
			observations: [observation("aaaaaaaaaaaa", { sourceEntryIds: ["raw-finish-a"] })],
			coversUpToId: "raw-finish-a",
		});
		const harness = setup([]);
		harness.runtime.config = { ...harness.runtime.config, contemplatorMinTurns: 2 };
		harness.fire("session_start");
		harness.setEntries([rawA, obsA]);
		harness.fire("message_end", { message: { role: "assistant" } });
		harness.fire("message_end", { message: { role: "assistant" } });
		await vi.waitFor(() => expect(agentMocks.agentLoop).toHaveBeenCalledTimes(1));

		const rawB = textCustomMessage("raw-finish-b", "work arriving during contemplation");
		const obsB = observationsRecordedEntry("obs-finish-b", {
			observations: [observation("bbbbbbbbbbbb", { sourceEntryIds: ["raw-finish-b"] })],
			coversUpToId: "raw-finish-b",
		});
		harness.setEntries([...harness.getEntries(), rawB, obsB]);
		harness.runtime.notifyMemoryUpdate(harness.ctx as any);
		// These responses occur during the first contemplator run and must not
		// pre-pay the spacing requirement for its successor.
		for (let i = 0; i < 3; i++) harness.fire("message_end", { message: { role: "assistant" } });
		gate.resolve();
		await vi.waitFor(() => expect(harness.runtime.contemplatorState.running).toBe(false));

		expect(agentMocks.agentLoop).toHaveBeenCalledTimes(1);
		expect(harness.runtime.contemplatorState).toMatchObject({ responsesSinceRun: 0, waitingFor: "responses", pendingObservations: 1 });
		harness.fire("message_end", { message: { role: "assistant" } });
		expect(agentMocks.agentLoop).toHaveBeenCalledTimes(1);
		harness.fire("message_end", { message: { role: "assistant" } });
		await vi.waitFor(() => expect(agentMocks.agentLoop).toHaveBeenCalledTimes(2));
	});

	it("anchors probe spacing at provider-context delivery and waits safely while queued", async () => {
		agentMocks.agentLoop
			.mockImplementationOnce((_prompts, context) => {
				selectProbe(context);
				return stream();
			})
			.mockImplementation((_prompts, context) => {
				selectNoIntervention(context);
				return stream();
			});
		const rawA = textCustomMessage("raw-probe-a", "first work");
		const obsA = observationsRecordedEntry("obs-probe-a", {
			observations: [observation("aaaaaaaaaaaa", { sourceEntryIds: ["raw-probe-a"] })],
			coversUpToId: "raw-probe-a",
		});
		const harness = setup([]);
		harness.runtime.config = { ...harness.runtime.config, contemplatorMinTurns: 2 };
		harness.fire("session_start");
		harness.setEntries([rawA, obsA]);
		harness.fire("message_end", { message: { role: "assistant" } });
		harness.fire("message_end", { message: { role: "assistant" } });
		await vi.waitFor(() => expect(harness.pi.sendMessage).toHaveBeenCalledTimes(1));
		await vi.waitFor(() => expect(harness.runtime.contemplatorState.running).toBe(false));

		const rawB = textCustomMessage("raw-probe-b", "work after the probe was queued");
		const obsB = observationsRecordedEntry("obs-probe-b", {
			observations: [observation("bbbbbbbbbbbb", { sourceEntryIds: ["raw-probe-b"] })],
			coversUpToId: "raw-probe-b",
		});
		harness.setEntries([...harness.getEntries(), rawB, obsB]);
		harness.runtime.notifyMemoryUpdate(harness.ctx as any);
		for (let i = 0; i < 3; i++) harness.fire("message_end", { message: { role: "assistant" } });
		expect(agentMocks.agentLoop).toHaveBeenCalledTimes(1);
		expect(harness.runtime.contemplatorState.waitingFor).toBe("probe");

		const queued = harness.pi.sendMessage.mock.calls[0][0];
		const delivered = { role: "custom", ...queued };
		// Insertion into the conversation stream alone is not delivery to the model.
		harness.fire("message_end", { message: delivered });
		expect(harness.runtime.contemplatorState.waitingFor).toBe("probe");
		harness.fire("context", { messages: [delivered] });
		expect(harness.runtime.contemplatorState).toMatchObject({ responsesSinceRun: 0, waitingFor: "responses" });

		harness.fire("message_end", { message: { role: "assistant" } });
		expect(agentMocks.agentLoop).toHaveBeenCalledTimes(1);
		harness.fire("message_end", { message: { role: "assistant" } });
		await vi.waitFor(() => expect(agentMocks.agentLoop).toHaveBeenCalledTimes(2));
	});

	it("does not double-count turn_end after an assistant response", () => {
		const harness = setup();
		harness.runtime.config = { ...harness.runtime.config, contemplatorEnabled: false };
		harness.fire("session_start");
		harness.fire("message_end", { message: { role: "assistant", content: [] } });
		harness.fire("turn_end");

		expect((harness.contemplator as any).turnsSinceRun).toBe(1);
	});

	it("rechecks turn throttling before processing updates queued during a run", async () => {
		const gate = deferred();
		agentMocks.agentLoop
			.mockImplementationOnce((_prompts, context) => {
				selectNoIntervention(context);
				return stream(gate.promise);
			})
			.mockImplementation((_prompts, context) => {
				selectNoIntervention(context);
				return stream();
			});
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

	it("checkpoints the live interval when contemplation runs mid-turn", async () => {
		const now = vi.spyOn(Date, "now");
		let time = 1_000;
		now.mockImplementation(() => time);
		const raw = textCustomMessage("raw-live", "long-running work");
		const memory = observationsRecordedEntry("obs-live", {
			observations: [observation("aaaaaaaaaaaa", { sourceEntryIds: ["raw-live"] })],
			coversUpToId: "raw-live",
		});
		const completedActivity = { id: "activity-complete", type: "custom", customType: "om.agent.activity", data: { version: 1, durationMs: 600_000 } } as TestEntry;
		const harness = setup([raw, memory, completedActivity]);
		harness.runtime.config = { ...harness.runtime.config, contemplatorMinTurns: 0 };

		harness.fire("agent_start");
		time = 1_201_000; // 20 live minutes, with no turn_end checkpoint.
		harness.runtime.notifyMemoryUpdate(harness.ctx as any);
		await vi.waitFor(() => expect(agentMocks.agentLoop).toHaveBeenCalledTimes(1));
		now.mockRestore();

		const prompt = agentMocks.agentLoop.mock.calls[0][0][0];
		expect(prompt.content[0].text).toContain("CUMULATIVE ACTIVITY: 0 generated tokens; 0 tool calls; about 30 minutes active.");
		const activities = harness.getEntries().filter((entry) => entry.customType === "om.agent.activity");
		expect(activities).toHaveLength(2);
		expect((activities[1].data as { durationMs: number }).durationMs).toBe(1_200_000);
	});

	it("does not double-count live activity after a turn checkpoint", async () => {
		const now = vi.spyOn(Date, "now");
		let time = 1_000;
		now.mockImplementation(() => time);
		const raw = textCustomMessage("raw-checkpoint", "work");
		const memory = observationsRecordedEntry("obs-checkpoint", {
			observations: [observation("aaaaaaaaaaaa", { sourceEntryIds: ["raw-checkpoint"] })],
			coversUpToId: "raw-checkpoint",
		});
		const harness = setup([raw, memory]);
		harness.runtime.config = { ...harness.runtime.config, contemplatorMinTurns: 2 };

		harness.fire("agent_start");
		time = 601_000;
		harness.fire("turn_end"); // Persists 10 minutes; contemplation still waits.
		time = 901_000;
		harness.runtime.notifyMemoryUpdate(harness.ctx as any); // Adds only 5 live minutes.
		time = 1_201_000;
		harness.fire("turn_end");
		await vi.waitFor(() => expect(agentMocks.agentLoop).toHaveBeenCalledTimes(1));
		now.mockRestore();

		const prompt = agentMocks.agentLoop.mock.calls[0][0][0];
		expect(prompt.content[0].text).toContain("about 20 minutes active");
	});

	it("refreshes cumulative activity while a pending update waits for its turn threshold", async () => {
		const raw = textCustomMessage("raw-a", "branch a");
		const memory = observationsRecordedEntry("obs-a", {
			observations: [observation("aaaaaaaaaaaa", { sourceEntryIds: ["raw-a"] })],
			coversUpToId: "raw-a",
		});
		const firstActivity = { id: "activity-1", type: "custom", customType: "om.agent.activity", data: { version: 1, durationMs: 1_000 } } as TestEntry;
		const harness = setup([raw, memory, firstActivity]);
		harness.runtime.config = { ...harness.runtime.config, contemplatorMinTurns: 2 };

		harness.fire("turn_end");
		expect(agentMocks.agentLoop).not.toHaveBeenCalled();

		const laterActivity = { id: "activity-2", type: "custom", customType: "om.agent.activity", data: { version: 1, durationMs: 4_000 } } as TestEntry;
		harness.setEntries([...harness.getEntries(), laterActivity]);
		harness.fire("turn_end");
		await vi.waitFor(() => expect(agentMocks.agentLoop).toHaveBeenCalledTimes(1));

		const prompt = agentMocks.agentLoop.mock.calls[0][0][0];
		expect(prompt.content[0].text).toContain("CUMULATIVE ACTIVITY: 0 generated tokens; 0 tool calls; less than 5 minutes active.");
	});

	it("includes cumulative primary-agent tokens, tool calls, and active time on the current branch", async () => {
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
		const activity = {
			id: "agent-activity",
			type: "custom",
			customType: "om.agent.activity",
			data: { version: 1, durationMs: 754_000 },
		} as TestEntry;
		const harness = setup([earlierAssistant, latestAssistant, memory, activity]);

		harness.fire("turn_end");
		await vi.waitFor(() => expect(agentMocks.agentLoop).toHaveBeenCalledTimes(1));

		const prompt = agentMocks.agentLoop.mock.calls[0][0][0];
		expect(prompt.content[0].text).toContain("CUMULATIVE ACTIVITY: 200 generated tokens; 3 tool calls; about 10 minutes active.");
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

	it("records a terminal result for an exhausted pending review", async () => {
		const reviewRequest = {
			id: "review-exhausted", scope: "software", evidence: "[aaaaaaaaaaaa] recurring work",
			concern: "A structural issue may exist.", reviewFocus: "Decide whether a proposal is warranted.",
			createdAt: 1, requestedBy: "contemplator",
		};
		const exhaustedAssistant = { role: "assistant", content: [{ type: "text", text: "No budget remains." }], timestamp: 1, usage: { output: REVIEWER_TOTAL_TOKEN_LIMIT } };
		const harness = setup([
			{ id: "review-request", type: "custom", customType: "om.review.request", data: { version: 1, request: reviewRequest } },
			{ id: "review-message", type: "custom", customType: "om.reviewer.message", data: { version: 1, reviewRequestId: reviewRequest.id, scope: "software", message: exhaustedAssistant } },
		] as TestEntry[]);

		harness.fire("session_start");
		await vi.waitFor(() => expect(harness.pi.appendEntry).toHaveBeenCalledWith("om.review.result", {
			result: expect.objectContaining({
				reviewRequestId: "review-exhausted",
				outcome: "no_proposal",
				reason: expect.stringContaining("lifetime output-token budget"),
			}),
		}));
		expect(agentMocks.agentLoop).not.toHaveBeenCalled();

		const resultCount = harness.pi.appendEntry.mock.calls.filter(([type]) => type === "om.review.result").length;
		harness.fire("session_tree");
		expect(harness.pi.appendEntry.mock.calls.filter(([type]) => type === "om.review.result")).toHaveLength(resultCount);
		expect(agentMocks.agentLoop).not.toHaveBeenCalled();
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

	it("injects a user reminder when the contemplator stops without a final-action tool", async () => {
		agentMocks.agentLoop
			.mockImplementationOnce(() => stream(Promise.resolve(), [
				{ role: "assistant", content: [{ type: "text", text: "I will just stop." }], stopReason: "stop", timestamp: Date.now() },
			]))
			.mockImplementationOnce((_prompts, context) => {
				selectNoIntervention(context);
				return stream();
			});
		const harness = setup([
			textCustomMessage("raw-a", "branch a"),
			observationsRecordedEntry("obs-a", {
				observations: [observation("aaaaaaaaaaaa", { sourceEntryIds: ["raw-a"] })],
				coversUpToId: "raw-a",
			}),
		]);

		harness.fire("turn_end");
		await vi.waitFor(() => expect(agentMocks.agentLoop).toHaveBeenCalledTimes(2));

		const continuation = agentMocks.agentLoop.mock.calls[1][0][0];
		const retryConfig = agentMocks.agentLoop.mock.calls[1][2];
		expect(continuation.role).toBe("user");
		expect(retryConfig.toolChoice).toBe("required");
		expect(retryConfig.onPayload({})).toMatchObject({ tool_choice: "required" });
		expect(continuation.content[0].text).toContain("You stopped without selecting a final action");
		expect(continuation.content[0].text).toContain("argument-free no_intervention tool now");
		expect(continuation.content[0].text).toContain("preferred default");
		expect(continuation.content[0].text).toContain("Do not invent or send a probe merely to satisfy the tool requirement");
		expect(continuation.content[0].text).toContain("send_probe, request_review, or no_intervention");
		expect(harness.pi.sendMessage).not.toHaveBeenCalled();
		await vi.waitFor(() => expect(harness.pi.appendEntry).toHaveBeenCalledWith("om.contemplator.message", expect.objectContaining({
			message: expect.objectContaining({ role: "user", content: expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining("without selecting a final action") })]) }),
		})));
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
		expect(context.tools.map((tool: { name: string }) => tool.name)).toEqual(["search_memories", "recall", "send_probe", "no_intervention"]);
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
		agentMocks.agentLoop.mockImplementation((_prompts, context) => {
			selectNoIntervention(context);
			return {
				async *[Symbol.asyncIterator]() {},
				result: async () => [
					{ role: "assistant", content: [{ type: "text", text: "ok" }], usage, stopReason: "stop", timestamp: Date.now() },
				],
			};
		});
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

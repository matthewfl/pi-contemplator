import { beforeEach, describe, expect, it, vi } from "vitest";

const mockAgents = vi.hoisted(() => ({ runObserver: vi.fn() }));

vi.mock("../src/agents/observer/agent.js", () => ({ runObserver: mockAgents.runObserver }));

import { registerConsolidationTrigger } from "../src/hooks/consolidation-trigger.js";
import { OM_OBSERVATIONS_RECORDED } from "../src/session-ledger/index.js";
import {
	observation,
	observationsRecordedEntry,
	textCustomMessage,
	type TestEntry,
} from "./fixtures/session.js";

beforeEach(() => {
	mockAgents.runObserver.mockReset();
	mockAgents.runObserver.mockResolvedValue(undefined);
});

function setup(args: {
	entries: TestEntry[];
	observeAfterTokens?: number;
	observerChunkMaxTokens?: number;
	observationsPoolMaxTokens?: number;
	observationsPoolTargetTokens?: number;
	showWorkerNotifications?: boolean;
	passive?: boolean;
	consolidationInFlight?: boolean;
	appendEntryReturnsId?: boolean;
}) {
	let entries = [...args.entries];
	const handlers: Record<string, ((event: unknown, ctx: any) => void) | undefined> = {};
	const pi = {
		on: vi.fn((eventName: string, cb: (event: unknown, ctx: any) => void) => {
			handlers[eventName] = cb;
		}),
		appendEntry: vi.fn((customType: string, data: unknown) => {
			const id = `appended-${pi.appendEntry.mock.calls.length}`;
			entries = [...entries, { type: "custom", id, parentId: entries.at(-1)?.id ?? null, timestamp: "2026-05-02T10:00:00.000Z", customType, data }];
			return args.appendEntryReturnsId === false ? undefined : id;
		}),
	};
	let launchedWork: (() => Promise<void>) | undefined;
	let contextGeneration = 0;
	const runtime = {
		config: {
			showWorkerNotifications: args.showWorkerNotifications ?? true,
			// Scheduling itself is covered separately. Keep it disabled here so
			// these tests can inspect the observer-to-librarian handoff directly.
			librarianEnabled: false,
			passive: args.passive ?? false,
			debugLog: false,
			observeAfterTokens: args.observeAfterTokens ?? 1,
			observerChunkMaxTokens: args.observerChunkMaxTokens,
			observationsPoolMaxTokens: args.observationsPoolMaxTokens ?? 100,
			observationsPoolTargetTokens: args.observationsPoolTargetTokens ?? Math.floor((args.observationsPoolMaxTokens ?? 100) / 2),
			agentMaxTurns: 9,
			model: { provider: "anthropic", id: "memory", thinking: "minimal" },
		},
		consolidationInFlight: args.consolidationInFlight ?? false,
		consolidationPhase: undefined as "observer" | undefined,
		resolveFailureNotified: false,
		lastObserverError: undefined as string | undefined,
		markLibrarianDirty: vi.fn(),
		ensureConfig: vi.fn(),
		getContextGeneration: vi.fn(() => contextGeneration),
		advanceContextGeneration: vi.fn(() => {
			contextGeneration++;
		}),
		resolveModel: vi.fn(async (): Promise<any> => ({ ok: true, model: { reasoning: true }, apiKey: "key", headers: { h: "v" } })),
		launchConsolidationTask: vi.fn((_ctx, work) => {
			runtime.consolidationInFlight = true;
			launchedWork = work;
			return Promise.resolve();
		}),
		recordConsolidationStageError: vi.fn((ctx, phase: "observer", error: unknown) => {
			const message = error instanceof Error ? error.message : String(error);
			runtime.lastObserverError = message;
			ctx.ui?.notify(`Observational memory: ${phase} failed: ${message}`, "warning");
			return message;
		}),
	};
	registerConsolidationTrigger(pi as any, runtime as any);
	if (!handlers.agent_start) throw new Error("agent_start consolidation handler not registered");
	if (!handlers.turn_end) throw new Error("turn_end consolidation handler not registered");
	const ctx = {
		cwd: "/tmp/project",
		hasUI: true,
		ui: { notify: vi.fn() },
		model: { provider: "session" },
		modelRegistry: {},
		sessionManager: { getBranch: () => entries },
	};
	return {
		pi,
		runtime,
		ctx,
		fire: (eventName = "turn_end") => handlers[eventName]!(undefined, ctx),
		fireAgentStart: () => handlers.agent_start!(undefined, ctx),
		fireTurnEnd: () => handlers.turn_end!(undefined, ctx),
		runLaunchedWork: async () => launchedWork?.(),
		getEntries: () => entries,
		setEntries: (next: TestEntry[]) => {
			entries = [...next];
		},
	};
}

describe("V3 consolidation trigger", () => {
	const obsA = observation("aaaaaaaaaaaa", { sourceEntryIds: ["raw-1"], tokenCount: 10 });

	it("registers agent_start and turn_end consolidation entrypoints", () => {
		const entries = [textCustomMessage("raw-1", "aaaaaaaa")];
		const { pi } = setup({ entries });

		expect(pi.on).toHaveBeenCalledWith("agent_start", expect.any(Function));
		expect(pi.on).toHaveBeenCalledWith("turn_end", expect.any(Function));
	});

	it("does not launch below all thresholds from either entrypoint", () => {
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			observationsRecordedEntry("om-obs", { observations: [obsA], coversUpToId: "raw-1" }),
		];
		const { fireAgentStart, fireTurnEnd, runtime } = setup({ entries, observeAfterTokens: 10 });

		fireAgentStart();
		fireTurnEnd();

		expect(runtime.launchConsolidationTask).not.toHaveBeenCalled();
	});

	it("does not launch from either entrypoint in passive mode", () => {
		const entries = [textCustomMessage("raw-1", "aaaaaaaa")];
		const passive = setup({ entries, passive: true });

		passive.fireAgentStart();
		passive.fireTurnEnd();

		expect(passive.runtime.launchConsolidationTask).not.toHaveBeenCalled();
	});

	it("does not launch from either entrypoint while consolidation is already in flight", () => {
		const entries = [textCustomMessage("raw-1", "aaaaaaaa")];
		const locked = setup({ entries, consolidationInFlight: true });

		locked.fireAgentStart();
		locked.fireTurnEnd();

		expect(locked.runtime.launchConsolidationTask).not.toHaveBeenCalled();
	});

	it("launches from agent_start when work is due", () => {
		const entries = [textCustomMessage("raw-1", "aaaaaaaa")];
		const { fireAgentStart, runtime } = setup({ entries });

		fireAgentStart();

		expect(runtime.launchConsolidationTask).toHaveBeenCalledTimes(1);
	});

	it("uses the shared lock when agent_start fires before turn_end", () => {
		const entries = [textCustomMessage("raw-1", "aaaaaaaa")];
		const { fireAgentStart, fireTurnEnd, runtime } = setup({ entries });

		fireAgentStart();
		fireTurnEnd();

		expect(runtime.launchConsolidationTask).toHaveBeenCalledTimes(1);
	});

	it("uses the shared lock when turn_end fires before agent_start", () => {
		const entries = [textCustomMessage("raw-1", "aaaaaaaa")];
		const { fireAgentStart, fireTurnEnd, runtime } = setup({ entries });

		fireTurnEnd();
		fireAgentStart();

		expect(runtime.launchConsolidationTask).toHaveBeenCalledTimes(1);
	});

	it("runs observer first and appends source-addressed observations", async () => {
		const obs = observation("cccccccccccc", { sourceEntryIds: ["raw-1"], tokenCount: 4 });
		mockAgents.runObserver.mockResolvedValueOnce([obs]);
		const entries = [textCustomMessage("raw-1", "aaaaaaaa")];
		const { fire, runLaunchedWork, pi, runtime } = setup({ entries });

		fire();
		await runLaunchedWork();

		expect(runtime.launchConsolidationTask).toHaveBeenCalled();
		expect(mockAgents.runObserver).toHaveBeenCalledWith(expect.objectContaining({
			allowedSourceEntryIds: ["raw-1"],
			maxTurns: 9,
			thinkingLevel: "minimal",
		}));
		expect(pi.appendEntry).toHaveBeenCalledWith(OM_OBSERVATIONS_RECORDED, { observations: [obs], coversUpToId: "raw-1" });
		expect(runtime.markLibrarianDirty).toHaveBeenCalledWith(1, 4);
	});

	it("uses existing observation coverage and retries larger ranges after no-output", async () => {
		const prior = observation("cccccccccccc", { sourceEntryIds: ["raw-1"] });
		const newObs = observation("dddddddddddd", { sourceEntryIds: ["raw-2"] });
		mockAgents.runObserver.mockResolvedValueOnce([newObs]);
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			observationsRecordedEntry("om-prior", { observations: [prior], coversUpToId: "raw-1" }),
			textCustomMessage("raw-2", "bbbbbbbb"),
			textCustomMessage("raw-3", "cccccccc"),
		];
		const { fire, runLaunchedWork, pi } = setup({ entries });

		fire();
		await runLaunchedWork();

		expect(mockAgents.runObserver).toHaveBeenCalledWith(expect.objectContaining({ allowedSourceEntryIds: ["raw-2", "raw-3"] }));
		expect(pi.appendEntry).toHaveBeenCalledWith(OM_OBSERVATIONS_RECORDED, { observations: [newObs], coversUpToId: "raw-3" });
	});

	it("model resolution failure skips appending and notifies once", async () => {
		const entries = [textCustomMessage("raw-1", "aaaaaaaa")];
		const { fire, runLaunchedWork, pi, runtime, ctx } = setup({ entries });
		runtime.resolveModel.mockResolvedValueOnce({ ok: false, reason: "no model" });

		fire();
		await runLaunchedWork();

		expect(pi.appendEntry).not.toHaveBeenCalled();
		expect(ctx.ui.notify).toHaveBeenCalledWith("Observational memory: observer skipped — no model", "warning");
	});

	it("discards observer output when the session branch changes while it is running", async () => {
		let finishObserver: ((value: ReturnType<typeof observation>[]) => void) | undefined;
		mockAgents.runObserver.mockImplementationOnce(() => new Promise((resolve) => {
			finishObserver = resolve;
		}));
		const branchA = [textCustomMessage("raw-a", "branch a context")];
		const branchB = [textCustomMessage("raw-b", "branch b context")];
		const harness = setup({ entries: branchA });

		harness.fire();
		const work = harness.runLaunchedWork();
		await vi.waitFor(() => expect(mockAgents.runObserver).toHaveBeenCalled());
		harness.setEntries(branchB);
		harness.runtime.advanceContextGeneration();
		finishObserver?.([observation("aaaaaaaaaaaa", { sourceEntryIds: ["raw-a"] })]);
		await work;

		expect(harness.pi.appendEntry).not.toHaveBeenCalled();
		expect(harness.getEntries()).toEqual(branchB);
	});

});

describe("observer chunk cap", () => {
	it("caps an oversized backlog and drains it incrementally across runs", async () => {
		const first = observation("111111111111", { sourceEntryIds: ["raw-1"], tokenCount: 4 });
		const second = observation("222222222222", { sourceEntryIds: ["raw-2"], tokenCount: 4 });
		mockAgents.runObserver.mockResolvedValueOnce([first]).mockResolvedValueOnce([second]);
		const entries = [
			textCustomMessage("raw-1", "a".repeat(800)),
			textCustomMessage("raw-2", "b".repeat(800)),
			textCustomMessage("raw-3", "c".repeat(800)),
		];
		const { fire, runLaunchedWork, pi, runtime } = setup({ entries, observerChunkMaxTokens: 256 });

		fire();
		await runLaunchedWork();

		// Only the oldest entry fits under the cap; coverage advances to it, not to the backlog tail.
		expect(mockAgents.runObserver).toHaveBeenNthCalledWith(1, expect.objectContaining({ allowedSourceEntryIds: ["raw-1"] }));
		expect(pi.appendEntry).toHaveBeenNthCalledWith(1, OM_OBSERVATIONS_RECORDED, { observations: [first], coversUpToId: "raw-1" });

		// The next run continues from the advanced coverage.
		runtime.consolidationInFlight = false;
		fire();
		await runLaunchedWork();

		expect(mockAgents.runObserver).toHaveBeenNthCalledWith(2, expect.objectContaining({ allowedSourceEntryIds: ["raw-2"] }));
		expect(pi.appendEntry).toHaveBeenNthCalledWith(2, OM_OBSERVATIONS_RECORDED, { observations: [second], coversUpToId: "raw-2" });
	});

	it("bounds one oversized tool result, preserves provenance, and continues on the next run", async () => {
		const first = observation("333333333333", { sourceEntryIds: ["raw-huge"], tokenCount: 4 });
		const second = observation("555555555555", { sourceEntryIds: ["raw-next"], tokenCount: 4 });
		mockAgents.runObserver.mockResolvedValueOnce([first]).mockResolvedValueOnce([second]);
		const hugeText = `HEAD:${"m".repeat(2_000)}:TAIL`;
		const entries: TestEntry[] = [
			{
				type: "message",
				id: "raw-huge",
				parentId: null,
				timestamp: "2026-05-02T10:00:00.000Z",
				message: {
					role: "toolResult",
					toolCallId: "tool-1",
					toolName: "bash",
					content: [{ type: "text", text: hugeText }],
					isError: false,
					timestamp: Date.parse("2026-05-02T10:00:00.000Z"),
				},
			},
			textCustomMessage("raw-next", "later"),
		];
		const { fire, runLaunchedWork, pi, runtime } = setup({ entries, observerChunkMaxTokens: 100 });

		fire();
		await runLaunchedWork();

		const firstCall = mockAgents.runObserver.mock.calls[0][0];
		expect(firstCall.allowedSourceEntryIds).toEqual(["raw-huge"]);
		expect(firstCall.chunk).toContain("HEAD:");
		expect(firstCall.chunk).toContain(":TAIL");
		expect(firstCall.chunk).toContain("middle omitted: source exceeds observer input budget");
		expect(firstCall.chunk).not.toContain("raw-next");
		expect(pi.appendEntry).toHaveBeenNthCalledWith(1, OM_OBSERVATIONS_RECORDED, { observations: [first], coversUpToId: "raw-huge" });

		// The source id still points at the full ledger entry; the next run starts
		// after it instead of retrying the oversized input forever.
		runtime.consolidationInFlight = false;
		fire();
		await runLaunchedWork();

		expect(mockAgents.runObserver).toHaveBeenNthCalledWith(2, expect.objectContaining({ allowedSourceEntryIds: ["raw-next"] }));
		expect(pi.appendEntry).toHaveBeenNthCalledWith(2, OM_OBSERVATIONS_RECORDED, { observations: [second], coversUpToId: "raw-next" });
	});

	it("derives the cap from the resolved model's context window when not configured", async () => {
		const obs = observation("444444444444", { sourceEntryIds: ["raw-1"], tokenCount: 4 });
		mockAgents.runObserver.mockResolvedValueOnce([obs]);
		const entries = [
			textCustomMessage("raw-1", "a".repeat(800)),
			textCustomMessage("raw-2", "b".repeat(800)),
		];
		const { fire, runLaunchedWork, pi, runtime } = setup({ entries });
		// contextWindow 1,280 -> cap = floor(1,280 * 0.2) = 256, so only raw-1 fits.
		runtime.resolveModel.mockResolvedValue({ ok: true, model: { reasoning: true, contextWindow: 1_280 }, apiKey: "key", headers: { h: "v" } } as any);

		fire();
		await runLaunchedWork();

		expect(mockAgents.runObserver).toHaveBeenCalledWith(expect.objectContaining({ allowedSourceEntryIds: ["raw-1"] }));
		expect(pi.appendEntry).toHaveBeenCalledWith(OM_OBSERVATIONS_RECORDED, expect.objectContaining({ coversUpToId: "raw-1" }));
	});
});

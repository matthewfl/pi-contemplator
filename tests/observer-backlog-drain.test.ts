import { beforeEach, describe, expect, it, vi } from "vitest";

const observerMocks = vi.hoisted(() => ({ runObserver: vi.fn() }));
vi.mock("../src/agents/observer/agent.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/agents/observer/agent.js")>()),
	runObserver: observerMocks.runObserver,
}));

import { DEFAULTS } from "../src/config.js";
import { Runtime } from "../src/runtime.js";
import { registerConsolidationTrigger, runConsolidationPipeline } from "../src/hooks/consolidation-trigger.js";
import { OM_OBSERVATIONS_RECORDED, rawTokensSinceObservationCoverage, type Entry } from "../src/session-ledger/index.js";
import { textCustomMessage } from "./fixtures/session.js";

function setup() {
	let entries = [
		textCustomMessage("raw-1", "a".repeat(4_000)),
		textCustomMessage("raw-2", "b".repeat(4_000)),
		textCustomMessage("raw-3", "c".repeat(4_000)),
	] as Entry[];
	let appended = 0;
	const pi = {
		appendEntry: vi.fn((customType: string, data: unknown) => {
			entries = [...entries, {
				type: "custom",
				customType,
				data,
				id: `coverage-${++appended}`,
				parentId: entries.at(-1)?.id ?? null,
				timestamp: new Date().toISOString(),
			} as Entry];
		}),
	};
	const runtime = {
		config: { ...DEFAULTS, observeAfterTokens: 1, observerChunkMaxTokens: 70, showWorkerNotifications: false, summarizerEnabled: false },
		consolidationPhase: undefined,
		lastObserverStartedAt: undefined,
		lastObserverCompletedAt: undefined,
		resolveFailureNotified: false,
		resolveModel: vi.fn(async () => ({ ok: true, model: { api: "openai-completions", contextWindow: 256_000, maxTokens: 32_000 }, apiKey: "test" })),
		getContextGeneration: vi.fn(() => 1),
		recordAgentUsage: vi.fn(),
		recordConsolidationStageError: vi.fn((_ctx, _stage, error) => error instanceof Error ? error.message : String(error)),
		notifyMemoryUpdate: vi.fn(),
	};
	const ctx = {
		cwd: "/tmp/project",
		hasUI: true,
		ui: { notify: vi.fn() },
		model: {},
		modelRegistry: {},
		sessionManager: { getBranch: () => entries, getSessionId: () => "observer-drain-test" },
	};
	return { pi, runtime, ctx, getEntries: () => entries, setEntries: (next: Entry[]) => { entries = next; } };
}

describe("observer backlog draining", () => {
	beforeEach(() => observerMocks.runObserver.mockReset());

	it("launches observer catch-up from long-turn activity checkpoints", async () => {
		const runtime = new Runtime();
		runtime.configLoaded = true;
		runtime.config = { ...runtime.config, observeAfterTokens: 1, passive: false };
		const entries = [textCustomMessage("raw-live", "new source during a long turn")] as Entry[];
		const pi = { on: vi.fn(), appendEntry: vi.fn() };
		const ctx = {
			cwd: "/tmp/project", hasUI: false, model: undefined,
			modelRegistry: {},
			sessionManager: { getBranch: () => entries, getSessionId: () => "live" },
		};
		registerConsolidationTrigger(pi as any, runtime);

		runtime.notifyAgentActivity(ctx as any);
		expect(runtime.consolidationInFlight).toBe(true);
		await runtime.consolidationPromise;

		// Model resolution failed before an observer chunk actually started.
		expect(runtime.lastObserverStartedAt).toBeUndefined();
		expect(runtime.lastObserverRun).toBeUndefined();
		expect(runtime.consolidationInFlight).toBe(false);
		expect(runtime.lastObserverError).toContain("no model available");
	});

	it("gives contemplation a checkpoint before automatically draining concurrently produced source", async () => {
		let entries = [
			textCustomMessage("raw-1", "a".repeat(4_000)),
			textCustomMessage("raw-2", "b".repeat(4_000)),
			textCustomMessage("raw-3", "c".repeat(4_000)),
		] as Entry[];
		let appended = 0;
		const pi = {
			on: vi.fn(),
			appendEntry: vi.fn((customType: string, data: unknown) => {
				entries = [...entries, {
					type: "custom", customType, data, id: `coverage-live-${++appended}`,
					parentId: entries.at(-1)?.id ?? null, timestamp: new Date().toISOString(),
				} as Entry];
			}),
		};
		const runtime = new Runtime();
		runtime.configLoaded = true;
		runtime.config = {
			...runtime.config,
			observeAfterTokens: 1,
			observerChunkMaxTokens: 70,
			passive: false,
			summarizerEnabled: false,
			showWorkerNotifications: false,
		};
		vi.spyOn(runtime, "resolveModel").mockResolvedValue({
			ok: true,
			model: { api: "openai-completions", contextWindow: 256_000, maxTokens: 32_000 } as any,
			apiKey: "test",
		});
		const ctx = {
			cwd: "/tmp/project", hasUI: false, model: {}, modelRegistry: {},
			sessionManager: { getBranch: () => entries, getSessionId: () => "live-producer" },
		};
		const checkpoints: Array<{ backlog: number; blocking: boolean; inFlight: boolean }> = [];
		runtime.setMemoryUpdateListener(() => checkpoints.push({
			backlog: rawTokensSinceObservationCoverage(entries),
			blocking: runtime.observerBacklogBlocking,
			inFlight: runtime.consolidationInFlight,
		}));
		registerConsolidationTrigger(pi as any, runtime);

		let concurrentAdded = false;
		observerMocks.runObserver.mockImplementation(async () => {
			if (!concurrentAdded) {
				concurrentAdded = true;
				entries = [...entries, textCustomMessage("raw-concurrent", "z".repeat(8_000)) as Entry];
			}
			return undefined;
		});

		runtime.notifyAgentActivity(ctx as any);
		await vi.waitFor(() => {
			expect(observerMocks.runObserver).toHaveBeenCalledTimes(4);
			expect(runtime.consolidationInFlight).toBe(false);
		});

		expect(checkpoints).toHaveLength(2);
		// The first finite snapshot releases the contemplator while source produced
		// during it is still uncovered. Only afterward is that source observed.
		expect(checkpoints[0]).toMatchObject({ blocking: false, inFlight: true });
		expect(checkpoints[0].backlog).toBeGreaterThan(runtime.config.observeAfterTokens);
		expect(checkpoints[1]).toEqual({ backlog: 0, blocking: false, inFlight: true });
	});

	it("walks oldest-first through bounded clean-empty chunks until the backlog is clear", async () => {
		const { pi, runtime, ctx, getEntries } = setup();
		const starts: Array<{ sourceEntryIds: readonly string[]; completedAt?: number }> = [];
		observerMocks.runObserver.mockImplementation(async (args) => {
			if (!args) return undefined;
			starts.push({
				sourceEntryIds: runtime.lastObserverRun.sourceEntryIds,
				completedAt: runtime.lastObserverRun.completedAt,
			});
			args.onMessages?.([{ role: "assistant", content: [{ type: "thinking", thinking: `inspecting ${args.allowedSourceEntryIds[0]}` }] }]);
			return undefined;
		});

		await runConsolidationPipeline(pi as any, runtime as any, ctx as any);

		expect(observerMocks.runObserver).toHaveBeenCalledTimes(3);
		expect(observerMocks.runObserver.mock.calls.map((call) => call[0].allowedSourceEntryIds)).toEqual([
			["raw-1"],
			["raw-2"],
			["raw-3"],
		]);
		expect(starts).toEqual([
			{ sourceEntryIds: ["raw-1"], completedAt: undefined },
			{ sourceEntryIds: ["raw-2"], completedAt: undefined },
			{ sourceEntryIds: ["raw-3"], completedAt: undefined },
		]);
		expect(runtime.lastObserverRun).toMatchObject({
			status: "completed",
			sourceEntryIds: ["raw-3"],
			summary: expect.stringContaining("chunk covered through raw-3"),
		});
		expect(runtime.lastObserverRun.messages[0].content[0].thinking).toContain("raw-3");
		expect(runtime.lastObserverStartedAt).toBe(runtime.lastObserverRun.startedAt);
		expect(runtime.lastObserverCompletedAt).toBe(runtime.lastObserverRun.completedAt);
		const coverage = getEntries().filter((entry) => entry.type === "custom" && entry.customType === OM_OBSERVATIONS_RECORDED);
		expect(coverage).toHaveLength(3);
		expect(coverage.map((entry: any) => entry.data)).toEqual([
			{ observations: [], coversUpToId: "raw-1" },
			{ observations: [], coversUpToId: "raw-2" },
			{ observations: [], coversUpToId: "raw-3" },
		]);
		expect(rawTokensSinceObservationCoverage(getEntries())).toBe(0);
		expect(pi.appendEntry).toHaveBeenCalledTimes(3);
		expect(runtime.notifyMemoryUpdate).toHaveBeenCalledTimes(1);
	});

	it("defers source appended during catch-up to a later finite backlog snapshot", async () => {
		const { pi, runtime, ctx, getEntries, setEntries } = setup();
		let appendedConcurrentSource = false;
		observerMocks.runObserver.mockImplementation(async () => {
			if (!appendedConcurrentSource) {
				appendedConcurrentSource = true;
				const current = getEntries();
				setEntries([...current, textCustomMessage("raw-concurrent", "z".repeat(8_000)) as Entry]);
			}
			return undefined;
		});

		await runConsolidationPipeline(pi as any, runtime as any, ctx as any);

		expect(observerMocks.runObserver).toHaveBeenCalledTimes(3);
		expect(observerMocks.runObserver.mock.calls.flatMap((call) => call[0]?.allowedSourceEntryIds ?? [])).toEqual([
			"raw-1", "raw-2", "raw-3",
		]);
		expect(rawTokensSinceObservationCoverage(getEntries())).toBeGreaterThan(runtime.config.observeAfterTokens);
		expect(runtime.observerBacklogBlocking).toBe(false);
		expect(runtime.notifyMemoryUpdate).toHaveBeenCalledTimes(1);
	});

	it("does not advance or spin when no observer model is available", async () => {
		const { pi, runtime, ctx, getEntries } = setup();
		runtime.resolveModel.mockResolvedValue({ ok: false, reason: "no model" });
		const before = rawTokensSinceObservationCoverage(getEntries());

		await runConsolidationPipeline(pi as any, runtime as any, ctx as any);

		expect(observerMocks.runObserver).not.toHaveBeenCalled();
		expect(runtime.resolveModel).toHaveBeenCalledTimes(1);
		expect(pi.appendEntry).not.toHaveBeenCalled();
		expect(rawTokensSinceObservationCoverage(getEntries())).toBe(before);
	});
});

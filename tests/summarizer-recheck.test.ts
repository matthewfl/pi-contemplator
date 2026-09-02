import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ runSummarizer: vi.fn(), runObserver: vi.fn() }));
vi.mock("../src/agents/summarizer/agent.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/agents/summarizer/agent.js")>()),
	runSummarizer: mocks.runSummarizer,
}));
vi.mock("../src/agents/observer/agent.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/agents/observer/agent.js")>()),
	runObserver: mocks.runObserver,
}));

import { DEFAULTS } from "../src/config.js";
import { runConsolidationPipeline, scheduleSummarizer } from "../src/hooks/consolidation-trigger.js";
import { Runtime } from "../src/runtime.js";
import type { Entry } from "../src/session-ledger/index.js";
import { textCustomMessage } from "./fixtures/session.js";

function observation(id: string, tokenCount: number) {
	return { id, content: `memory ${id}`, timestamp: "2026-01-01 00:00", relevance: "low", retention: "contextual", sourceEntryIds: ["raw"], tokenCount };
}

function memoryEntry(tokenCounts: number[]): Entry {
	return {
		type: "custom", id: "obs", customType: "om.observations.recorded",
		data: { coversUpToId: "raw", observations: tokenCounts.map((tokens, index) => observation(String(index + 1).repeat(12), tokens)) },
	};
}

describe("summarizer in-flight scheduling recheck", () => {
	beforeEach(() => {
		mocks.runSummarizer.mockReset();
		mocks.runObserver.mockReset();
	});

	it("counts growth during a failed run and relaunches after releasing the lock", async () => {
		const runtime = new Runtime();
		runtime.config = {
			...DEFAULTS,
			newMemoryPoolMaxTokens: 1,
			oldMemoryPoolTargetTokens: 10,
			summarizerRetriggerTokens: 2,
		};
		runtime.configLoaded = true;
		(runtime as any).resolveModel = async () => ({ ok: true, model: { id: "test" }, apiKey: "key" });
		let entries: Entry[] = [memoryEntry([20, 1])];
		const ctx = { cwd: "/tmp", hasUI: false, model: {}, modelRegistry: {}, sessionManager: { getBranch: () => entries } };
		const pi = { appendEntry: vi.fn() };
		let finishFirst!: (result: any) => void;
		mocks.runSummarizer
			.mockImplementationOnce(() => new Promise((resolve) => { finishFirst = resolve; }))
			.mockResolvedValueOnce({ completed: true });

		scheduleSummarizer(pi as any, runtime, ctx);
		await vi.waitFor(() => expect(mocks.runSummarizer).toHaveBeenCalledTimes(1));
		// This memory arrives while the first run owns the single-flight lock.
		// Its scheduling checkpoint must be coalesced, not discarded.
		entries = [memoryEntry([20, 1, 1, 1])];
		scheduleSummarizer(pi as any, runtime, ctx);
		expect(runtime.summarizerRecheckPending).toBe(true);

		finishFirst({ completed: false });
		await vi.waitFor(() => expect(mocks.runSummarizer).toHaveBeenCalledTimes(2));
		await runtime.summarizerPromise;
		// The old pool reached exactly start(20) + retrigger(2); it must not
		// require a hidden 23rd token before relaunching. The successful second
		// no-op pass then installs its own 22 + 2 threshold.
		expect(runtime.summarizerNextTriggerTokens).toBe(24);
		expect(runtime.summarizerInFlight).toBe(false);
	});

	it("launches the summarizer between chunks of a long observer backlog", async () => {
		const runtime = new Runtime();
		runtime.config = {
			...DEFAULTS,
			observeAfterTokens: 1,
			observerChunkMaxTokens: 70,
			newMemoryPoolMaxTokens: 1,
			oldMemoryPoolTargetTokens: 10,
			summarizerRetriggerTokens: 2,
		};
		runtime.configLoaded = true;
		vi.spyOn(runtime, "resolveModel").mockResolvedValue({ ok: true, model: { contextWindow: 256_000 } as any, apiKey: "key" });
		let entries = [
			textCustomMessage("raw-1", "a".repeat(4_000)),
			textCustomMessage("raw-2", "b".repeat(4_000)),
		] as Entry[];
		let appended = 0;
		const pi = {
			appendEntry: vi.fn((customType: string, data: unknown) => {
				entries = [...entries, { type: "custom", customType, data, id: `appended-${++appended}` } as Entry];
			}),
		};
		const ctx = { cwd: "/tmp", hasUI: false, model: {}, modelRegistry: {}, sessionManager: { getBranch: () => entries } };
		let releaseSecondObserver!: () => void;
		mocks.runObserver
			.mockResolvedValueOnce([
				observation("aaaaaaaaaaaa", 20),
				observation("bbbbbbbbbbbb", 20),
			])
			.mockImplementationOnce(() => new Promise((resolve) => { releaseSecondObserver = () => resolve([]); }));
		mocks.runSummarizer.mockResolvedValue({ completed: true });

		const pipeline = runConsolidationPipeline(pi as any, runtime, ctx as any);
		await vi.waitFor(() => expect(mocks.runObserver).toHaveBeenCalledTimes(2));
		await vi.waitFor(() => expect(mocks.runSummarizer).toHaveBeenCalledTimes(1));
		// The second observer chunk is still held, proving scheduling did not wait
		// for the whole finite backlog pipeline to finish.
		expect(runtime.observerBacklogBlocking).toBe(true);
		releaseSecondObserver();
		await pipeline;
		await runtime.summarizerPromise;
	});
});

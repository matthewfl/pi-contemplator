import { describe, expect, it, vi } from "vitest";
import { DEFAULTS } from "../src/config.js";
import { Runtime } from "../src/runtime.js";
import { createSummarizerStallWatchdog, currentMemoryPools, nextSummarizerTriggerTokens, registerConsolidationTrigger, scheduleSummarizer, shouldScheduleSummarizerFromObserver, summarizerTriggerAfterRun, summarizerTriggerTokens } from "../src/hooks/consolidation-trigger.js";
import { newMemoryIdsSinceSummarizerCoverage } from "../src/agents/summarizer/agent.js";
import type { Entry } from "../src/session-ledger/index.js";

function runtime(): Runtime {
	const value = new Runtime();
	value.config = { ...DEFAULTS };
	value.configLoaded = true;
	return value;
}

function observation(id: string, timestamp: string, tokenCount: number) {
	return { id, content: `memory ${id}`, timestamp, relevance: "low", retention: "contextual", sourceEntryIds: ["raw"], tokenCount };
}

function memoryEntries(tokenCounts: number[]): Entry[] {
	return [{
		type: "custom", id: "obs", customType: "om.observations.recorded",
		data: { coversUpToId: "raw", observations: tokenCounts.map((tokens, index) => observation(String(index + 1).repeat(12), `2026-01-0${index + 1} 00:00`, tokens)) },
	}];
}

describe("summarizer scheduling", () => {
	it("enforces one process-local summarizer run at a time", async () => {
		const value = runtime();
		let release!: () => void;
		const held = new Promise<void>((resolve) => { release = resolve; });
		let active = 0;
		let maxActive = 0;
		const first = value.launchSummarizerTask({ hasUI: false }, async () => {
			active++;
			maxActive = Math.max(maxActive, active);
			await held;
			active--;
		});
		expect(first).toBeDefined();
		expect(value.launchSummarizerTask({ hasUI: false }, async () => { active++; })).toBeUndefined();
		expect(active).toBe(1);
		release();
		await first;
		const next = value.launchSummarizerTask({ hasUI: false }, async () => {
			active++;
			maxActive = Math.max(maxActive, active);
			active--;
		});
		expect(next).toBeDefined();
		await next;
		expect(maxActive).toBe(1);
	});

	it("does not launch a summarizer from the compaction observer sidecar", () => {
		expect(shouldScheduleSummarizerFromObserver({ observerOnly: true })).toBe(false);
		expect(shouldScheduleSummarizerFromObserver({})).toBe(true);
	});

	it("aborts a stalled run while progress resets the watchdog", () => {
		vi.useFakeTimers();
		try {
			let stalls = 0;
			const watchdog = createSummarizerStallWatchdog(1_000, () => { stalls++; });
			vi.advanceTimersByTime(900);
			watchdog.progress();
			vi.advanceTimersByTime(900);
			expect(watchdog.signal.aborted).toBe(false);
			vi.advanceTimersByTime(100);
			expect(watchdog.signal.aborted).toBe(true);
			expect(stalls).toBe(1);
			watchdog.dispose();
		} finally {
			vi.useRealTimers();
		}
	});

	it("derives a strict newest 40-token pool and an older eligible prefix", () => {
		const value = runtime();
		value.config = { ...value.config, newMemoryPoolMaxTokens: 40 };
		const pools = currentMemoryPools(value, memoryEntries([20, 20, 20, 20]));
		expect(pools.old.map((item) => item.memory.id)).toEqual(["111111111111", "222222222222"]);
		expect(pools.new.map((item) => item.memory.id)).toEqual(["333333333333", "444444444444"]);
		expect(pools).toMatchObject({ oldTokens: 40, newTokens: 40, totalTokens: 80 });
	});

	it("uses the target initially and an in-memory retrigger threshold afterward", () => {
		const value = runtime();
		value.config = { ...value.config, oldMemoryPoolTargetTokens: 40, summarizerRetriggerTokens: 2 };
		expect(summarizerTriggerTokens(value)).toBe(40);
		expect(nextSummarizerTriggerTokens(40, 40, 2)).toBe(40);
		expect(nextSummarizerTriggerTokens(40, 55, 2)).toBe(57);
		value.summarizerNextTriggerTokens = 57;
		expect(summarizerTriggerTokens(value)).toBe(57);
		value.advanceContextGeneration();
		expect(summarizerTriggerTokens(value)).toBe(40);
	});

	it("advances only successful passes and preserves failed-pass eligibility", () => {
		expect(summarizerTriggerAfterRun(true, undefined, 40, 55, 2)).toBe(57);
		expect(summarizerTriggerAfterRun(false, undefined, 40, 55, 2)).toBeUndefined();
		expect(summarizerTriggerAfterRun(false, 48, 40, 55, 2)).toBe(48);
	});

	it("does not raise the live threshold when model resolution fails", async () => {
		const value = runtime();
		value.config = { ...value.config, newMemoryPoolMaxTokens: 1, oldMemoryPoolTargetTokens: 10, summarizerRetriggerTokens: 2 };
		value.summarizerNextTriggerTokens = 12;
		(value as any).resolveModel = async () => ({ ok: false, reason: "no model" });
		const entries = memoryEntries([20, 20]);
		const ctx = { cwd: "/tmp", hasUI: false, model: undefined, modelRegistry: {}, sessionManager: { getBranch: () => entries } };
		scheduleSummarizer({ appendEntry: vi.fn() } as any, value, ctx);
		await value.summarizerPromise;
		expect(value.summarizerNextTriggerTokens).toBe(12);
		expect(value.lastSummarizerRun?.status).toBe("failed");
	});

	it("resets the threshold cycle when pool settings change", () => {
		const value = runtime();
		value.summarizerNextTriggerTokens = 80;
		const entries = memoryEntries([10]);
		registerConsolidationTrigger({ on: vi.fn() } as any, value);
		const ctx = { cwd: "/tmp", hasUI: false, model: undefined, modelRegistry: {}, sessionManager: { getBranch: () => entries } };
		value.notifySettingsUpdate(ctx, { newMemoryPoolMaxTokens: 50 });
		expect(value.summarizerNextTriggerTokens).toBeUndefined();
		expect(value.summarizerInFlight).toBe(false);
	});

	it("retains durable observation coverage reconstruction for commit provenance", () => {
		const entries: Entry[] = [
			{ type: "message", id: "raw-1" },
			{ type: "custom", id: "obs-1", customType: "om.observations.recorded", data: { coversUpToId: "raw-1", observations: [observation("aaaaaaaaaaaa", "2026-01-01 00:00", 1)] } },
			{ type: "custom", id: "sum", customType: "om.summarizer.commit", data: { version: 1, summaries: [{ id: "cccccccccccc", content: "summary [aaaaaaaaaaaa, bbbbbbbbbbbb]", timestamp: "2026-01-01 00:00", sourceMemoryIds: ["aaaaaaaaaaaa", "bbbbbbbbbbbb"], consumedMemoryIds: ["aaaaaaaaaaaa", "bbbbbbbbbbbb"], tokenCount: 1 }], coversUpToId: "obs-1", createdAt: 1, completedWithDone: true, metrics: { consumedMemoryCount: 2, sourceTokens: 2, summaryTokens: 1, estimatedTokenReduction: 1 } } },
			{ type: "message", id: "raw-2" },
			{ type: "custom", id: "obs-2", customType: "om.observations.recorded", data: { coversUpToId: "raw-2", observations: [observation("dddddddddddd", "2026-01-02 00:00", 1)] } },
		];
		expect(newMemoryIdsSinceSummarizerCoverage(entries)).toEqual(new Set(["dddddddddddd"]));
	});
});

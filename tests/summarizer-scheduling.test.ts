import { describe, expect, it, vi } from "vitest";
import { DEFAULTS } from "../src/config.js";
import { Runtime } from "../src/runtime.js";
import { createSummarizerStallWatchdog, reconcileSummarizerDirty, shouldScheduleSummarizerFromObserver, summarizerDirtySinceAgentTime, summarizerScheduleDelayMs } from "../src/hooks/consolidation-trigger.js";
import { newMemoryIdsSinceSummarizerCoverage } from "../src/agents/summarizer/agent.js";
import type { Entry } from "../src/session-ledger/index.js";

function runtime(): Runtime {
	const value = new Runtime();
	value.config = { ...DEFAULTS, summarizerMinIntervalMinutes: 10, summarizerMaxDelayMinutes: 180, summarizerMinNewMemoryTokens: 5_000, summarizerMaxPendingMemoryTokens: 20_000 };
	return value;
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
		}, 0);
		expect(first).toBeDefined();
		expect(value.launchSummarizerTask({ hasUI: false }, async () => { active++; }, 0)).toBeUndefined();
		expect(active).toBe(1);
		release();
		await first;
		const next = value.launchSummarizerTask({ hasUI: false }, async () => {
			active++;
			maxActive = Math.max(maxActive, active);
			active--;
		}, 1);
		expect(next).toBeDefined();
		await next;
		expect(maxActive).toBe(1);
	});

	it("marks compaction-observer work dirty without launching a summarizer inside compaction", () => {
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

	it("uses cumulative agent-active time and excludes idle wall-clock time", () => {
		const value = runtime();
		value.summarizerDirtySince = 0;
		value.summarizerLastStartedAt = 0;
		value.summarizerPendingTokens = 6_000;
		expect(summarizerScheduleDelayMs(value, 0, 5 * 60_000)).toBe(5 * 60_000);
		expect(summarizerScheduleDelayMs(value, 0, 10 * 60_000)).toBe(0);
	});

	it("lets an urgent token backlog bypass the minimum interval", () => {
		const value = runtime();
		value.summarizerDirtySince = 0;
		value.summarizerLastStartedAt = 9 * 60_000;
		value.summarizerPendingTokens = 20_000;
		expect(summarizerScheduleDelayMs(value, 0, 9 * 60_000)).toBe(0);
	});

	it("preserves the original dirty timestamp across repeated marks", () => {
		const value = runtime();
		value.markSummarizerDirty(1, 10, 100);
		value.markSummarizerDirty(2, 20, 500);
		expect(value.summarizerDirtySince).toBe(100);
		expect(value.summarizerPendingCount).toBe(3);
		expect(value.summarizerPendingTokens).toBe(30);
	});

	it("reconciles stale counters exactly from durable coverage", () => {
		const value = runtime();
		value.markSummarizerDirty(9, 999, 1);
		const entries: Entry[] = [
			{ type: "custom", id: "activity-old", customType: "om.agent.activity", data: { durationMs: 100 } },
			{ type: "custom", id: "obs-old", customType: "om.observations.recorded", data: { coversUpToId: "activity-old", observations: [{ id: "aaaaaaaaaaaa", content: "covered", timestamp: "2026-01-01 00:00", relevance: "low", sourceEntryIds: ["activity-old"], tokenCount: 3 }] } },
			{ type: "custom", id: "sum", customType: "om.summarizer.commit", data: { coversUpToId: "obs-old" } },
			{ type: "custom", id: "activity-new", customType: "om.agent.activity", data: { durationMs: 500 } },
			{ type: "custom", id: "obs-new", customType: "om.observations.recorded", data: { coversUpToId: "activity-new", observations: [{ id: "bbbbbbbbbbbb", content: "uncovered", timestamp: "2026-01-02 00:00", relevance: "low", sourceEntryIds: ["activity-new"], tokenCount: 7 }] } },
		];
		expect(reconcileSummarizerDirty(value, entries)).toEqual(new Set(["bbbbbbbbbbbb"]));
		expect(value.summarizerPendingCount).toBe(1);
		expect(value.summarizerPendingTokens).toBe(7);
		expect(value.summarizerDirtySince).toBe(600);
	});

	it("reconstructs new observation ids after the latest summary coverage", () => {
		const entries: Entry[] = [
			{ type: "message", id: "raw-1" },
			{ type: "custom", id: "obs-1", customType: "om.observations.recorded", data: { coversUpToId: "raw-1", observations: [{ id: "aaaaaaaaaaaa", content: "old", timestamp: "2026-01-01 00:00", relevance: "low", sourceEntryIds: ["raw-1"], tokenCount: 1 }] } },
			{ type: "custom", id: "sum", customType: "om.summarizer.commit", data: { version: 1, summaries: [{ id: "cccccccccccc", content: "summary [aaaaaaaaaaaa, bbbbbbbbbbbb]", sourceMemoryIds: ["aaaaaaaaaaaa", "bbbbbbbbbbbb"], consumedMemoryIds: ["aaaaaaaaaaaa", "bbbbbbbbbbbb"], tokenCount: 1 }], coversUpToId: "obs-1", createdAt: 1, completedWithDone: true, metrics: { consumedMemoryCount: 2, sourceTokens: 2, summaryTokens: 1, estimatedTokenReduction: 1 } } },
			{ type: "message", id: "raw-2" },
			{ type: "custom", id: "obs-2", customType: "om.observations.recorded", data: { coversUpToId: "raw-2", observations: [{ id: "dddddddddddd", content: "new", timestamp: "2026-01-02 00:00", relevance: "low", sourceEntryIds: ["raw-2"], tokenCount: 1 }] } },
		];
		expect(newMemoryIdsSinceSummarizerCoverage(entries)).toEqual(new Set(["dddddddddddd"]));
	});

	it("uses the observation's durable activity checkpoint as dirty age", () => {
		const entries: Entry[] = [
			{ type: "custom", id: "activity", customType: "om.agent.activity", data: { durationMs: 1234 } },
			{ type: "custom", id: "obs", customType: "om.observations.recorded", data: { coversUpToId: "activity", observations: [{ id: "aaaaaaaaaaaa" }] } },
		];
		expect(summarizerDirtySinceAgentTime(entries, new Set(["aaaaaaaaaaaa"]))).toBe(1234);
	});
});

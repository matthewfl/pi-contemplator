import { describe, expect, it } from "vitest";
import { DEFAULTS } from "../src/config.js";
import { Runtime } from "../src/runtime.js";
import { summarizerDirtySinceAgentTime, summarizerScheduleDelayMs } from "../src/hooks/consolidation-trigger.js";
import { newMemoryIdsSinceSummarizerCoverage } from "../src/agents/summarizer/agent.js";
import type { Entry } from "../src/session-ledger/index.js";

function runtime(): Runtime {
	const value = new Runtime();
	value.config = { ...DEFAULTS, summarizerMinIntervalMinutes: 10, summarizerMaxDelayMinutes: 180, summarizerMinNewMemoryTokens: 5_000, summarizerMaxPendingMemoryTokens: 20_000 };
	return value;
}

describe("summarizer scheduling", () => {
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

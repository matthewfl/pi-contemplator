import { describe, expect, it } from "vitest";
import { DEFAULTS } from "../src/config.js";
import { computeSessionSettings } from "../src/runtime.js";
import { renderSummarizer } from "../src/commands/summarizer-view.js";
import { executeRecall } from "../src/tools/recall-observation.js";
import { executeSearchMemories } from "../src/tools/search-memories.js";
import { rawTokensSinceLastCompaction, type Entry } from "../src/session-ledger/index.js";

const branch: Entry[] = [
	{ type: "message", id: "raw", message: { role: "user", content: "alpha evidence" } },
	{ type: "custom", id: "obs", customType: "om.observations.recorded", data: { coversUpToId: "raw", observations: [
		{ id: "aaaaaaaaaaaa", content: "Alpha exact evidence.", timestamp: "2026-01-01 00:00", relevance: "high", sourceEntryIds: ["raw"], tokenCount: 20 },
		{ id: "bbbbbbbbbbbb", content: "Beta exact evidence.", timestamp: "2026-01-01 00:01", relevance: "high", sourceEntryIds: ["raw"], tokenCount: 20 },
	] } },
	{ type: "custom", id: "sum", customType: "om.summarizer.commit", data: { version: 1, summaries: [{ id: "cccccccccccc", content: "Combined [aaaaaaaaaaaa, bbbbbbbbbbbb].", timestamp: "2026-01-01 00:01", sourceMemoryIds: ["aaaaaaaaaaaa", "bbbbbbbbbbbb"], consumedMemoryIds: ["aaaaaaaaaaaa", "bbbbbbbbbbbb"], tokenCount: 5 }], coversUpToId: "obs", createdAt: 1, completedWithDone: true, metrics: { consumedMemoryCount: 2, sourceTokens: 40, summaryTokens: 5, estimatedTokenReduction: 35 } } },
];

describe("summarizer configuration and user tools", () => {
	it("uses token-pool scheduling and 60k sampling defaults", () => {
		expect(DEFAULTS).toMatchObject({ compactAfterTokens: 81_000, summarizerEnabled: true, newMemoryPoolMaxTokens: 40_000, oldMemoryPoolTargetTokens: 40_000, summarizerRetriggerTokens: 2_000, summarizerSamplingThresholdTokens: 60_000 });
		expect(DEFAULTS).not.toHaveProperty("librarianEnabled");
	});

	it("excludes injected memory entries from the proactive compaction source backlog", () => {
		const source: Entry = { type: "message", id: "source", message: { role: "user", content: "small source message" } };
		const injected: Entry = { type: "custom", id: "memory", customType: "om.observations.recorded", data: { observations: [{ content: "x".repeat(100_000) }] } };
		expect(rawTokensSinceLastCompaction([source, injected])).toBe(rawTokensSinceLastCompaction([source]));
	});

	it("restores summarizer session settings through compaction snapshots and live entries", () => {
		const settings = computeSessionSettings([
			{ type: "compaction", details: { sessionSettings: { summarizerEnabled: false, summarizerSamplingThresholdTokens: 60_000 } } },
			{ type: "custom", customType: "om.settings", data: { summarizerEnabled: true, contemplatorMinNewSummaries: 3 } },
		]);
		expect(settings).toMatchObject({ summarizerEnabled: true, summarizerSamplingThresholdTokens: 60_000, contemplatorMinNewSummaries: 3 });
	});

	it("renders the launch-local summarizer transcript and no-run state", () => {
		expect(renderSummarizer(undefined)).toContain("Summarizer has not run yet");
		const rendered = renderSummarizer({ startedAt: 1, status: "completed", messages: [{ role: "assistant", content: [{ type: "toolCall", name: "summarize", arguments: { summaries: ["x"] } }] }], summary: "1 summary created" });
		expect(rendered).toContain("SUMMARIZER · completed");
		expect(rendered).toContain("tool call: summarize");
	});

	it("search and recall expose summarized-away status and graph navigation", () => {
		const search = executeSearchMemories(branch, { query: "Alpha exact" });
		expect(search.content[0].text).toContain("[summarized away]");
		expect(search.content[0].text).toContain("consumed by [cccccccccccc]");
		const recall = executeRecall({ id: "cccccccccccc" }, () => branch);
		expect(recall.details.status).toBe("ok");
		expect(recall.content[0].text).toContain("Source memories: [aaaaaaaaaaaa, bbbbbbbbbbbb]");
	});
});

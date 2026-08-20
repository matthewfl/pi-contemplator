import { describe, expect, it } from "vitest";
import { renderSummarizerMemory, sampleSummarizerMemories, type SummarizerMemory } from "../src/agents/summarizer/sampling.js";

function observation(id: string, timestamp: string, relevance: "low" | "critical" = "low"): SummarizerMemory {
	return { kind: "observation", memory: { id, content: `memory ${id} `.repeat(20), timestamp, relevance, retention: "contextual", sourceEntryIds: ["raw"], tokenCount: 30 } };
}

const memories = [
	observation("aaaaaaaaaaaa", "2026-01-01 00:00"),
	observation("bbbbbbbbbbbb", "2026-01-02 00:00"),
	observation("cccccccccccc", "2026-01-03 00:00", "critical"),
];

describe("summarizer sampling", () => {
	it("returns the complete set below the configured token threshold", () => {
		const sample = sampleSummarizerMemories({ memories, samplingThresholdTokens: 10_000 });
		expect(sample.sampled).toBe(false);
		expect(sample.memories).toEqual(memories);
	});

	it("samples to the token cap only when the rendered set exceeds it", () => {
		const sample = sampleSummarizerMemories({ memories, samplingThresholdTokens: 100, random: () => 0.5 });
		expect(sample.sampled).toBe(true);
		expect(sample.selectedTokens).toBeLessThanOrEqual(100);
		expect(sample.selectedCount).toBeLessThan(memories.length);
	});

	it("favors new memories and records no fairness mutation itself", () => {
		const fairness = new Map<string, { sampleCount: number }>();
		const equallyOld = [observation("aaaaaaaaaaaa", "2026-01-01 00:00"), observation("bbbbbbbbbbbb", "2026-01-01 00:00")];
		const sample = sampleSummarizerMemories({ memories: equallyOld, samplingThresholdTokens: 200, newMemoryIds: new Set(["aaaaaaaaaaaa"]), fairness, random: () => 0.5 });
		expect(sample.memories.map((item) => item.memory.id)).toContain("aaaaaaaaaaaa");
		expect(fairness.size).toBe(0);
	});

	it("renders observation and summary metadata for the model", () => {
		expect(renderSummarizerMemory(memories[0])).toContain("observation 2026-01-01");
		const summary: SummarizerMemory = { kind: "summary", memory: { id: "dddddddddddd", content: "combined", sourceMemoryIds: ["aaaaaaaaaaaa", "bbbbbbbbbbbb"], consumedMemoryIds: ["aaaaaaaaaaaa", "bbbbbbbbbbbb"], tokenCount: 2 } };
		expect(renderSummarizerMemory(summary)).toContain("summary sources=[aaaaaaaaaaaa, bbbbbbbbbbbb]");
	});
});

import { describe, expect, it } from "vitest";
import { chronologicalMemories, latestMemoryTimestamp, partitionMemoryPools, renderSummary, type Observation, type Summary } from "../src/session-ledger/index.js";

function observation(id: string, timestamp: string, tokenCount: number): Observation {
	return { id, content: `observation ${id}`, timestamp, relevance: "high", retention: "contextual", sourceEntryIds: ["raw"], tokenCount };
}

function summary(id: string, timestamp: string, tokenCount: number): Summary {
	return { id, content: `summary [aaaaaaaaaaaa, bbbbbbbbbbbb]`, timestamp, sourceMemoryIds: ["aaaaaaaaaaaa", "bbbbbbbbbbbb"], consumedMemoryIds: ["aaaaaaaaaaaa", "bbbbbbbbbbbb"], tokenCount };
}

describe("memory pool accounting", () => {
	it("protects the newest whole-memory suffix without exceeding the strict cap", () => {
		const observations = [
			observation("aaaaaaaaaaaa", "2026-01-01T00:00:00Z", 25),
			observation("bbbbbbbbbbbb", "2026-01-02T00:00:00Z", 20),
			observation("cccccccccccc", "2026-01-03T00:00:00Z", 20),
		];
		const pools = partitionMemoryPools(observations, [], 40);
		expect(pools.old.map((item) => item.memory.id)).toEqual(["aaaaaaaaaaaa"]);
		expect(pools.new.map((item) => item.memory.id)).toEqual(["bbbbbbbbbbbb", "cccccccccccc"]);
		expect(pools).toMatchObject({ oldTokens: 25, newTokens: 40, totalTokens: 65 });
	});

	it("always protects an oversized newest memory despite the nominal token cap", () => {
		const pools = partitionMemoryPools([
			observation("aaaaaaaaaaaa", "2026-01-01T00:00:00Z", 20),
			observation("bbbbbbbbbbbb", "2026-01-02T00:00:00Z", 41),
		], [], 40);
		expect(pools.new.map((item) => item.memory.id)).toEqual(["bbbbbbbbbbbb"]);
		expect(pools.old.map((item) => item.memory.id)).toEqual(["aaaaaaaaaaaa"]);
		expect(pools).toMatchObject({ newTokens: 41, oldTokens: 20 });
	});

	it("interleaves summaries by their effective source timestamp", () => {
		const b = observation("bbbbbbbbbbbb", "2026-01-01T00:00:07Z", 1);
		const ac = summary("acacacacacac", "2026-01-01T00:00:20Z", 1);
		const d = observation("dddddddddddd", "2026-01-01T00:00:44Z", 1);
		expect(chronologicalMemories([d, b], [ac]).map((item) => item.memory.id)).toEqual([
			"bbbbbbbbbbbb", "acacacacacac", "dddddddddddd",
		]);
		const rendered = renderSummary([ac], [d, b]);
		expect(rendered.indexOf("[bbbbbbbbbbbb]")).toBeLessThan(rendered.indexOf("[acacacacacac]"));
		expect(rendered.indexOf("[acacacacacac]")).toBeLessThan(rendered.indexOf("[dddddddddddd]"));
	});

	it("uses the latest cited timestamp for a summary, including cited summaries", () => {
		const sources = [
			{ kind: "observation" as const, memory: observation("aaaaaaaaaaaa", "2026-01-01T00:00:05Z", 1) },
			{ kind: "summary" as const, memory: summary("bbbbbbbbbbbb", "2026-01-01T00:00:20Z", 1) },
			{ kind: "observation" as const, memory: observation("cccccccccccc", "2026-01-01T00:00:07Z", 1) },
		];
		expect(latestMemoryTimestamp(sources)).toBe("2026-01-01T00:00:20Z");
	});
});

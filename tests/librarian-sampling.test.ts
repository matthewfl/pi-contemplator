import { describe, expect, it } from "vitest";
import { sampleLibrarianMemories, type LibrarianMemory } from "../src/agents/librarian/sampling.js";
import type { Observation } from "../src/session-ledger/index.js";

function item(index: number, tokenCount = 100): LibrarianMemory {
	const id = index.toString(16).padStart(12, "0").slice(-12);
	const memory: Observation = {
		id,
		content: `Memory ${index} ${"x".repeat(tokenCount * 4)}`,
		timestamp: `2026-01-${String(Math.min(28, index + 1)).padStart(2, "0")} 10:00`,
		relevance: index % 3 === 0 ? "high" : "medium",
		retention: index % 4 === 0 ? "durable" : "contextual",
		sourceEntryIds: ["raw"],
		tokenCount,
	};
	return { kind: "observation", memory, status: "active" };
}

function seeded(values: number[]): () => number {
	let index = 0;
	return () => values[index++ % values.length] ?? 0.5;
}

describe("librarian pressure-valve sampling", () => {
	it("uses the configured token count as the sampling threshold", () => {
		const activeMemories = [item(1, 20), item(2, 20)];
		const result = sampleLibrarianMemories({ activeMemories, inactiveCohorts: [], samplingThresholdTokens: 4_000, random: () => 0.5 });
		expect(result.budgetTokens).toBe(4_000);
		expect(result.sampled).toBe(false);
		expect(result.activeMemories).toEqual(activeMemories);
		expect(result.selectedTokens).toBe(result.eligibleTokens);
	});

	it("samples back to the fixed token budget only above the configured threshold", () => {
		const activeMemories = Array.from({ length: 80 }, (_, index) => item(index, 100));
		const full = sampleLibrarianMemories({ activeMemories, inactiveCohorts: [], samplingThresholdTokens: 5_200, random: seeded([0.1, 0.5, 0.9]) });
		expect(full.sampled).toBe(true);
		expect(full.selectedTokens).toBeLessThanOrEqual(5_200);
		const ratio = full.selectedTokens / full.eligibleTokens;
		expect(ratio).toBeGreaterThan(0.5);
		expect(ratio).toBeLessThan(0.75);
	});

	it("keeps aliases run-local and records fairness outside the ledger", () => {
		const fairness = new Map();
		const result = sampleLibrarianMemories({
			activeMemories: [],
			inactiveCohorts: [
				{ recallIf: "Recall alpha", memoryIds: ["aaaaaaaaaaaa", "bbbbbbbbbbbb"] },
				{ recallIf: "Recall beta", memoryIds: ["cccccccccccc"] },
			],
			fairness,
		});
		expect(result.inactiveCohorts.map((cohort) => cohort.alias)).toEqual(["inactive_1", "inactive_2"]);
		expect(result.aliasMembers.get("inactive_1")).toEqual(["aaaaaaaaaaaa", "bbbbbbbbbbbb"]);
		expect(fairness.size).toBe(0);
	});
});

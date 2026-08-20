import { describe, expect, it } from "vitest";
import {
	buildCompactionProjection,
	buildSummarizerCommitData,
	foldLedger,
	fullProjection,
	isMemoryDetails,
	isSummarizerCommitData,
	isSummary,
	OM_SUMMARIZER_COMMIT,
	recallMemorySources,
	renderSummary,
	searchMemories,
	visibleProjection,
	type Entry,
	type Observation,
	type ReviewResult,
	type Summary,
} from "../src/session-ledger/index.js";

const A = "aaaaaaaaaaaa";
const B = "bbbbbbbbbbbb";
const S = "cccccccccccc";

function observation(id: string, content: string): Observation {
	return { id, content, timestamp: "2026-01-01 10:00", relevance: "high", retention: "contextual", sourceEntryIds: ["raw"], tokenCount: 20 };
}

function summary(overrides: Partial<Summary> = {}): Summary {
	return { id: S, content: `Combined evidence [${A}, ${B}].`, sourceMemoryIds: [A, B], consumedMemoryIds: [A, B], tokenCount: 6, ...overrides };
}

function commit(value = summary()): Entry {
	return { type: "custom", id: "sum-entry", customType: OM_SUMMARIZER_COMMIT, data: { version: 1, summaries: [value], coversUpToId: "obs-entry", createdAt: 1, completedWithDone: true, metrics: { consumedMemoryCount: 2, sourceTokens: 40, summaryTokens: 6, estimatedTokenReduction: 34 } } };
}

function branch(extra: Entry[] = []): Entry[] {
	return [
		{ type: "message", id: "raw", message: { role: "user", content: "exact evidence" } },
		{ type: "custom", id: "obs-entry", customType: "om.observations.recorded", data: { coversUpToId: "raw", observations: [observation(A, "Alpha subsystem result."), observation(B, "Beta subsystem result.")] } },
		commit(),
		...extra,
	];
}

function review(): ReviewResult {
	return { id: "dddddddddddd", version: 1, reviewRequestId: "review-1", scope: "workflow", outcome: "no_proposal", reason: "No durable change.", evidenceReviewed: "Checked the cited loop.", createdAt: 1, requestedBy: "contemplator" };
}

describe("summary ledger schema", () => {
	it("validates cited summaries and atomic commits", () => {
		expect(OM_SUMMARIZER_COMMIT).toBe("om.summarizer.commit");
		expect(isSummary(summary())).toBe(true);
		expect(isSummary({ ...summary(), consumedMemoryIds: [A] })).toBe(false);
		expect(isSummary({ ...summary(), consumedMemoryIds: [A, "eeeeeeeeeeee"] })).toBe(false);
		expect(isSummarizerCommitData(commit().data)).toBe(true);
		expect(buildSummarizerCommitData({ summaries: [], coversUpToId: "obs", createdAt: 1, completedWithDone: true, metrics: { consumedMemoryCount: 0, sourceTokens: 0, summaryTokens: 0, estimatedTokenReduction: 0 } })).toBeUndefined();
	});
});

describe("summary graph folding and projection", () => {
	it("derives visibility, all forward citations, and the consuming pointer", () => {
		const nonConsuming = summary({ id: "eeeeeeeeeeee", content: `Alternative context [${A}, ${B}, ffffffffffff, 111111111111].`, sourceMemoryIds: [A, B, "ffffffffffff", "111111111111"], consumedMemoryIds: ["ffffffffffff", "111111111111"] });
		const folded = foldLedger(branch([{ ...commit(nonConsuming), id: "sum-entry-2" }]));
		expect(folded.activeObservations).toEqual([]);
		expect(folded.activeSummaries.map((item) => item.id)).toEqual([S, "eeeeeeeeeeee"]);
		expect(folded.consumedBySummaryId.get(A)).toBe(S);
		expect(folded.citedBySummaryIds.get(A)).toEqual([S, "eeeeeeeeeeee"]);
		expect(fullProjection(branch()).summaries.map((item) => item.id)).toEqual([S]);
	});

	it("keeps first-valid content-addressed nodes and first consumer", () => {
		const duplicate = summary({ content: "corrupt duplicate body" });
		const folded = foldLedger(branch([{ ...commit(duplicate), id: "duplicate" }]));
		expect(folded.summariesById.get(S)?.content).toContain("Combined evidence");
		expect(folded.summaries).toHaveLength(1);
	});

	it("writes a complete compaction archive and restores graph edges from it", () => {
		const projected = buildCompactionProjection(branch(), "sum-entry");
		expect(projected.observations).toEqual([]);
		expect(projected.summaries).toHaveLength(1);
		expect(projected.details.archive?.observations).toHaveLength(2);
		expect(projected.details.version).toBe(2);
		expect(isMemoryDetails(projected.details)).toBe(true);
		expect(isMemoryDetails({ ...projected.details, version: 1, reflections: [] })).toBe(false);
		const restored = foldLedger([{ type: "compaction", id: "compact", details: projected.details }]);
		expect(restored.consumedBySummaryId.get(A)).toBe(S);
		expect(restored.citedBySummaryIds.get(B)).toEqual([S]);
		expect(restored.activeSummaries.map((item) => item.id)).toEqual([S]);
		expect(visibleProjection([{ type: "compaction", id: "compact", details: projected.details }]).summaries).toHaveLength(1);
	});

	it("renders summaries and observations but never injects review records", () => {
		const entries = branch([{ type: "custom", id: "review-entry", customType: "om.review.result", data: { result: review() } }]);
		const projection = fullProjection(entries);
		expect(projection.reviews).toEqual([review()]);
		const rendered = renderSummary(projection.summaries, projection.observations);
		expect(rendered).toContain("## Summaries");
		expect(rendered).not.toContain("No durable change");
	});
});

describe("summary graph search and recall", () => {
	it("searches visible and summarized-away nodes with graph metadata", () => {
		const result = searchMemories(branch(), "Alpha subsystem");
		expect(result).toMatchObject({ observationsSearched: 2, summariesSearched: 1 });
		expect(result.results[0]).toMatchObject({ id: A, kind: "observation", visibility: "summarized", consumedBySummaryId: S, citedBySummaryIds: [S] });
	});

	it("recalls an observation body once with exact source and forward pointers", () => {
		const result = recallMemorySources(branch(), A);
		expect(result.status).toBe("found");
		if (result.status !== "found") return;
		expect(result.kind).toBe("observation");
		expect(result.observations[0]).toMatchObject({ visibility: "summarized", consumedBySummaryId: S, citedBySummaryIds: [S] });
		expect(result.sourceEntries.map((entry) => entry.id)).toEqual(["raw"]);
		expect(result.summaries).toEqual([]);
	});

	it("recalls a summary with immediate backward and forward links without recursive bodies", () => {
		const higher = summary({ id: "eeeeeeeeeeee", content: `Higher order [${S}, ffffffffffff].`, sourceMemoryIds: [S, "ffffffffffff"], consumedMemoryIds: [S, "ffffffffffff"] });
		const entries = branch([{ ...commit(higher), id: "higher-entry" }]);
		const result = recallMemorySources(entries, S);
		expect(result.status).toBe("found");
		if (result.status !== "found") return;
		expect(result.summaries[0]).toMatchObject({ sourceMemoryIds: [A, B], consumedMemoryIds: [A, B], consumedBySummaryId: "eeeeeeeeeeee", citedBySummaryIds: ["eeeeeeeeeeee"] });
		expect(result.observations).toEqual([]);
	});

	it("keeps reviews searchable and recallable but nonconsumable", () => {
		const entries = branch([{ type: "custom", id: "review-entry", customType: "om.review.result", data: { result: review() } }]);
		expect(searchMemories(entries, "durable change").results[0]).toMatchObject({ kind: "review", id: review().id });
		const recalled = recallMemorySources(entries, review().id);
		expect(recalled.status).toBe("found");
		if (recalled.status === "found") expect(recalled.kind).toBe("review");
	});
});

import { describe, expect, it } from "vitest";
import {
	buildCompactionProjection,
	foldLedger,
	fullProjection,
	recallMemorySources,
	searchMemories,
	type Entry,
	OM_LIBRARIAN_COMMIT,
} from "../src/session-ledger/index.js";

const OBS_A = "aaaaaaaaaaaa";
const OBS_B = "bbbbbbbbbbbb";
const REF_C = "cccccccccccc";

function branch(): Entry[] {
	return [
		{ type: "message", id: "raw-1", message: { role: "user", content: [{ type: "text", text: "alpha beta" }] } },
		{
			type: "custom", id: "obs-entry", customType: "om.observations.recorded",
			data: {
				coversUpToId: "raw-1",
				observations: [
					{ id: OBS_A, content: "Alpha subsystem details remain useful later.", timestamp: "2026-01-01 10:00", relevance: "high", retention: "contextual", sourceEntryIds: ["raw-1"], tokenCount: 10 },
					{ id: OBS_B, content: "Temporary beta command output was consumed.", timestamp: "2026-01-01 10:01", relevance: "low", retention: "ephemeral", sourceEntryIds: ["raw-1"], tokenCount: 10 },
				],
			},
		},
		{
			type: "custom", id: "lib-entry", customType: OM_LIBRARIAN_COMMIT,
			data: {
				version: 1,
				coversUpToId: "obs-entry",
				summary: "Consolidated alpha and beta.",
				createdAt: 1,
				reflections: [{ id: REF_C, content: "Alpha and beta work produced one retained result.", supportingObservationIds: [OBS_A, OBS_B], sourceMemoryIds: [OBS_A, OBS_B], tokenCount: 9 }],
				actions: [
					{ type: "makeInactive", memoryIds: [OBS_A], recallIf: "Recall when work returns to alpha", becauseOfMemoryIds: [REF_C], createdAt: 1 },
					{ type: "delete", memoryIds: [OBS_B], reason: "Consumed temporary command output.", becauseOfMemoryIds: [REF_C], replacementMemoryIds: [REF_C], createdAt: 1 },
				],
			},
		},
	] as Entry[];
}

describe("librarian ledger", () => {
	it("folds observations and reflections into active, inactive, and deleted sets", () => {
		const folded = foldLedger(branch());
		expect(folded.activeReflections.map((item) => item.id)).toEqual([REF_C]);
		expect(folded.inactiveObservations.map((item) => item.id)).toEqual([OBS_A]);
		expect(folded.deletedObservations.map((item) => item.id)).toEqual([OBS_B]);
		expect(folded.mergedIntoByMemoryId.get(OBS_A)).toEqual([REF_C]);
		expect(folded.replacedByMemoryId.get(OBS_B)).toEqual([REF_C]);
		expect(fullProjection(branch()).observations).toEqual([]);
		expect(fullProjection(branch()).reflections.map((item) => item.id)).toEqual([REF_C]);
	});

	it("hides inactive status from normal search but exposes it to librarian search", () => {
		const normal = searchMemories(branch(), "Alpha", 8);
		const librarian = searchMemories(branch(), "Alpha", 8, { librarian: true });
		const normalObservation = normal.results.find((item) => item.id === OBS_A);
		const librarianObservation = librarian.results.find((item) => item.id === OBS_A);
		expect(normalObservation).toMatchObject({ id: OBS_A, status: "active" });
		expect(normalObservation?.recallIf).toBeUndefined();
		expect(librarianObservation).toMatchObject({ id: OBS_A, status: "inactive", recallIf: "Recall when work returns to alpha" });
	});

	it("returns durable delete reasons from search and recall", () => {
		const search = searchMemories(branch(), "temporary beta", 8);
		expect(search.results[0]).toMatchObject({ id: OBS_B, status: "deleted", deleteReason: "Consumed temporary command output." });
		const recall = recallMemorySources(branch(), OBS_B);
		expect(recall.status).toBe("found");
		if (recall.status === "found") expect(recall.observations[0]).toMatchObject({ status: "deleted", deleteReason: "Consumed temporary command output." });
	});

	it("archives inactive and deleted memories across compaction details", () => {
		const entries = branch();
		const projection = buildCompactionProjection(entries, "lib-entry", { observationsPoolMaxTokens: 1 });
		const compacted: Entry[] = [{ type: "compaction", id: "compact-1", details: projection.details }];
		const folded = foldLedger(compacted);
		expect(folded.inactiveObservations.map((item) => item.id)).toEqual([OBS_A]);
		expect(folded.deletedObservations.map((item) => item.id)).toEqual([OBS_B]);
		expect(folded.activeReflections.map((item) => item.id)).toEqual([REF_C]);
	});
});

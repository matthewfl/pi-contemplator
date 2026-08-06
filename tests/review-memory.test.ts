import { describe, expect, it } from "vitest";
import { fullProjection } from "../src/session-ledger/projection.js";
import { recallMemorySources } from "../src/session-ledger/recall.js";
import { searchMemories } from "../src/session-ledger/search.js";
import { OM_REVIEW_RESULT, type Entry, type WorkflowReviewProposal } from "../src/session-ledger/types.js";
import { executeRecall } from "../src/tools/recall-observation.js";

const proposal: WorkflowReviewProposal = {
	id: "aaaaaaaaaaaa", version: 1, reviewRequestId: "review-1", scope: "workflow", outcome: "proposal", proposalKind: "workflow", createdAt: 1, requestedBy: "contemplator",
	title: "Reusable relationship trace", summary: "Preserve source relationships for reuse.", evidence: "[bbbbbbbbbbbb] manual reconstruction recurred.", inefficiency: "Repeated manual reconstruction.", conceptualDesign: "Keep a durable relationship trace that can be queried and reviewed.", inputs: "Recorded source relationships.", outputs: "A compact reusable trace.", integration: "Reuse it when investigating related work.", expectedEffect: "Less repeated work and better reviewability.", uncertainties: "The live environment determines the fitting representation.",
};

const entries: Entry[] = [{ id: "review-entry", type: "custom", customType: OM_REVIEW_RESULT, data: { result: proposal } }];

describe("review result memory", () => {
	it("is a distinct projected advisory memory", () => {
		const projection = fullProjection(entries);
		expect(projection.observations).toEqual([]);
		expect(projection.reflections).toEqual([]);
		expect(projection.reviews).toEqual([proposal]);
	});

	it("is searchable by proposal title, scope, and evidence", () => {
		const result = searchMemories(entries, "relationship workflow reconstruction");
		expect(result.reviewsSearched).toBe(1);
		expect(result.results[0]).toMatchObject({ id: proposal.id, kind: "review", scope: "workflow", outcome: "proposal", title: proposal.title });
	});

	it("recalls full advisory proposal rather than treating it as evidence", () => {
		const recalled = recallMemorySources(entries, proposal.id);
		expect(recalled.status).toBe("found");
		if (recalled.status !== "found") return;
		expect(recalled.kind).toBe("review");
		expect(recalled.reviews[0].review).toEqual(proposal);
		const rendered = executeRecall({ id: proposal.id }, () => entries);
		expect(rendered.content[0].text).toContain("Status: advisory; not evidence of implementation or validation");
		expect(rendered.content[0].text).toContain("Reusable relationship trace");
	});
});

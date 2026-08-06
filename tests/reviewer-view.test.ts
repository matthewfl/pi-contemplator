import { describe, expect, it } from "vitest";
import { renderReviewer } from "../src/commands/reviewer-view.js";
import { OM_REVIEWER_MESSAGE, OM_REVIEWER_NOTICE, OM_REVIEW_RESULT, type Entry } from "../src/session-ledger/types.js";

const entries: Entry[] = [
	{
		id: "review-message", type: "custom", customType: OM_REVIEWER_MESSAGE,
		data: {
			version: 1, reviewRequestId: "request-1", scope: "workflow",
			message: { role: "assistant", content: [{ type: "toolCall", name: "submit_workflow_proposal", arguments: { title: "Reusable trace" } }] },
		},
	},
	{
		id: "review-result", type: "custom", customType: OM_REVIEW_RESULT,
		data: { result: { id: "aaaaaaaaaaaa", reviewRequestId: "request-1", scope: "workflow", outcome: "proposal" } },
	},
	{
		id: "review-notice", type: "custom", customType: OM_REVIEWER_NOTICE,
		data: { version: 1, reviewRequestId: "request-1", reviewMemoryId: "aaaaaaaaaaaa", scope: "workflow", content: "BACKGROUND WORKFLOW REVIEW PROPOSAL [aaaaaaaaaaaa]\n\nReusable trace summary." },
	},
];

describe("reviewer view", () => {
	it("renders persisted assistant tool output, terminal result, and primary-agent notice", () => {
		const output = renderReviewer(entries);
		expect(output).toContain("STRUCTURAL REVIEWER · 1 review run");
		expect(output).toContain("workflow review request-1 · proposal · [aaaaaaaaaaaa]");
		expect(output).toContain("[tool call: submit_workflow_proposal");
		expect(output).toContain("Primary-agent notice queued");
		expect(output).toContain("Reusable trace summary.");
	});
});

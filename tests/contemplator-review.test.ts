import { describe, expect, it } from "vitest";
import { createRequestReviewTool } from "../src/agents/contemplator/agent.js";

describe("contemplator review request tool", () => {
	it("accepts a scoped request and returns its queued identifier", async () => {
		let received: unknown;
		const tool = createRequestReviewTool((request) => {
			received = request;
			return "review-request-1";
		});
		const result = await tool.execute("call", {
			scope: "workflow",
			evidence: " [aaaaaaaaaaaa] the same trace was reconstructed twice. ",
			concern: " A reusable workflow representation may be missing. ",
			review_focus: " Determine whether a durable workflow design is justified. ",
			constraints: " Preserve user-facing behavior. ",
		});
		expect(received).toEqual({
			scope: "workflow",
			evidence: "[aaaaaaaaaaaa] the same trace was reconstructed twice.",
			concern: "A reusable workflow representation may be missing.",
			review_focus: "Determine whether a durable workflow design is justified.",
			constraints: "Preserve user-facing behavior.",
		});
		expect(result.content[0]).toMatchObject({ text: "Workflow review queued as [review-request-1]." });
	});
});

import { describe, expect, it } from "vitest";
import { runStructuralReview } from "../src/agents/reviewer/agent.js";
import {
	REVIEWER_COMMON_SYSTEM,
	SOFTWARE_REVIEWER_SCOPE,
	WORKFLOW_REVIEWER_SCOPE,
	buildReviewerSystemPrompt,
} from "../src/agents/reviewer/prompts.js";
import type { StructuralReviewRequest } from "../src/session-ledger/types.js";

function request(scope: "workflow" | "software"): StructuralReviewRequest {
	return {
		id: `review-${scope}`,
		scope,
		evidence: "[aaaaaaaaaaaa] The same operation recurred.",
		concern: "The pattern may need a durable design.",
		reviewFocus: "Determine whether a proposal is justified.",
		createdAt: Date.now(),
		requestedBy: "contemplator",
	};
}

function loopCalling(toolName: string, args: Record<string, string>) {
	return (_prompts: any, context: any) => ({
		async *[Symbol.asyncIterator]() {
			const tool = context.tools.find((candidate: any) => candidate.name === toolName);
			await tool.execute("terminal", args);
		},
		result: async () => [],
	});
}

describe("scoped structural reviewer routing", () => {
	it("includes only the requested reviewer scope prompt", () => {
		const workflow = buildReviewerSystemPrompt("workflow");
		const software = buildReviewerSystemPrompt("software");
		expect(workflow).toContain(REVIEWER_COMMON_SYSTEM);
		expect(workflow).toContain(WORKFLOW_REVIEWER_SCOPE);
		expect(workflow).not.toContain(SOFTWARE_REVIEWER_SCOPE);
		expect(software).toContain(REVIEWER_COMMON_SYSTEM);
		expect(software).toContain(SOFTWARE_REVIEWER_SCOPE);
		expect(software).not.toContain(WORKFLOW_REVIEWER_SCOPE);
	});

	it("exposes only the workflow terminal proposal tool", async () => {
		let names: string[] = [];
		const result = await runStructuralReview({
			request: request("workflow"), model: {} as any, apiKey: "key", getBranch: () => [],
			agentLoop: ((prompts: any, context: any) => {
				names = context.tools.map((tool: any) => tool.name);
				return loopCalling("submit_workflow_proposal", {
					title: "Reusable evidence trace", summary: "Preserve repeated evidence work.", evidence: "[aaaaaaaaaaaa] repeated work", inefficiency: "Repeated reconstruction", conceptual_design: "Keep a reusable trace.", expected_effect: "More reliable review", uncertainties: "Environment details remain unknown.",
				})(prompts, context);
			}) as any,
		});
		expect(names).toEqual(["search_memories", "recall", "submit_workflow_proposal", "review_concluded_no_proposal"]);
		expect(result).toMatchObject({ scope: "workflow", outcome: "proposal", proposalKind: "workflow" });
	});

	it("exposes only the software terminal proposal tool", async () => {
		let names: string[] = [];
		const result = await runStructuralReview({
			request: request("software"), model: {} as any, apiKey: "key", getBranch: () => [],
			agentLoop: ((prompts: any, context: any) => {
				names = context.tools.map((tool: any) => tool.name);
				return loopCalling("submit_software_proposal", {
					title: "Explicit lifecycle", summary: "Represent the repeated state explicitly.", evidence: "[aaaaaaaaaaaa] repeated workaround", structural_issue: "Missing lifecycle invariant", conceptual_design: "Make ownership and lifecycle explicit.", preserved_behavior: "Keep current user behavior.", expected_effect: "Fewer special cases", uncertainties: "Call-site details remain unknown.",
				})(prompts, context);
			}) as any,
		});
		expect(names).toEqual(["search_memories", "recall", "submit_software_proposal", "review_concluded_no_proposal"]);
		expect(result).toMatchObject({ scope: "software", outcome: "proposal", proposalKind: "software" });
	});

	it("allows either scope to conclude no proposal", async () => {
		const result = await runStructuralReview({
			request: request("software"), model: {} as any, apiKey: "key", getBranch: () => [],
			agentLoop: ((prompts: any, context: any) => loopCalling("review_concluded_no_proposal", {
				reason: "The pattern is isolated.", evidence_reviewed: "[aaaaaaaaaaaa] is the only relevant memory.", reconsider_if: "The same issue recurs.",
			})(prompts, context)) as any,
		});
		expect(result).toMatchObject({ scope: "software", outcome: "no_proposal", reason: "The pattern is isolated." });
	});

	it("rejects a review with no terminal tool call", async () => {
		const result = await runStructuralReview({
			request: request("workflow"), model: {} as any, apiKey: "key", getBranch: () => [],
			agentLoop: (() => ({ async *[Symbol.asyncIterator]() {}, result: async () => [] })) as any,
		});
		expect(result).toBeUndefined();
	});
});

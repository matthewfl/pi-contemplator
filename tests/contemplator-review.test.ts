import { describe, expect, it } from "vitest";
import { createRequestReviewTool, createSendProbeTool } from "../src/agents/contemplator/agent.js";
import { delimitedMemoryIds } from "../src/memory-citations.js";
import { CONTEMPLATOR_SYSTEM, buildContemplatorSystemPrompt } from "../src/agents/contemplator/prompts.js";

describe("contemplator review request tool", () => {
	it("includes review escalation only when reviewers are enabled", () => {
		const enabled = buildContemplatorSystemPrompt(true);
		const disabled = buildContemplatorSystemPrompt(false);

		expect(enabled).toBe(CONTEMPLATOR_SYSTEM);
		expect(enabled).toContain("request_review");
		expect(enabled).toContain("recurring structural patterns");
		expect(enabled).toContain("later call replaces the earlier one");

		// Non-review improvements from the revision remain shared.
		expect(disabled).toContain("direct progress may be more informative than further hypothesis formation");
		expect(disabled).toContain("Activity measurements may support the diagnosis");

		// Only instructions specific to the structural-review tool are omitted.
		expect(disabled).not.toContain("request_review");
		expect(disabled.toLowerCase()).not.toContain("reviewer");
	});

	it("extracts bracketed and parenthesized memory-like ids without treating bare hashes as citations", () => {
		expect(delimitedMemoryIds("[abcdef0] (1234567890abcdef) {cccccccccccc} [aaaaaaaaaaaa] bare bbbbbbbbbbbb [abcdef0]"))
			.toEqual(["abcdef0", "1234567890abcdef", "cccccccccccc", "aaaaaaaaaaaa"]);
		expect(delimitedMemoryIds("[abcdef] [1234567890abcdef0] (ABCDEF123456) [not-a-hash]"))
			.toEqual([]);
	});

	it("warns for every unknown citation but still queues a replaceable probe", async () => {
		const tool = createSendProbeTool(
			() => ({ overwritten: false }),
			(id) => id === "aaaaaaaaaaaa",
		);
		const result = await tool.execute("probe-call", {
			question: "Compare [aaaaaaaaaaaa], (bbbbbbbbbbbb), and [abcdef0]. What changed?",
		});
		const text = (result.content[0] as { text: string }).text;

		expect(text).not.toContain("memory aaaaaaaaaaaa not found");
		expect(text).toContain("WARNING: memory bbbbbbbbbbbb not found");
		expect(text).toContain("WARNING: memory abcdef0 not found");
		expect(text).toContain("use search_memories and recall");
		expect(text).toContain("call send_probe again to replace the probe");
		expect(text).toContain("Probe will be delivered at the end of your turn.");
		expect(result.details).toMatchObject({ queued: true, overwritten: false, memoryIds: ["aaaaaaaaaaaa", "bbbbbbbbbbbb", "abcdef0"] });
	});

	it("reports last-write-wins replacement across intervention tool calls", async () => {
		const probeTool = createSendProbeTool(() => ({ overwritten: true }));
		const reviewTool = createRequestReviewTool(() => ({ reviewRequestId: "review-request-2", overwritten: true }));
		const probeResult = await probeTool.execute("probe-call", { question: "Should this be investigated?" });
		const reviewResult = await reviewTool.execute("review-call", {
			scope: "workflow",
			evidence: "[aaaaaaaaaaaa] repeated work",
			concern: "A recurring issue may exist.",
			review_focus: "Determine whether review is justified.",
		});

		expect((probeResult.content[0] as { text: string }).text).toContain("WARNING: overwriting prior probe/review tool call");
		expect((reviewResult.content[0] as { text: string }).text).toContain("WARNING: overwriting prior probe/review tool call");
		expect(reviewResult.details).toMatchObject({ queued: true, overwritten: true, reviewRequestId: "review-request-2" });
	});

	it("accepts a scoped request, validates citations across fields, and returns its queued identifier", async () => {
		let received: unknown;
		const tool = createRequestReviewTool((request) => {
			received = request;
			return { reviewRequestId: "review-request-1", overwritten: false };
		}, (id) => id === "aaaaaaaaaaaa");
		const result = await tool.execute("call", {
			scope: "workflow",
			evidence: " [aaaaaaaaaaaa] the same trace was reconstructed twice. ",
			concern: " A reusable workflow representation may be missing. ",
			review_focus: " Determine whether (bbbbbbbbbbbb) contradicts the evidence. ",
			constraints: " Preserve user-facing behavior. ",
		});
		expect(received).toEqual({
			scope: "workflow",
			evidence: "[aaaaaaaaaaaa] the same trace was reconstructed twice.",
			concern: "A reusable workflow representation may be missing.",
			review_focus: "Determine whether (bbbbbbbbbbbb) contradicts the evidence.",
			constraints: "Preserve user-facing behavior.",
		});
		const text = (result.content[0] as { text: string }).text;
		expect(text).toContain("WARNING: memory bbbbbbbbbbbb not found");
		expect(text).toContain("call request_review again to replace the review");
		expect(text).toContain("Workflow review [review-request-1] will be started at the end of your turn.");
	});
});

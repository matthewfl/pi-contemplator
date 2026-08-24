import { describe, expect, it } from "vitest";
import { createNoInterventionTool, createRequestReviewTool, createSendProbeTool } from "../src/agents/contemplator/agent.js";
import { memoryReferenceIds } from "../src/memory-citations.js";
import { CONTEMPLATOR_SYSTEM, buildContemplatorSystemPrompt } from "../src/agents/contemplator/prompts.js";

describe("contemplator review request tool", () => {
	it("includes review escalation only when reviewers are enabled", () => {
		const enabled = buildContemplatorSystemPrompt(true);
		const disabled = buildContemplatorSystemPrompt(false);

		expect(enabled).toBe(CONTEMPLATOR_SYSTEM);
		expect(enabled).toContain("request_review");
		expect(enabled).toContain("recurring structural patterns");
		expect(enabled).toContain("later call replaces the earlier one");
		expect(enabled).toContain("send_probe, request_review, or no_intervention");
		expect(enabled).toContain("must finish every update");

		// Non-review improvements from the revision remain shared.
		expect(disabled).toContain("direct progress may be more informative than further hypothesis formation");
		expect(disabled).toContain("Activity measurements may support the diagnosis");

		// Only instructions specific to the structural-review tool are omitted.
		expect(disabled).not.toContain("request_review");
		expect(disabled).toContain("send_probe or no_intervention");
		expect(disabled.toLowerCase()).not.toContain("reviewer");
	});

	it("extracts delimited lists and bare hash-like memory ids", () => {
		expect(memoryReferenceIds("[abcdef0, aacc4455] (1234567890abcdef, bbbb1234) {cccccccccccc} bare aa11bb22 [abcdef0]"))
			.toEqual(["abcdef0", "aacc4455", "1234567890abcdef", "bbbb1234", "cccccccccccc", "aa11bb22"]);
	});

	it("does not mistake ordinary bare hex words, numbers, uppercase text, or embedded hex fragments for references", () => {
		expect(memoryReferenceIds("bare deadbeef and 12345678; ABCDEF123456 [abcdef] [1234567890abcdef0] xyz-aabb123g"))
			.toEqual([]);
	});

	it("warns for every unknown citation but still queues a replaceable probe", async () => {
		const tool = createSendProbeTool(
			() => ({ overwritten: false }),
			(id) => id === "aaaaaaaaaaaa",
		);
		const result = await tool.execute("probe-call", {
			question: "Compare [aaaaaaaaaaaa, bbbb1234], (bbbbbbbbbbbb), [abcdef0], and bare cc22dd33. What changed?",
		});
		const text = (result.content[0] as { text: string }).text;

		expect(text).not.toContain("memory aaaaaaaaaaaa not found");
		expect(text).toContain("WARNING: memory bbbb1234 not found");
		expect(text).toContain("WARNING: memory bbbbbbbbbbbb not found");
		expect(text).toContain("WARNING: memory abcdef0 not found");
		expect(text).toContain("WARNING: memory cc22dd33 not found");
		expect(text).toContain("use search_memories and recall");
		expect(text).toContain("call send_probe again to replace the probe");
		expect(text).toContain("Probe will be delivered at the end of your turn.");
		expect(result.details).toMatchObject({ queued: true, overwritten: false, memoryIds: ["aaaaaaaaaaaa", "bbbb1234", "bbbbbbbbbbbb", "abcdef0", "cc22dd33"] });
	});

	it("records an argument-free no-intervention final action", async () => {
		let selected = false;
		const tool = createNoInterventionTool(() => {
			selected = true;
			return { overwritten: true };
		});
		const result = await tool.execute("none-call", {});

		expect(selected).toBe(true);
		expect(tool.description).toContain("preferred default");
		expect(tool.description).toContain("argument-free");
		expect((result.content[0] as { text: string }).text).toContain("No intervention will be sent.");
		expect((result.content[0] as { text: string }).text).toContain("WARNING: overwriting prior probe/review/no_intervention tool call");
		expect(result.details).toEqual({ selected: true, overwritten: true });
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

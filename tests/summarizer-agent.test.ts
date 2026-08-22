import { describe, expect, it } from "vitest";
import { forceRequiredToolPayload, parseSummaryCitations, runSummarizer, SUMMARY_MAX_SOURCE_TOKEN_RATIO } from "../src/agents/summarizer/agent.js";
import { SUMMARIZER_CONTINUE, SUMMARIZER_SYSTEM } from "../src/agents/summarizer/prompts.js";
import { hashId } from "../src/ids.js";
import type { Entry } from "../src/session-ledger/index.js";

const A = "aaaaaaaaaaaa";
const B = "bbbbbbbbbbbb";
const C = "cccccccccccc";
const D = "dddddddddddd";
const E = "eeeeeeeeeeee";

function branch(): Entry[] {
	return [
		{ type: "message", id: "raw", message: { role: "user", content: "memory evidence" } },
		{
			type: "custom", id: "obs", customType: "om.observations.recorded",
			data: {
				coversUpToId: "raw",
				// E is the protected newest memory; A-D remain eligible for tests.
				observations: [A, B, C, D, E].map((id, index) => ({
					id, content: `Durable source ${index + 1} with enough detailed evidence to compress safely.`, timestamp: `2026-01-0${index + 1} 10:00`, relevance: "high", retention: "contextual", sourceEntryIds: ["raw"], tokenCount: 100,
				})),
			},
		},
	];
}

function fakeLoop(handler: (invocation: number, context: any, config: any) => Promise<void> | void): any {
	let invocation = 0;
	return ((_prompts: any[], context: any, config: any) => ({
		async *[Symbol.asyncIterator]() {},
		result: async () => { await handler(invocation++, context, config); return []; },
	})) as any;
}

function tool(context: any, name: string): any {
	const found = context.tools.find((candidate: any) => candidate.name === name);
	if (!found) throw new Error(`missing ${name}`);
	return found;
}

async function finish(context: any): Promise<void> {
	await tool(context, "done").execute("done-1", {});
	await tool(context, "done").execute("done-2", {});
}

const base = { model: { contextWindow: 500_000, api: "openai-responses" } as any, apiKey: "test", targetTokens: 100, newPoolMaxTokens: 1, getBranch: branch };

describe("summarizer citation parser", () => {
	const known = new Set([A, B, C]);
	it.each([
		`Combined [${A}] and [${B}].`,
		`Combined [${A} ${B}].`,
		`Combined [${A},${B}].`,
		`Combined [${A}, ${B},${C}].`,
	])("accepts strict citation syntax: %s", (text) => {
		const parsed = parseSummaryCitations(text, known);
		expect(parsed).not.toHaveProperty("error");
		if (!("error" in parsed)) expect(parsed.sourceMemoryIds).toEqual(text.includes(C) ? [A, B, C] : [A, B]);
	});

	it.each([
		`bad []`, `bad [${A},]`, `bad [,${A}]`, `bad [${A},,${B}]`, `bad [${A} prose]`, `bad [${A.toUpperCase()}]`, `bad [${A}`, `bad ${A}`, `bad [${A.slice(0, 11)}]`,
	])("rejects malformed or floating citation syntax: %s", (text) => {
		expect(parseSummaryCitations(text, known)).toHaveProperty("error");
	});

	it("allows unknown hash-like prose with a warning but still rejects real memories outside citations", () => {
		const parsed = parseSummaryCitations(`The placeholder deadbeefdead is ordinary text [${A}, ${B}].`, known);
		expect(parsed).not.toHaveProperty("error");
		if (!("error" in parsed)) expect(parsed.warnings).toEqual([expect.stringContaining("deadbeefdead")]);
		expect(parseSummaryCitations(`The real memory ${A} is unbracketed [${B}, ${C}].`, known)).toMatchObject({ error: expect.stringContaining(A) });
	});

	it("rejects unknown cited ids atomically", () => {
		expect(parseSummaryCitations(`Combined [${A}, ${D}].`, known)).toMatchObject({ error: expect.stringContaining(D) });
	});
});

describe("summarizer agent", () => {
	it("uses provider-native required tool controls", () => {
		expect(forceRequiredToolPayload({}, "openai-responses")).toMatchObject({ tool_choice: "required" });
		expect(forceRequiredToolPayload({}, "anthropic-messages")).toMatchObject({ tool_choice: { type: "any" } });
		expect(forceRequiredToolPayload({ config: {} }, "google-generative-ai")).toMatchObject({ config: { toolConfig: { functionCallingConfig: { mode: "ANY" } } } });
	});

	it("retains conservative, citation-driven prompt priorities", () => {
		expect(SUMMARIZER_SYSTEM).toContain("ONLY information");
		expect(SUMMARIZER_SYSTEM).toContain("anything you distort");
		expect(SUMMARIZER_SYSTEM).toContain("User intent should almost never be summarized");
		expect(SUMMARIZER_SYSTEM).toContain("only the OLD memory pool");
		expect(SUMMARIZER_SYSTEM).toContain("Start with the oldest records");
		expect(SUMMARIZER_SYSTEM).toContain("repetitive low-value history");
		expect(SUMMARIZER_SYSTEM).toContain("completed units of work");
		expect(SUMMARIZER_SYSTEM).toContain("source-supported tips");
		expect(SUMMARIZER_SYSTEM).toContain("future agent can recall citations");
		expect(SUMMARIZER_SYSTEM).toContain("Examples:");
		expect(SUMMARIZER_SYSTEM).toContain("BAD:");
		expect(SUMMARIZER_SYSTEM).toContain("GOOD:");
		expect(SUMMARIZER_SYSTEM).toContain("Tools:");
		expect(SUMMARIZER_SYSTEM).toContain("fix_summary corrects");
		expect(SUMMARIZER_SYSTEM).toContain("Call done alone");
		expect(SUMMARIZER_SYSTEM).toContain("Prefer faithful useful compression");
		expect(SUMMARIZER_CONTINUE).toContain("IMPORTANT!!!!");
		expect(SUMMARY_MAX_SOURCE_TOKEN_RATIO).toBe(0.8);
	});

	it("injects the full system prompt once and defaults reasoning to minimal", async () => {
		await runSummarizer({ ...base, model: { ...base.model, reasoning: true }, agentLoop: fakeLoop(async (_n, context, config) => {
			expect(context.systemPrompt).toBe(SUMMARIZER_SYSTEM);
			expect(JSON.stringify(context.messages)).not.toContain(SUMMARIZER_SYSTEM);
			expect(config.reasoning).toBe("minimal");
			await tool(context, "done").execute("d1", {});
			await tool(context, "done").execute("d2", {});
		}) });
	});

	it("does not duplicate a prompt when an agent-loop wrapper clones its result", async () => {
		let invocation = 0;
		let secondContext: any;
		const cloningLoop = ((prompts: any[], context: any) => {
			const current = invocation++;
			if (current === 1) secondContext = context;
			return {
				async *[Symbol.asyncIterator]() {},
				result: async () => {
					if (current === 1) await finish(context);
					return [structuredClone(prompts[0])];
				},
			};
		}) as any;
		await runSummarizer({ ...base, agentLoop: cloningLoop });
		const firstRunPrompts = secondContext.messages.filter((message: any) => message.role === "user" && JSON.stringify(message).includes("preceding summarize call"));
		expect(firstRunPrompts).toHaveLength(1);
		expect(secondContext.messages.filter((message: any) => JSON.stringify(message).includes("summarizer-example"))).toHaveLength(2);
	});

	it("creates a cited summary, consumes its sources, and double-confirms done", async () => {
		const content = `The two sources establish one durable result [${A}, ${B}].`;
		const result = await runSummarizer({ ...base, agentLoop: fakeLoop(async (_n, context) => {
			const receipt = await tool(context, "summarize").execute("s", { summaries: [content] });
			expect(receipt.content[0].text).toContain("summary created successfully");
			expect(receipt.content[0].text).toContain(`summary created successfully [${hashId(content)}]; memories [${A}, ${B}] are removed from the visible pool`);
			const first = await tool(context, "done").execute("d1", {});
			expect(first.details.confirmationRequired).toBe(true);
			expect(first.content[0].text).toContain("Current-run summaries: 1");
			expect(first.content[0].text).toContain("newly consumed memories: 2");
			await tool(context, "done").execute("d2", {});
		}) });
		expect(result.completed).toBe(true);
		expect(result.commit?.summaries).toEqual([{ id: hashId(content), content, timestamp: "2026-01-02 10:00", sourceMemoryIds: [A, B], consumedMemoryIds: [A, B], tokenCount: expect.any(Number) }]);
		expect(result.commit?.metrics).toMatchObject({ consumedMemoryCount: 2, sourceTokens: 200 });
		expect(result.commit?.completedWithDone).toBe(true);
	});

	it("rejects a candidate with fewer than two newly consumable sources", async () => {
		const result = await runSummarizer({ ...base, agentLoop: fakeLoop(async (_n, context) => {
			const receipt = await tool(context, "summarize").execute("s", { keep_verbatim: [A], summaries: [`Unsafe [${A}, ${B}].`] });
			expect(receipt.content[0].text).toContain("only 1 newly consumable memory");
			await finish(context);
		}) });
		expect(result.commit).toBeUndefined();
		expect(result.completed).toBe(true);
	});

	it("rejects boundary-length summaries with keep-verbatim guidance", async () => {
		const tooLong = `${"detailed wording ".repeat(55)}[${A}, ${B}].`;
		const result = await runSummarizer({ ...base, agentLoop: fakeLoop(async (_n, context) => {
			const receipt = await tool(context, "summarize").execute("s", { summaries: [tooLong] });
			expect(receipt.content[0].text).toContain("exceeds the 0.8 reduction limit");
			expect(receipt.content[0].text).toContain("keep the source memories verbatim instead");
			const firstDone = await tool(context, "done").execute("d1", {});
			expect(firstDone.content[0].text).toContain("Current-run summaries: 0");
			await tool(context, "done").execute("d2", {});
		}) });
		expect(result.commit).toBeUndefined();
	});

	it("processes candidates sequentially and does not double-consume", async () => {
		const first = `First durable result [${A}, ${B}].`;
		const second = `Second result cites the first [${hashId(first)}, ${C}, ${D}].`;
		const result = await runSummarizer({ ...base, agentLoop: fakeLoop(async (_n, context) => {
			const receipt = await tool(context, "summarize").execute("s", { summaries: [first, second] });
			expect(receipt.content[0].text).toContain("current-run summary and remains verbatim");
			await finish(context);
		}) });
		expect(result.commit?.summaries.map((summary) => summary.consumedMemoryIds)).toEqual([[A, B], [C, D]]);
	});

	it("describes recalled, previously consumed sources as summarized and no longer visible", async () => {
		const priorContent = `Prior result [${A}, ${B}].`;
		const priorId = hashId(priorContent);
		const consumedBranch = (): Entry[] => [
			...branch(),
			{
				type: "custom", id: "prior-summary", customType: "om.summarizer.commit",
				data: {
					version: 1,
					summaries: [{ id: priorId, content: priorContent, timestamp: "2026-01-02 10:00", sourceMemoryIds: [A, B], consumedMemoryIds: [A, B], tokenCount: 10 }],
					coversUpToId: "obs", createdAt: 1, completedWithDone: true,
					metrics: { consumedMemoryCount: 2, sourceTokens: 200, summaryTokens: 10, estimatedTokenReduction: 190 },
				},
			},
		];
		await runSummarizer({ ...base, getBranch: consumedBranch, agentLoop: fakeLoop(async (_n, context) => {
			await tool(context, "recall").execute("r", { id: A });
			const receipt = await tool(context, "summarize").execute("s", { summaries: [`Current result with prior provenance [${A}, ${C}, ${D}].`] });
			expect(receipt.content[0].text).toContain(`memory [${A}] was already summarized by [${priorId}] and is no longer visible`);
			expect(receipt.content[0].text).not.toContain(`memory [${A}] is not in the eligible old pool and remains visible`);
			await finish(context);
		}) });
	});

	it("atomically fixes a draft, releasing omitted sources and assigning a new id", async () => {
		const oldText = `Old result [${A}, ${B}].`;
		const newText = `Corrected result [${B}, ${C}].`;
		const result = await runSummarizer({ ...base, agentLoop: fakeLoop(async (_n, context) => {
			await tool(context, "summarize").execute("s", { summaries: [oldText] });
			const receipt = await tool(context, "fix_summary").execute("f", { summary_id: hashId(oldText), updated_summary: newText });
			expect(receipt.content[0].text).toContain(`new summary created [${hashId(newText)}]`);
			await finish(context);
		}) });
		expect(result.commit?.summaries).toHaveLength(1);
		expect(result.commit?.summaries[0]).toMatchObject({ id: hashId(newText), consumedMemoryIds: [B, C] });
	});

	it("rolls back a failed fix", async () => {
		const oldText = `Valid result [${A}, ${B}].`;
		const result = await runSummarizer({ ...base, agentLoop: fakeLoop(async (_n, context) => {
			await tool(context, "summarize").execute("s", { summaries: [oldText] });
			const receipt = await tool(context, "fix_summary").execute("f", { summary_id: hashId(oldText), updated_summary: `Broken [${A}].` });
			expect(receipt.content[0].text).toContain("existing summary");
			await finish(context);
		}) });
		expect(result.commit?.summaries[0].id).toBe(hashId(oldText));
	});

	it("deletes only current-run drafts and reports not-found explicitly", async () => {
		const content = `Temporary result [${A}, ${B}].`;
		const result = await runSummarizer({ ...base, agentLoop: fakeLoop(async (_n, context) => {
			await tool(context, "summarize").execute("s", { summaries: [content] });
			const deleted = await tool(context, "fix_summary").execute("f", { summary_id: hashId(content), delete: true });
			expect(deleted.content[0].text).toContain("deleted successfully");
			const repeated = await tool(context, "fix_summary").execute("f2", { summary_id: hashId(content), delete: true });
			expect(repeated.content[0].text).toContain("was not found");
			await finish(context);
		}) });
		expect(result.commit).toBeUndefined();
	});

	it("preserves accepted summaries when the model never calls done", async () => {
		const content = `Useful partial progress [${A}, ${B}].`;
		const result = await runSummarizer({ ...base, agentLoop: fakeLoop(async (invocation, context) => {
			if (invocation === 0) await tool(context, "summarize").execute("s", { summaries: [content] });
		}) });
		expect(result.commit?.summaries[0].id).toBe(hashId(content));
		expect(result.commit?.completedWithDone).toBe(false);
	});

	it("forces tool choice after an initial prose-only stop", async () => {
		const configs: any[] = [];
		await runSummarizer({ ...base, model: { ...base.model, reasoning: true }, agentLoop: fakeLoop(async (invocation, context, config) => {
			configs.push(config);
			if (invocation === 1) await finish(context);
		}) });
		expect(configs[0].toolChoice).toBeUndefined();
		expect(configs[1].toolChoice).toBe("required");
		expect(configs[1].reasoning).toBe("minimal");
		expect(configs[1].onPayload({})).toMatchObject({ tool_choice: "required" });
	});
});

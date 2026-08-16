import { describe, expect, it, vi } from "vitest";
import { runLibrarian } from "../src/agents/librarian/agent.js";
import { hashId } from "../src/ids.js";
import { OM_LIBRARIAN_COMMIT, type Entry } from "../src/session-ledger/index.js";

const A = "aaaaaaaaaaaa";
const B = "bbbbbbbbbbbb";
const C = "cccccccccccc";
const D = "dddddddddddd";

function entries(extra: Entry[] = []): Entry[] {
	return [
		{ type: "message", id: "raw-1", message: { role: "user", content: [{ type: "text", text: "alpha beta" }] } },
		{
			type: "custom", id: "obs-entry", customType: "om.observations.recorded",
			data: {
				coversUpToId: "raw-1",
				observations: [
					{ id: A, content: "Old alpha implementation detail.", timestamp: "2026-01-01 10:00", relevance: "medium", retention: "contextual", sourceEntryIds: ["raw-1"], tokenCount: 20 },
					{ id: B, content: "Beta command output was consumed by the result.", timestamp: "2026-01-02 10:00", relevance: "low", retention: "ephemeral", sourceEntryIds: ["raw-1"], tokenCount: 20 },
					{ id: C, content: "Work moved away from alpha after completion.", timestamp: "2026-01-03 10:00", relevance: "high", retention: "contextual", sourceEntryIds: ["raw-1"], tokenCount: 20 },
				],
			},
		},
		...extra,
	] as Entry[];
}

function fakeAgentLoop(handler: (invocation: number, prompts: any[], context: any, config: any) => Promise<void> | void): any {
	let invocation = 0;
	return ((prompts: any[], context: any, config: any) => ({
		async *[Symbol.asyncIterator]() {},
		result: async () => {
			await handler(invocation++, prompts, context, config);
			return [];
		},
	})) as any;
}

function tool(context: any, name: string): any {
	const found = context.tools.find((candidate: any) => candidate.name === name);
	if (!found) throw new Error(`Missing tool ${name}`);
	return found;
}

const base = {
	model: { contextWindow: 100_000 } as any,
	apiKey: "test",
	targetTokens: 10,
};

describe("librarian agent", () => {
	it("completes an explicit no-action pass and emits pressure guidance", async () => {
		let prompt = "";
		let configSeen: any;
		const loop = fakeAgentLoop(async (_invocation, prompts, context, config) => {
			prompt = prompts[0].content[0].text;
			configSeen = config;
			await tool(context, "done").execute("done-1", { summary: "No safe changes." });
		});
		const result = await runLibrarian({ ...base, getBranch: () => entries(), agentLoop: loop });
		expect(result.completed).toBe(true);
		expect(result.commit).toMatchObject({ coversUpToId: "obs-entry", reflections: [], actions: [], summary: "No safe changes." });
		expect(prompt).toContain("complete eligible set; sampling not used");
		expect(prompt).toContain("MEMORY PRESSURE ADVISORY");
		expect(prompt).toContain("guidance, not a quota");
		expect(configSeen.toolExecution).toBe("parallel");
		expect(configSeen.beforeToolCall).toBeTypeOf("function");
		await expect(configSeen.beforeToolCall({
			toolCall: { name: "done" },
			context: { messages: [{ role: "assistant", content: [{ type: "toolCall", name: "make_inactive" }, { type: "toolCall", name: "done" }] }] },
		})).resolves.toMatchObject({ block: true });
	});

	it("records an atomic reflection with explicit source deletion reason", async () => {
		const content = "Alpha and beta details were consumed into a completed result.";
		const loop = fakeAgentLoop(async (_invocation, _prompts, context) => {
			const receipt = await tool(context, "record_reflection").execute("r1", {
				content,
				sourceMemoryIds: [A, B],
				sourceDisposition: "delete",
				deleteReason: "The reflection preserves the completed result; raw details are temporal.",
				rationale: "Combine related completion evidence.",
			});
			expect(receipt.content[0].text).toContain("Staged reflection");
			await tool(context, "done").execute("d1", { summary: "Combined temporal details." });
		});
		const result = await runLibrarian({ ...base, getBranch: () => entries(), agentLoop: loop });
		const reflectionId = hashId(content);
		expect(result.commit?.reflections).toEqual([expect.objectContaining({ id: reflectionId, sourceMemoryIds: [A, B] })]);
		expect(result.commit?.actions).toEqual([{
			type: "delete",
			memoryIds: [A, B],
			reason: "The reflection preserves the completed result; raw details are temporal.",
			becauseOfMemoryIds: [reflectionId],
			replacementMemoryIds: [reflectionId],
			createdAt: expect.any(Number),
		}]);
	});

	it("requires deleteReason separately from reflection rationale", async () => {
		const loop = fakeAgentLoop(async (_invocation, _prompts, context) => {
			const receipt = await tool(context, "record_reflection").execute("r1", {
				content: "Invalid deletion reflection.", sourceMemoryIds: [A, B], sourceDisposition: "delete", rationale: "Not a deletion reason.",
			});
			expect(receipt.content[0].text).toContain("requires deleteReason");
			await tool(context, "done").execute("d1", { summary: "Rejected unsafe reflection." });
		});
		const result = await runLibrarian({ ...base, getBranch: () => entries(), agentLoop: loop });
		expect(result.commit?.reflections).toEqual([]);
		expect(result.commit?.actions).toEqual([]);
	});

	it("partially accepts target ids but rejects invalid shared evidence atomically", async () => {
		const loop = fakeAgentLoop(async (_invocation, _prompts, context) => {
			const partial = await tool(context, "delete_memories").execute("x1", {
				memoryIds: [A, "dddddddddddd"], becauseOfObservationIds: [C], reason: "Alpha detail is obsolete.",
			});
			expect(partial.details).toMatchObject({ accepted: [A], rejected: ["dddddddddddd"] });
			const rejected = await tool(context, "make_inactive").execute("x2", {
				memoryIds: [B], becauseOfObservationIds: ["eeeeeeeeeeee"], recallIf: "Recall beta",
			});
			expect(rejected.content[0].text).toContain("Rejected entire call");
			await tool(context, "done").execute("d1", { summary: "Applied validated targets only." });
		});
		const result = await runLibrarian({ ...base, getBranch: () => entries(), agentLoop: loop });
		expect(result.commit?.actions).toHaveLength(1);
		expect(result.commit?.actions[0]).toMatchObject({ type: "delete", memoryIds: [A] });
	});

	it("discards staged mutations after bounded ordinary-text stops without done", async () => {
		const loop = fakeAgentLoop(async (invocation, _prompts, context) => {
			if (invocation === 0) await tool(context, "make_inactive").execute("x1", { memoryIds: [A], becauseOfObservationIds: [C], recallIf: "Recall when alpha resumes" });
		});
		const result = await runLibrarian({ ...base, getBranch: () => entries(), agentLoop: loop });
		expect(result.completed).toBe(false);
		expect(result.commit).toBeUndefined();
	});

	it("reactivates an ephemeral alias cohort and returns full bodies", async () => {
		const inactiveCommit: Entry = {
			type: "custom", id: "lib-old", customType: OM_LIBRARIAN_COMMIT,
			data: {
				version: 1, reflections: [], coversUpToId: "obs-entry", summary: "Archived alpha and beta.", createdAt: 1,
				actions: [{ type: "makeInactive", memoryIds: [A, B], recallIf: "Recall when alpha work resumes", becauseOfMemoryIds: [C], createdAt: 1 }],
			},
		};
		const resumedObservation: Entry = {
			type: "custom", id: "obs-entry-2", customType: "om.observations.recorded",
			data: { coversUpToId: "raw-1", observations: [{ id: D, content: "User resumed alpha work.", timestamp: "2026-01-04 10:00", relevance: "high", retention: "contextual", sourceEntryIds: ["raw-1"], tokenCount: 10 }] },
		};
		let receipt = "";
		const loop = fakeAgentLoop(async (_invocation, prompts, context) => {
			expect(prompts[0].content[0].text).toContain("[inactive_1] (2 memories) Recall when alpha work resumes");
			const result = await tool(context, "make_active").execute("x1", { inactiveRefs: ["inactive_1"], becauseOfObservationIds: [D] });
			receipt = result.content[0].text;
			await tool(context, "done").execute("d1", { summary: "Restored alpha cohort." });
		});
		const result = await runLibrarian({ ...base, getBranch: () => entries([inactiveCommit, resumedObservation]), agentLoop: loop });
		expect(receipt).toContain("Old alpha implementation detail.");
		expect(receipt).toContain("Beta command output");
		expect(result.commit?.actions[0]).toMatchObject({ type: "makeActive", memoryIds: [A, B], becauseOfMemoryIds: [D] });
	});
});

import { describe, expect, it, vi } from "vitest";
import { buildLibrarianPrompt, runLibrarian } from "../src/agents/librarian/agent.js";
import { LIBRARIAN_SYSTEM } from "../src/agents/librarian/prompts.js";
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

async function confirmDone(context: any): Promise<{ first: any; second: any }> {
	const done = tool(context, "done");
	const first = await done.execute("done-first", {});
	const second = await done.execute("done-confirm", {});
	return { first, second };
}

const base = {
	model: { contextWindow: 100_000 } as any,
	apiKey: "test",
	targetTokens: 10,
};

describe("librarian agent", () => {
	it("preserves the durability, abstraction, novelty, and provenance gates", () => {
		expect(LIBRARIAN_SYSTEM).toContain("ONLY information the assistant will have");
		expect(LIBRARIAN_SYSTEM).toContain("Over-reflection is also memory distortion");
		expect(LIBRARIAN_SYSTEM).toContain("future-agent utility test");
		expect(LIBRARIAN_SYSTEM).toContain("Abstraction gate");
		expect(LIBRARIAN_SYSTEM).toContain("Do not lightly reword an existing reflection");
		expect(LIBRARIAN_SYSTEM).toContain("False or inflated source ids are dangerous");
		expect(LIBRARIAN_SYSTEM).toContain("High and critical observations deserve careful review, not automatic reflection");
		expect(LIBRARIAN_SYSTEM).toContain("Zero is better than a weak abstraction");
		expect(LIBRARIAN_SYSTEM).toContain("Delete versus make inactive");
		expect(LIBRARIAN_SYSTEM).toContain("Old raw tool output after its meaningful result");
		expect(LIBRARIAN_SYSTEM).toContain("How a particular bug was diagnosed and fixed");
		expect(LIBRARIAN_SYSTEM).toContain("Inactive memory should have a plausible future retrieval trigger");
		expect(LIBRARIAN_SYSTEM).toContain("reflection completely replaces");
		expect(LIBRARIAN_SYSTEM).toContain("Link that reflection as the replacement");
	});

	it("labels sampled pressure as a whole-pool signal rather than a visible quota", () => {
		const prompt = buildLibrarianPrompt({
			activeMemories: [], inactiveCohorts: [], aliasMembers: new Map(), sampled: true,
			eligibleCount: 100, selectedCount: 25, eligibleTokens: 40_000, selectedTokens: 10_000, budgetTokens: 10_000,
		}, {
			activeCount: 90, activeTokens: 36_000, targetTokens: 10_000, contextWindow: 20_000,
			newCount: 10, newTokens: 2_000, activeTokenSizes: [400, 400, 400],
		});
		expect(prompt).toContain("Visible active memories this run: 0 selected from 90 active memories");
		expect(prompt).toContain("WHOLE-POOL MEMORY PRESSURE ADVISORY");
		expect(prompt).toContain("complete active pool—not just the subset visible in this run");
		expect(prompt).toContain("Never compensate for unseen memories");
		expect(prompt).not.toContain("SEVERE");
		const memoryStart = prompt.indexOf("<memory_records>");
		const activeStart = prompt.indexOf("ACTIVE MEMORIES", memoryStart);
		const memoryEnd = prompt.indexOf("</memory_records>", activeStart);
		const repeatedInstructions = prompt.indexOf("INSTRUCTIONS REPEATED AFTER MEMORY RECORDS", memoryEnd);
		const repeatedMetadata = prompt.indexOf("RUN METADATA AND PRESSURE ADVISORY REPEATED AFTER INSTRUCTIONS", repeatedInstructions);
		expect(memoryStart).toBeGreaterThanOrEqual(0);
		expect(activeStart).toBeGreaterThan(memoryStart);
		expect(memoryEnd).toBeGreaterThan(activeStart);
		expect(repeatedInstructions).toBeGreaterThan(memoryEnd);
		expect(repeatedMetadata).toBeGreaterThan(repeatedInstructions);
		expect(prompt.slice(repeatedInstructions, repeatedMetadata)).toContain(LIBRARIAN_SYSTEM);
		expect(prompt.slice(repeatedMetadata)).toContain("Visible active memories this run: 0 selected from 90 active memories");
		expect(prompt.slice(repeatedMetadata)).toContain("WHOLE-POOL MEMORY PRESSURE ADVISORY");
	});

	it("completes an explicit no-action pass and emits pressure guidance", async () => {
		let prompt = "";
		let configSeen: any;
		const transcriptSnapshots: Array<readonly unknown[]> = [];
		let firstDone: any;
		const loop = fakeAgentLoop(async (_invocation, _prompts, context, config) => {
			prompt = JSON.stringify(context.messages);
			configSeen = config;
			({ first: firstDone } = await confirmDone(context));
		});
		const result = await runLibrarian({
			...base,
			getBranch: () => entries(),
			agentLoop: loop,
			onMessages: (messages) => transcriptSnapshots.push(messages),
		});
		expect(result.completed).toBe(true);
		expect(transcriptSnapshots.length).toBeGreaterThanOrEqual(2);
		expect(transcriptSnapshots[0]?.[0]).toMatchObject({ role: "user" });
		expect(result.commit).toMatchObject({ coversUpToId: "obs-entry", reflections: [], actions: [], summary: expect.stringContaining("Confirmed 0 registered curation actions") });
		expect(firstDone.details).toMatchObject({ completed: false, confirmationRequired: true, registeredActions: 0, projectedActiveCount: 3, projectedTokens: 60, targetTokens: 10 });
		expect(firstDone.content[0].text).toContain("call done again now");
		expect(firstDone.content[0].text).toContain("no curation actions were registered");
		expect(prompt).toContain("complete eligible set; sampling not used");
		expect(prompt).toContain("WHOLE-POOL MEMORY PRESSURE ADVISORY");
		expect(prompt).toContain("not a quota for this sample");
		expect(prompt).toContain("Never compensate for unseen memories");
		expect(prompt).toContain("librarian-record-reflection-example");
		expect(prompt).toContain('"type":"toolCall"');
		expect(prompt).toContain('"role":"toolResult"');
		expect(prompt).toContain("Illustrative receipt: staged reflection");
		expect(configSeen.toolExecution).toBe("parallel");
		expect(configSeen.beforeToolCall).toBeTypeOf("function");
		await expect(configSeen.beforeToolCall({
			toolCall: { name: "done" },
			context: { messages: [{ role: "assistant", content: [{ type: "toolCall", name: "make_inactive" }, { type: "toolCall", name: "done" }] }] },
		})).resolves.toMatchObject({ block: true });
	});

	it("publishes in-progress thinking before the librarian stream settles", async () => {
		const snapshots: Array<readonly any[]> = [];
		const loop = ((_prompts: any[], context: any) => ({
			async *[Symbol.asyncIterator]() {
				yield {
					type: "message_update",
					message: { role: "assistant", content: [{ type: "thinking", thinking: "Comparing durable evidence." }] },
					assistantMessageEvent: {},
				};
			},
			result: async () => {
				await confirmDone(context);
				return [{ role: "assistant", content: [{ type: "text", text: "Finished." }] }];
			},
		})) as any;

		const result = await runLibrarian({ ...base, getBranch: () => entries(), agentLoop: loop, onMessages: (messages) => snapshots.push(messages) });
		expect(result.completed).toBe(true);
		expect(snapshots.some((messages) => messages.some((message) => message.content?.some?.((part: any) => part.thinking === "Comparing durable evidence.")))).toBe(true);
		expect(snapshots.at(-1)?.some((message) => message.content?.some?.((part: any) => part.text === "Finished."))).toBe(true);
	});

	it("records an atomic reflection with explicit source deletion reason", async () => {
		const content = "Alpha and beta details were consumed into a completed result.";
		const loop = fakeAgentLoop(async (_invocation, _prompts, context) => {
			const receipt = await tool(context, "record_reflection").execute("r1", {
				content,
				sourceMemoryIds: [A, B],
				deleteReason: "The reflection preserves the completed result; raw details are temporal.",
			});
			expect(receipt.content[0].text).toContain("Staged reflection");
			await confirmDone(context);
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

	it("defaults reflection sources to active and reports their outcome", async () => {
		const content = "Alpha and beta provide a durable combined fact.";
		let receipt: any;
		const loop = fakeAgentLoop(async (_invocation, _prompts, context) => {
			receipt = await tool(context, "record_reflection").execute("r-default", {
				content,
				sourceMemoryIds: [A, B],
			});
			await confirmDone(context);
		});
		const result = await runLibrarian({ ...base, getBranch: () => entries(), agentLoop: loop });
		expect(receipt.details).toMatchObject({ sourceDisposition: "keepActive" });
		expect(receipt.content[0].text).toContain(`Source memories [${A}, ${B}] remain active`);
		expect(receipt.content[0].text).toContain("make_inactive or delete_memories");
		expect(result.commit?.reflections).toEqual([expect.objectContaining({ content })]);
		expect(result.commit?.actions).toEqual([]);
	});

	it("rejects conflicting inferred source handling", async () => {
		const loop = fakeAgentLoop(async (_invocation, _prompts, context) => {
			const receipt = await tool(context, "record_reflection").execute("r1", {
				content: "Invalid source-handling reflection.", sourceMemoryIds: [A, B],
				sourceRecallIf: "Recall later", deleteReason: "Replaced completely",
			});
			expect(receipt.content[0].text).toContain("mutually exclusive");
			await confirmDone(context);
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
			await confirmDone(context);
		});
		const result = await runLibrarian({ ...base, getBranch: () => entries(), agentLoop: loop });
		expect(result.commit?.actions).toHaveLength(1);
		expect(result.commit?.actions[0]).toMatchObject({ type: "delete", memoryIds: [A] });
	});

	it("discards staged mutations and fairness changes after bounded stops without done", async () => {
		const fairness = new Map();
		const loop = fakeAgentLoop(async () => {});
		const result = await runLibrarian({ ...base, model: { contextWindow: 80 } as any, getBranch: () => entries(), agentLoop: loop, fairness, random: () => 0.5 });
		expect(result.completed).toBe(false);
		expect(result.sample?.sampled).toBe(true);
		expect(result.commit).toBeUndefined();
		expect(fairness.size).toBe(0);
	});

	it("records fairness only after a sampled pass calls done", async () => {
		const fairness = new Map();
		const loop = fakeAgentLoop(async (_invocation, _prompts, context) => {
			await confirmDone(context);
		});
		const result = await runLibrarian({ ...base, model: { contextWindow: 80 } as any, getBranch: () => entries(), agentLoop: loop, fairness, random: () => 0.5, now: 123 });
		expect(result.completed).toBe(true);
		expect(result.sample?.sampled).toBe(true);
		expect(fairness.size).toBeGreaterThan(0);
		expect(Array.from(fairness.values())).toEqual(expect.arrayContaining([expect.objectContaining({ lastSampledAt: 123, sampleCount: 1 })]));
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
		const loop = fakeAgentLoop(async (_invocation, _prompts, context) => {
			expect(JSON.stringify(context.messages)).toContain("[inactive_1] (2 memories) Recall when alpha work resumes");
			const result = await tool(context, "make_active").execute("x1", { inactiveRefs: ["inactive_1"], becauseOfObservationIds: [D] });
			receipt = result.content[0].text;
			await confirmDone(context);
		});
		const result = await runLibrarian({ ...base, getBranch: () => entries([inactiveCommit, resumedObservation]), agentLoop: loop });
		expect(receipt).toContain("Old alpha implementation detail.");
		expect(receipt).toContain("Beta command output");
		expect(result.commit?.actions[0]).toMatchObject({ type: "makeActive", memoryIds: [A, B], becauseOfMemoryIds: [D] });
	});

	it("reactivates the same normalized cohort by durable memory id as by alias", async () => {
		const inactiveCommit: Entry = {
			type: "custom", id: "lib-normalized", customType: OM_LIBRARIAN_COMMIT,
			data: {
				version: 1, reflections: [], coversUpToId: "obs-entry", summary: "Archived related memories.", createdAt: 1,
				actions: [
					{ type: "makeInactive", memoryIds: [A], recallIf: "Recall   alpha work", becauseOfMemoryIds: [C], createdAt: 1 },
					{ type: "makeInactive", memoryIds: [B], recallIf: "Ｒｅｃａｌｌ alpha work", becauseOfMemoryIds: [C], createdAt: 1 },
				],
			},
		};
		const resumedObservation: Entry = {
			type: "custom", id: "obs-entry-normalized", customType: "om.observations.recorded",
			data: { coversUpToId: "raw-1", observations: [{ id: D, content: "User resumed alpha work.", timestamp: "2026-01-04 10:00", relevance: "high", retention: "contextual", sourceEntryIds: ["raw-1"], tokenCount: 10 }] },
		};
		const loop = fakeAgentLoop(async (_invocation, _prompts, context) => {
			await tool(context, "make_active").execute("x1", { inactiveRefs: [A], becauseOfObservationIds: [D] });
			await confirmDone(context);
		});

		const result = await runLibrarian({ ...base, getBranch: () => entries([inactiveCommit, resumedObservation]), agentLoop: loop });
		expect(result.commit?.actions[0]).toMatchObject({ type: "makeActive", memoryIds: [A, B] });
	});
});

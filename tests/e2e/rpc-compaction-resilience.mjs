#!/usr/bin/env node
import { ModelServer, assert, createWorkspace, launchPi, omSettings, prepareWorkspace, sendSse, stopPi, textOf, waitFor } from "./harness.mjs";

const MARKER = "E2E_REPEATED_COMPACTION_MEMORY";
const CONTINUE_ONE = "Continue after first compaction and perform the second compaction.";
const CONTINUE_TWO = "After the second compaction, search for and recall the original durable memory.";
const started = Date.now();
const log = (text) => console.log(`[compaction-resilience-e2e +${((Date.now() - started) / 1000).toFixed(1)}s] ${text}`);

const state = { main: 0, observers: 0, searchedId: undefined, recalledExactSource: false };
const server = new ModelServer(async (request, res) => {
	const hasTool = (request.body.messages ?? []).some((message) => message.role === "tool");
	if (request.role === "observer") {
		state.observers++;
		if (hasTool) return sendSse(res, { text: "observer complete" });
		const ids = [...request.text.matchAll(/Source entry id:\s*([\w-]+)/g)].map((match) => match[1]);
		const sourceEntryIds = ids.length ? [ids.at(-1)] : [];
		if (!sourceEntryIds.length) return sendSse(res, { text: "nothing valid to observe" });
		return sendSse(res, { tool: { id: `observe-${state.observers}`, name: "record_observations", arguments: { observations: [{ timestamp: "2026-08-15 02:00", content: `${MARKER}: original evidence must survive repeated folds`, relevance: "high", sourceEntryIds }] } } });
	}
	assert(request.role === "main", `Unexpected role during compaction resilience test: ${request.role}`);
	state.main++;
	const toolResults = (request.body.messages ?? []).filter((message) => message.role === "tool").map((message) => typeof message.content === "string" ? message.content : JSON.stringify(message.content)).join("\n");
	if (state.main === 1) return sendSse(res, { tool: { id: "seed-memory", name: "bash", arguments: { command: `echo ${MARKER}` } }, outputTokens: 500 });
	if (state.main === 2) return sendSse(res, { tool: { id: "compact-one", name: "compact_context", arguments: { short_continuation_prompt: CONTINUE_ONE } } });
	if (state.main === 3) {
		assert(request.text.includes(CONTINUE_ONE), "First authored continuation was absent after compaction");
		return sendSse(res, { tool: { id: "between-folds", name: "bash", arguments: { command: "echo between-compactions" } }, outputTokens: 500 });
	}
	if (state.main === 4) return sendSse(res, { tool: { id: "compact-two", name: "compact_context", arguments: { short_continuation_prompt: CONTINUE_TWO } } });
	if (state.main === 5) {
		assert(request.text.includes(CONTINUE_TWO), "Second authored continuation was absent after compaction");
		return sendSse(res, { tool: { id: "search-after-folds", name: "search_memories", arguments: { query: MARKER, limit: 5 } } });
	}
	if (state.main === 6) {
		state.searchedId = toolResults.match(/\[([a-f0-9]{12})\]/)?.[1];
		assert(state.searchedId, `Repeated-fold search did not return a memory id: ${toolResults}`);
		return sendSse(res, { tool: { id: "recall-after-folds", name: "recall", arguments: { id: state.searchedId } } });
	}
	state.recalledExactSource = toolResults.includes(MARKER) && /Source|Tool result|Assistant/.test(toolResults);
	assert(state.recalledExactSource, "Recall after repeated compaction did not recover exact source context");
	return sendSse(res, { text: "REPEATED_COMPACTION_RECALL_COMPLETE" });
});

console.log("RPC compaction failure E2E: repeated too-small compactions, fail-safe continuation, observer sidecars, and memory recovery");
const workspace = await createWorkspace("pi-compaction-resilience-e2e-");
let pi;
try {
	const port = await server.start();
	await prepareWorkspace(workspace, port, {
		compaction: { enabled: false, reserveTokens: 512, keepRecentTokens: 1 },
		...omSettings({ compactAfterTokens: 1_000_000, contemplatorEnabled: false, reviewerEnabled: false, compactionObserverEnabled: true }),
	});
	pi = await launchPi(workspace);
	const start = pi.rpc.events.length;
	await pi.rpc.command({ type: "prompt", message: `Create ${MARKER}, compact twice, then recover the old memory without waiting for another user prompt.` });
	await waitFor(async () => (await pi.rpc.entries()).some((entry) => entry.type === "message" && entry.message?.role === "assistant" && textOf(entry.message).includes("REPEATED_COMPACTION_RECALL_COMPLETE")), "repeated compaction memory recovery", 30_000);
	const entries = await pi.rpc.entries();
	const compactions = entries.filter((entry) => entry.type === "compaction");
	assert(compactions.length === 0, `Too-small compactions unexpectedly wrote ${compactions.length} compaction entries`);
	const failedCompactions = pi.rpc.events.slice(start).filter((event) => event.type === "compaction_end" && !event.result);
	assert(failedCompactions.length === 2, `Expected two explicit failed compaction events, got ${failedCompactions.length}`);
	const resumes = pi.rpc.events.slice(start).filter((event) => event.type === "message_start" && event.message?.customType === "om.compaction.resume");
	assert(resumes.length === 2 && resumes.every((event) => event.message.content.includes("Context compaction failed")), "Failure fail-safe did not resume both authored continuations");
	assert(state.observers >= 2, `Compaction observer sidecars did not run (observer requests: ${state.observers})`);
	assert(state.searchedId && state.recalledExactSource, "Memory tools did not recover old evidence after repeated failures");
	assert(!pi.rpc.events.some((event) => event.type === "extension_error"), "Extension error during failed-compaction recovery");
	await stopPi(pi); pi = undefined;
	log("PASS two failed compactions resumed, sidecars ran, and search/recall remained usable");
} catch (error) {
	console.error(`State: ${JSON.stringify(state)}; requests: ${server.requests.map((request) => request.role).join(",")}`);
	if (pi) console.error(`Recent events: ${JSON.stringify(pi.rpc.events.slice(-15), null, 2)}\nStderr: ${pi.rpc.stderr}`);
	throw error;
} finally {
	if (pi?.child.exitCode === null) pi.child.kill("SIGKILL");
	await server.close().catch(() => {});
	await workspace.cleanup();
}

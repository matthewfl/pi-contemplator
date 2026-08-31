#!/usr/bin/env node
import { ModelServer, assert, createWorkspace, launchPi, omSettings, prepareWorkspace, sendSse, stopPi, waitFor } from "./harness.mjs";

const started = Date.now();
const log = (text) => console.log(`[contemplator-history-e2e +${((Date.now() - started) / 1000).toFixed(1)}s] ${text}`);
const state = { main: 0, observer: 0, contemplator: 0, summary: 0 };
const summaryRequests = [];

const server = new ModelServer(async (request, res) => {
	if (request.role === "observer") {
		const hasToolResult = (request.body.messages ?? []).some((message) => message.role === "tool");
		if (hasToolResult) return sendSse(res, { text: "observer complete" });
		state.observer++;
		const sourceId = request.text.match(/Source entry id:\s*([\w-]+)/)?.[1];
		assert(sourceId, "Observer prompt lacked a source entry id");
		return sendSse(res, { tool: { id: `observe-${state.observer}`, name: "record_observations", arguments: { observations: [{
			timestamp: `2026-08-31 ${String(state.observer).padStart(2, "0")}:00`,
			content: `PRIVATE_HISTORY_EVIDENCE_${state.observer} ${"evidence ".repeat(1_300)}`,
			relevance: "high", retention: "contextual", sourceEntryIds: [sourceId],
		}] } } });
	}
	if (request.role === "contemplator") {
		state.contemplator++;
		return sendSse(res, { tool: { id: `none-${state.contemplator}`, name: "no_intervention", arguments: {} } });
	}
	const isPrivateSummary = request.text.includes("older prefix of a private contemplator transcript");
	if (isPrivateSummary) {
		state.summary++;
		summaryRequests.push(request.body);
		if (state.summary === 1) return sendSse(res, { text: "Partial private checkpoint", finishReason: "length", outputTokens: 12_800 });
		return sendSse(res, { text: "Complete compact checkpoint preserving older contemplator decisions.", outputTokens: 200 });
	}
	assert(request.role === "main", `Unexpected role ${request.role}`);
	state.main++;
	return sendSse(res, { text: `PRIMARY_PRIVATE_HISTORY_ROUND_${state.main}_DONE` });
});

console.log("RPC contemplator-history E2E: keep recent suffix → reject truncated summary → retry smaller prefix → durable pointer restore");
const workspace = await createWorkspace("pi-contemplator-history-e2e-");
let pi;
try {
	const port = await server.start();
	await prepareWorkspace(workspace, port, omSettings({
		reviewerEnabled: false,
		contemplatorMinNewObservations: 1,
		contemplatorMinTurns: 1,
	}), [{ id: "mock-model", contextWindow: 32_000, maxTokens: 20_000 }]);
	pi = await launchPi(workspace);
	log("Pi RPC session ready");

	for (let index = 1; index <= 6; index++) {
		const eventStart = pi.rpc.events.length;
		await pi.rpc.command({ type: "prompt", message: `Build private contemplator history round ${index}.` });
		await pi.rpc.waitSettled(eventStart);
		await waitFor(() => state.observer >= index, `observer round ${index}`);
		await waitFor(() => state.contemplator >= index, `contemplator round ${index}`);
	}

	const checkpoint = await waitFor(async () => (await pi.rpc.entries()).find((entry) =>
		entry.customType === "om.contemplator.message" && entry.data?.compacted === true && entry.data?.version === 2
	), "v2 private-history compact checkpoint", 30_000);
	assert(state.summary === 2, `Expected one truncated summary plus one smaller-prefix retry, got ${state.summary}`);
	const firstSummaryCap = summaryRequests[0].max_completion_tokens ?? summaryRequests[0].max_tokens;
	const fallbackSummaryCap = summaryRequests[1].max_completion_tokens ?? summaryRequests[1].max_tokens;
	assert(firstSummaryCap > 0 && firstSummaryCap <= 12_800, `Invalid context-clipped first summary cap: ${firstSummaryCap}`);
	assert(fallbackSummaryCap > firstSummaryCap && fallbackSummaryCap <= 12_800, `Smaller prefix did not free more output budget: ${firstSummaryCap} -> ${fallbackSummaryCap}`);
	assert(JSON.stringify(summaryRequests[1].messages).length < JSON.stringify(summaryRequests[0].messages).length, "Fallback did not summarize a smaller oldest prefix");
	assert(checkpoint.data.message?.content?.[0]?.text?.includes("Complete compact checkpoint"), "Checkpoint persisted the truncated rather than complete summary");
	assert(Array.isArray(checkpoint.data.retainedMessageEntryIds) && checkpoint.data.retainedMessageEntryIds.length > 0, "Checkpoint did not retain recent messages by ledger references");
	assert(checkpoint.data.retainedMessages === undefined, "Checkpoint copied retained message payloads instead of pointers");
	assert(!pi.rpc.events.some((event) => event.type === "extension_error"), "Extension error during private-history compaction");
	await stopPi(pi); pi = undefined;
	log(`PASS ${state.contemplator} contemplator runs; truncated summary rejected; smaller prefix compacted; ${checkpoint.data.retainedMessageEntryIds.length} recent messages retained by pointer`);
} catch (error) {
	if (pi) console.error(`Ledger tail: ${JSON.stringify((await pi.rpc.entries()).slice(-15), null, 2)}\nPi stderr: ${pi.rpc.stderr}`);
	throw error;
} finally {
	if (pi?.child.exitCode === null) pi.child.kill("SIGKILL");
	await server.close().catch(() => {});
	await workspace.cleanup();
}

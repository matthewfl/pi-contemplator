#!/usr/bin/env node
import { ModelServer, assert, createWorkspace, launchPi, omSettings, prepareWorkspace, sendSse, stopPi, textOf, waitFor } from "./harness.mjs";

const started = Date.now();
const log = (text) => console.log(`[summarizer-e2e +${((Date.now() - started) / 1000).toFixed(1)}s] ${text}`);
const state = { main: 0, observer: 0, summarizer: 0, proseOnly: false, requiredSeen: false, malformed: false, corrected: false, fixed: false, doneAfterReceipt: false, firstDoneSummaryCount: undefined };
let draftId;
let sourceIds = [];

const server = new ModelServer(async (request, res) => {
	const toolMessages = (request.body.messages ?? []).filter((message) => message.role === "tool");
	if (request.role === "observer") {
		if (toolMessages.length) return sendSse(res, { text: "observer batch complete" });
		state.observer++;
		const sourceId = request.text.match(/Source entry id:\s*([\w-]+)/)?.[1];
		assert(sourceId, "Observer prompt lacked source entry id");
		return sendSse(res, { delayMs: 120, tool: { id: `observe-${state.observer}`, name: "record_observations", arguments: { observations: [{
			timestamp: `2026-08-16 0${Math.min(9, state.observer)}:00`,
			content: `E2E_SUMMARIZER_EVIDENCE_${state.observer}: this is detailed related implementation evidence with exact constraints, rationale, verification state, and enough additional wording for a shorter faithful cited summary`,
			relevance: "high", sourceEntryIds: [sourceId],
		}] } } });
	}
	if (request.role === "summarizer") {
		state.summarizer++;
		const operational = toolMessages.filter((message) => !JSON.stringify(message).includes("summarizer-example"));
		if (operational.length) {
			const receipt = textOf(operational.at(-1));
			if (/confirmation is required/i.test(receipt)) {
				state.firstDoneSummaryCount = Number(receipt.match(/Current-run summaries:\s*(\d+)/i)?.[1]);
				assert(Number.isFinite(state.firstDoneSummaryCount), `First done receipt omitted its summary count: ${receipt}`);
				return sendSse(res, { tool: { id: `done-confirm-${state.summarizer}`, name: "done", arguments: {} } });
			}
			if (/ERROR .*not found|summary rejected/i.test(receipt)) {
				state.corrected = true;
				return sendSse(res, { tool: { id: `summary-correct-${state.summarizer}`, name: "summarize", arguments: { summaries: [`The implementation evidence establishes one verified durable outcome [${sourceIds.join(", ")}].`] } } });
			}
			const created = receipt.match(/summary created successfully \[([a-f0-9]{12})\]/)?.[1];
			if (created && !state.fixed) {
				draftId = created;
				state.fixed = true;
				return sendSse(res, { tool: { id: `fix-${state.summarizer}`, name: "fix_summary", arguments: { summary_id: created, updated_summary: `The related implementation evidence records a verified durable outcome and its rationale [${sourceIds.join(", ")}].` } } });
			}
			if (/new summary created|summary created successfully/i.test(receipt)) {
				state.doneAfterReceipt = true;
				return sendSse(res, { tool: { id: `done-${state.summarizer}`, name: "done", arguments: {} } });
			}
		}
		if (!state.proseOnly) {
			state.proseOnly = true;
			return sendSse(res, { text: "I should summarize these records, but this is only prose." });
		}
		if (request.body.tool_choice === "required") state.requiredSeen = true;
		else assert(state.requiredSeen, `Initial prose-only retry did not require tool use before a later fresh launch: ${JSON.stringify(request.body.tool_choice)}`);
		const context = (request.body.messages ?? []).map(textOf).join("\n");
		sourceIds = [...new Set([...context.matchAll(/^\[([a-f0-9]{12})\] observation\b/gm)].map((match) => match[1]))];
		log(`summarizer inspected ${sourceIds.length} visible observation(s)`);
		if (sourceIds.length < 2) return sendSse(res, { tool: { id: `done-empty-${state.summarizer}`, name: "done", arguments: {} } });
		if (!state.malformed) {
			state.malformed = true;
			return sendSse(res, { tool: { id: `summary-bad-${state.summarizer}`, name: "summarize", arguments: { summaries: [`Bad attempt [${sourceIds[0]}, deadbeefdead].`] } } });
		}
		return sendSse(res, { tool: { id: `summary-${state.summarizer}`, name: "summarize", arguments: { summaries: [`The implementation evidence establishes one verified durable outcome [${sourceIds.join(", ")}].`] } } });
	}
	assert(request.role === "main", `Unexpected role ${request.role}`);
	state.main++;
	return sendSse(res, { text: `PRIMARY_SUMMARIZER_ROUND_${state.main}_COMPLETE`, outputTokens: 100 });
});

console.log("RPC summarizer E2E: observer → background summarizer → malformed retry → fix_summary → double done → atomic graph commit");
const workspace = await createWorkspace("pi-summarizer-e2e-");
let pi;
try {
	const port = await server.start();
	await prepareWorkspace(workspace, port, omSettings({
		contemplatorEnabled: false, reviewerEnabled: false,
		summarizerEnabled: true, summarizerMinIntervalMinutes: 0, summarizerMaxDelayMinutes: 0,
		summarizerMinNewMemoryTokens: 1, summarizerMaxPendingMemoryTokens: 1,
		summarizerPressureTriggerRatio: 1, summarizerSamplingThresholdTokens: 50_000,
		observationsPoolMaxTokens: 100, observationsPoolTargetTokens: 50,
	}));
	pi = await launchPi(workspace);
	log("Pi RPC session ready");
	for (const prompt of ["Record first related implementation fact.", "Record second related implementation fact."]) {
		const start = pi.rpc.events.length;
		await pi.rpc.command({ type: "prompt", message: prompt });
		await pi.rpc.waitSettled(start);
		await waitFor(async () => (await pi.rpc.entries()).filter((entry) => entry.customType === "om.observations.recorded").length >= state.main, "observer batch", 20_000);
	}
	const commit = await waitFor(async () => (await pi.rpc.entries()).find((entry) => entry.customType === "om.summarizer.commit" && entry.data?.summaries?.length), "atomic summarizer commit", 40_000);
	assert(state.proseOnly && state.requiredSeen, "Prose-only retry did not become required-tool mode");
	assert(state.malformed && state.corrected, "Malformed summary was not rejected and corrected");
	assert(state.fixed && state.doneAfterReceipt, "fix_summary/done receipt ordering was not exercised");
	assert(state.firstDoneSummaryCount === 1, `First done receipt reported ${state.firstDoneSummaryCount} summaries after one accepted fixed draft`);
	assert(commit.data.summaries.length === 1, "Commit should contain only the final fixed draft");
	assert(commit.data.summaries[0].id !== draftId, "fix_summary did not replace the content-derived id");
	assert(commit.data.summaries[0].consumedMemoryIds.length === 2, "Summary did not consume both visible sources");
	assert(commit.data.metrics.estimatedTokenReduction > 0, "Commit did not record positive token reduction");
	assert(!pi.rpc.events.some((event) => event.type === "extension_error"), "Extension error in summarizer scenario");
	await stopPi(pi); pi = undefined;
	log(`PASS ${state.observer} observer runs, ${state.summarizer} summarizer requests, final graph commit`);
} catch (error) {
	console.error(`State: ${JSON.stringify(state)}; roles: ${server.requests.map((request) => request.role).join(",")}`);
	if (pi) console.error(`Ledger tail: ${JSON.stringify((await pi.rpc.entries()).slice(-12), null, 2)}\nPi stderr: ${pi.rpc.stderr}`);
	throw error;
} finally {
	if (pi?.child.exitCode === null) pi.child.kill("SIGKILL");
	await server.close().catch(() => {});
	await workspace.cleanup();
}

#!/usr/bin/env node
import { ModelServer, assert, createWorkspace, launchPi, omSettings, prepareWorkspace, sendSse, stopPi, textOf, waitFor } from "./harness.mjs";

const started = Date.now();
const log = (text) => console.log(`[librarian-e2e +${((Date.now() - started) / 1000).toFixed(1)}s] ${text}`);
const state = { main: 0, observer: 0, librarian: 0, staged: 0, doneAfterReceipt: false };

const server = new ModelServer(async (request, res) => {
	const toolMessages = (request.body.messages ?? []).filter((message) => message.role === "tool");
	if (request.role === "observer") {
		if (toolMessages.length) return sendSse(res, { text: "observer batch complete" });
		state.observer++;
		const sourceId = request.text.match(/Source entry id:\s*([\w-]+)/)?.[1];
		assert(sourceId, "Observer prompt lacked a source entry id");
		return sendSse(res, {
			delayMs: 100,
			tool: {
				id: `observe-${state.observer}`,
				name: "record_observations",
				arguments: { observations: [{
					timestamp: `2026-08-16 0${Math.min(9, state.observer)}:00`,
					content: `E2E_LIBRARIAN_EVIDENCE_${state.observer}: related implementation evidence worth consolidating`,
					relevance: "high",
					retention: "contextual",
					sourceEntryIds: [sourceId],
				}] },
			},
		});
	}
	if (request.role === "librarian") {
		state.librarian++;
		if (toolMessages.length) {
			const receipt = JSON.stringify(toolMessages);
			assert(/Staged reflection/.test(receipt), `Librarian did not receive a successful staging receipt: ${receipt}`);
			state.doneAfterReceipt = true;
			return sendSse(res, { tool: { id: `done-${state.librarian}`, name: "done", arguments: { summary: "Consolidated related E2E evidence conservatively." } } });
		}
		const contextText = (request.body.messages ?? []).map(textOf).join("\n");
		const ids = [...new Set([...contextText.matchAll(/^\[([a-f0-9]{12})\] (?:observation|reflection)\b/gm)].map((match) => match[1]))];
		log(`librarian request inspected ${ids.length} active memory line(s)`);
		if (ids.length < 2) return sendSse(res, { tool: { id: `done-empty-${state.librarian}`, name: "done", arguments: { summary: "Not enough related evidence yet." } } });
		state.staged++;
		return sendSse(res, {
			delayMs: 150,
			tool: {
				id: `reflect-${state.librarian}`,
				name: "record_reflection",
				arguments: {
					content: `E2E_LIBRARIAN_CRYSTALLIZED_${state.staged}: the related implementation evidence has been consolidated`,
					sourceMemoryIds: ids.slice(0, 2),
					sourceDisposition: "makeInactive",
					sourceRecallIf: "Recall when revisiting the related E2E implementation",
					rationale: "One higher-order memory preserves these related details more compactly.",
				},
			},
		});
	}
	assert(request.role === "main", `Unexpected role in librarian scenario: ${request.role}`);
	state.main++;
	return sendSse(res, { text: `PRIMARY_LIBRARIAN_ROUND_${state.main}_COMPLETE`, outputTokens: 100 });
});

console.log("RPC librarian E2E: observer → scheduled stateless librarian → staged reflection → done → atomic lifecycle commit");
const workspace = await createWorkspace("pi-librarian-e2e-");
let pi;
try {
	const port = await server.start();
	await prepareWorkspace(workspace, port, omSettings({
		contemplatorEnabled: false,
		reviewerEnabled: false,
		librarianEnabled: true,
		librarianMinIntervalMinutes: 0,
		librarianMaxDelayMinutes: 0,
		librarianMinNewMemoryTokens: 1,
		librarianPressureTriggerRatio: 1,
		librarianSamplingThresholdRatio: 0.6,
		observationsPoolMaxTokens: 100,
		observationsPoolTargetTokens: 50,
	}));
	pi = await launchPi(workspace);
	log("Pi RPC session ready");
	for (const prompt of ["Record the first related implementation fact.", "Record the second related implementation fact."]) {
		const eventStart = pi.rpc.events.length;
		await pi.rpc.command({ type: "prompt", message: prompt });
		await pi.rpc.waitSettled(eventStart);
		await waitFor(async () => (await pi.rpc.entries()).filter((entry) => entry.customType === "om.observations.recorded").length >= state.main, "observer batch", 20_000);
	}
	const commit = await waitFor(async () => {
		const commits = (await pi.rpc.entries()).filter((entry) => entry.customType === "om.librarian.commit");
		return commits.find((entry) => (entry.data?.reflections?.length ?? 0) > 0 && (entry.data?.actions?.length ?? 0) > 0);
	}, "atomic librarian reflection/lifecycle commit", 30_000);
	assert(state.doneAfterReceipt, "Librarian called done without first receiving the staging result");
	assert(commit.data.actions.some((action) => action.type === "makeInactive" && action.memoryIds.length === 2 && action.recallIf), "Commit did not atomically inactivate both reflection sources with a recall cue");
	assert(commit.data.reflections[0].sourceMemoryIds.length === 2, "Reflection did not retain both source backpointers");
	assert(server.requests.some((request) => request.role === "observer") && server.requests.some((request) => request.role === "librarian"), "Expected observer and librarian requests did not reach the mock server");
	assert(!server.requests.some((request) => request.role === "reflector" || request.role === "dropper"), "Retired reflector/dropper reached the server");
	assert(!pi.rpc.events.some((event) => event.type === "extension_error"), "Extension error in librarian scenario");
	await stopPi(pi); pi = undefined;
	log(`PASS ${state.observer} observer runs, ${state.librarian} librarian requests, atomic reflection + inactivation commit`);
} catch (error) {
	console.error(`State: ${JSON.stringify(state)}; requests: ${server.requests.map((request) => request.role).join(",")}`);
	if (pi) console.error(`Ledger tail: ${JSON.stringify((await pi.rpc.entries()).slice(-12), null, 2)}\nPi stderr: ${pi.rpc.stderr}`);
	throw error;
} finally {
	if (pi?.child.exitCode === null) pi.child.kill("SIGKILL");
	await server.close().catch(() => {});
	await workspace.cleanup();
}

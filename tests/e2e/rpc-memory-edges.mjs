#!/usr/bin/env node
import { ModelServer, assert, createWorkspace, launchPi, omSettings, prepareWorkspace, sendSse, stopPi, waitFor } from "./harness.mjs";

const MARKER = "E2E_HUGE_MEMORY_EDGE";
const COLLISION_CONTENT = "E2E deterministic duplicate observation collision";
const started = Date.now();
const log = (text) => console.log(`[memory-edges-e2e +${((Date.now() - started) / 1000).toFixed(1)}s] ${text}`);
const state = { main: 0, observerInitials: 0, invalidAttempted: false, sawOmission: false, maxObserverText: 0, recallCollision: false };

const server = new ModelServer(async (request, res) => {
	const toolMessages = (request.body.messages ?? []).filter((message) => message.role === "tool");
	if (request.role === "observer") {
		if (toolMessages.length) {
			const result = JSON.stringify(toolMessages.at(-1));
			if (state.invalidAttempted && /invalid|unknown|source|not found|rejected/i.test(result)) {
				const sourceId = request.text.match(/Source entry id:\s*([\w-]+)/)?.[1];
				assert(sourceId, "Observer retry lacked its original valid source id");
				return sendSse(res, { tool: { id: "valid-retry", name: "record_observations", arguments: { observations: [{ timestamp: "2026-08-15 03:00", content: COLLISION_CONTENT, relevance: "high", sourceEntryIds: [sourceId] }] } } });
			}
			return sendSse(res, { text: "observer batch complete" });
		}
		state.observerInitials++;
		state.maxObserverText = Math.max(state.maxObserverText, request.text.length);
		state.sawOmission ||= /omitted|truncat|bounded/i.test(request.text);
		const sourceId = request.text.match(/Source entry id:\s*([\w-]+)/)?.[1];
		assert(sourceId, "Observer prompt lacked a source id");
		if (!state.invalidAttempted) {
			state.invalidAttempted = true;
			return sendSse(res, { tool: { id: "invalid-source-first", name: "record_observations", arguments: { observations: [{ timestamp: "2026-08-15 03:00", content: "MUST_NOT_PERSIST_INVALID", relevance: "high", sourceEntryIds: ["definitely-missing-entry"] }] } } });
		}
		return sendSse(res, { tool: { id: `valid-${state.observerInitials}`, name: "record_observations", arguments: { observations: [{ timestamp: "2026-08-15 03:00", content: COLLISION_CONTENT, relevance: "high", sourceEntryIds: [sourceId] }] } } });
	}
	assert(request.role === "main", `Unexpected role in memory-edge scenario: ${request.role}`);
	state.main++;
	const toolText = (request.body.messages ?? []).filter((message) => message.role === "tool").map((message) => JSON.stringify(message)).join("\n");
	if (state.main === 1) return sendSse(res, { tool: { id: "huge-output", name: "bash", arguments: { command: `node -e "process.stdout.write('${MARKER}\\n' + 'x'.repeat(30000))"` } }, outputTokens: 200 });
	if (state.main === 2) return sendSse(res, { text: "HUGE_SOURCE_COMPLETE", outputTokens: 100 });
	if (state.main === 3) return sendSse(res, { tool: { id: "second-source", name: "bash", arguments: { command: "echo second-collision-source" } }, outputTokens: 100 });
	if (state.main === 4) return sendSse(res, { text: "SECOND_SOURCE_COMPLETE", outputTokens: 100 });
	if (state.main === 5) return sendSse(res, { tool: { id: "search-collision", name: "search_memories", arguments: { query: COLLISION_CONTENT, limit: 10 } } });
	if (state.main === 6) {
		const id = toolText.match(/\[([a-f0-9]{12})\]/)?.[1];
		assert(id, `Collision search returned no id: ${toolText}`);
		return sendSse(res, { tool: { id: "recall-collision", name: "recall", arguments: { id } } });
	}
	state.recallCollision = /matched multiple observations|"collision":true/.test(toolText) && toolText.includes(MARKER);
	assert(state.recallCollision, "Recall did not safely return all colliding observation sources");
	return sendSse(res, { text: "MEMORY_EDGE_COMPLETE" });
});

console.log("RPC memory-edge E2E: huge-source chunking, malformed source rejection/retry, deterministic id collisions, search, and recall");
const workspace = await createWorkspace("pi-memory-edges-e2e-");
let pi;
try {
	const port = await server.start();
	await prepareWorkspace(workspace, port, omSettings({ observerChunkMaxTokens: 1_000, contemplatorEnabled: false, reviewerEnabled: false, compactionObserverEnabled: false }));
	pi = await launchPi(workspace);
	const first = pi.rpc.events.length;
	await pi.rpc.command({ type: "prompt", message: `Generate a huge source containing ${MARKER}.` });
	await pi.rpc.waitSettled(first);
	await waitFor(async () => (await pi.rpc.entries()).filter((entry) => entry.customType === "om.observations.recorded").flatMap((entry) => entry.data?.observations ?? []).some((observation) => observation.content === COLLISION_CONTENT), "valid retry after malformed source", 30_000);
	const secondSource = pi.rpc.events.length;
	await pi.rpc.command({ type: "prompt", message: "Create an independent second source for the collision test." });
	await pi.rpc.waitSettled(secondSource);
	await waitFor(async () => (await pi.rpc.entries()).filter((entry) => entry.customType === "om.observations.recorded").flatMap((entry) => entry.data?.observations ?? []).filter((observation) => observation.content === COLLISION_CONTENT).length >= 2, "two colliding valid observations from separate source entries", 30_000);
	const before = await pi.rpc.entries();
	const observations = before.filter((entry) => entry.customType === "om.observations.recorded").flatMap((entry) => entry.data?.observations ?? []);
	assert(!observations.some((observation) => observation.content === "MUST_NOT_PERSIST_INVALID"), "Observer persisted a record with an unknown source id");
	assert(new Set(observations.filter((observation) => observation.content === COLLISION_CONTENT).map((observation) => observation.id)).size === 1, "Deterministic duplicate content did not create the intended id collision");
	assert(state.sawOmission || state.maxObserverText < 15_000, `Huge source was not bounded in the observer prompt (${state.maxObserverText} chars)`);
	const second = pi.rpc.events.length;
	await pi.rpc.command({ type: "prompt", message: "Use search_memories and recall to recover all colliding sources." });
	await pi.rpc.waitSettled(second);
	assert(state.recallCollision, "Main-agent memory tools did not complete collision recovery");
	assert(!pi.rpc.events.some((event) => event.type === "extension_error"), "Extension error in memory-edge scenario");
	await stopPi(pi); pi = undefined;
	log("PASS invalid ids were rejected, huge input was bounded, and colliding memories remained searchable/recallable");
} catch (error) {
	console.error(`State: ${JSON.stringify(state)}; requests: ${server.requests.map((request) => request.role).join(",")}`);
	if (pi) console.error(`Recorded observations: ${JSON.stringify((await pi.rpc.entries()).filter((entry) => entry.customType === "om.observations.recorded").map((entry) => entry.data))}`);
	throw error;
} finally {
	if (pi?.child.exitCode === null) pi.child.kill("SIGKILL");
	await server.close().catch(() => {});
	await workspace.cleanup();
}

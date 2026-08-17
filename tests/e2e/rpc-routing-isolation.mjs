#!/usr/bin/env node
import { ModelServer, assert, createWorkspace, launchPi, omSettings, prepareWorkspace, sendSse, sleep, stopPi, toolNames, waitFor } from "./harness.mjs";

const started = Date.now();
const log = (text) => console.log(`[routing-isolation-e2e +${((Date.now() - started) / 1000).toFixed(1)}s] ${text}`);

async function modelRoutingAndFeatureFlags() {
	const state = { reviewRequested: false };
	const server = new ModelServer(async (request, res) => {
		const hasTool = (request.body.messages ?? []).some((message) => message.role === "tool");
		if (request.role === "observer") {
			if (hasTool) return sendSse(res, { text: "recorded" });
			const id = request.text.match(/Source entry id:\s*([\w-]+)/)?.[1];
			return sendSse(res, { tool: { id: "route-observation", name: "record_observations", arguments: { observations: [{ timestamp: "2026-08-15 04:00", content: "E2E_ROUTING durable evidence", relevance: "high", retention: "contextual", sourceEntryIds: [id] }] } } });
		}
		if (request.role === "contemplator") {
			assert(toolNames(request.body).has("request_review"), "Reviewer-enabled contemplator lacked request_review");
			if (hasTool) return sendSse(res, { text: "The warned routed review may be delivered as-is." });
			if (state.reviewRequested) return sendSse(res, { tool: { id: "route-no-intervention", name: "no_intervention", arguments: { reason: "The routed review was already selected." } } });
			state.reviewRequested = true;
			return sendSse(res, { tool: { id: "route-review", name: "request_review", arguments: { scope: "workflow", evidence: "[000000000000] routing evidence", concern: "Verify model routing.", review_focus: "Reach a terminal result.", constraints: "No behavior changes." } } });
		}
		if (request.role === "reviewer") return sendSse(res, { tool: { id: "route-no-proposal", name: "review_concluded_no_proposal", arguments: { reason: "Routing is correct.", evidence_reviewed: "The isolated routing trace.", reconsider_if: "A role reaches the wrong model." } } });
		return sendSse(res, { text: "ROUTING_MAIN_COMPLETE" });
	});
	const workspace = await createWorkspace("pi-routing-e2e-");
	let pi;
	try {
		const port = await server.start();
		const models = ["primary-model", "memory-model", "contemplator-model", "reviewer-model"].map((id) => ({ id, contextWindow: 128000 }));
		await prepareWorkspace(workspace, port, omSettings({
			model: { provider: "e2e", id: "memory-model", thinking: "off" },
			contemplatorModel: { provider: "e2e", id: "contemplator-model", thinking: "off" },
			reviewerModel: { provider: "e2e", id: "reviewer-model", thinking: "off" },
		}), models);
		pi = await launchPi(workspace, { model: "primary-model" });
		await pi.rpc.command({ type: "prompt", message: "E2E_ROUTING: exercise each configured agent role." });
		await waitFor(async () => (await pi.rpc.entries()).some((entry) => entry.customType === "om.review.result"), "routed reviewer result");
		const expected = { main: "primary-model", observer: "memory-model", contemplator: "contemplator-model", reviewer: "reviewer-model" };
		for (const [role, model] of Object.entries(expected)) {
			const requests = server.requests.filter((request) => request.role === role);
			assert(requests.length > 0, `No ${role} request reached the server`);
			assert(requests.every((request) => request.body.model === model), `${role} reached wrong model: ${requests.map((request) => request.body.model).join(",")}`);
		}
		await stopPi(pi); pi = undefined;
	} finally {
		if (pi?.child.exitCode === null) pi.child.kill("SIGKILL");
		await server.close().catch(() => {});
		await workspace.cleanup();
	}
}

async function passiveMode() {
	const server = new ModelServer(async (_request, res) => sendSse(res, { text: "PASSIVE_MAIN_COMPLETE" }));
	const workspace = await createWorkspace("pi-passive-e2e-");
	let pi;
	try {
		const port = await server.start();
		await prepareWorkspace(workspace, port, omSettings({ passive: true }));
		pi = await launchPi(workspace);
		const start = pi.rpc.events.length;
		await pi.rpc.command({ type: "prompt", message: "E2E_PASSIVE: workers must remain disabled." });
		await pi.rpc.waitSettled(start);
		await sleep(500);
		assert(server.requests.length === 1 && server.requests[0].role === "main", `Passive mode launched workers: ${server.requests.map((r) => r.role).join(",")}`);
		const entries = await pi.rpc.entries();
		assert(!entries.some((entry) => /^om\.(observations|reflections|review)/.test(entry.customType ?? "")), "Passive mode persisted worker output");
		await stopPi(pi); pi = undefined;
	} finally {
		if (pi?.child.exitCode === null) pi.child.kill("SIGKILL");
		await server.close().catch(() => {});
		await workspace.cleanup();
	}
}

async function treeForkIsolation() {
	const server = new ModelServer(async (request, res) => {
		if (request.text.includes("FORK_BRANCH")) assert(!request.text.includes("ABANDONED_BRANCH"), "Fork request retained abandoned-branch context");
		return sendSse(res, { text: request.text.includes("FORK_BRANCH") ? "FORK_BRANCH_COMPLETE" : "branch checkpoint" });
	});
	const workspace = await createWorkspace("pi-tree-fork-e2e-");
	let pi;
	try {
		const port = await server.start();
		await prepareWorkspace(workspace, port, omSettings({ passive: true }));
		pi = await launchPi(workspace);
		for (const message of ["ROOT_BRANCH checkpoint", "ABANDONED_BRANCH must disappear after fork"]) {
			const start = pi.rpc.events.length;
			await pi.rpc.command({ type: "prompt", message });
			await pi.rpc.waitSettled(start);
		}
		const choices = (await pi.rpc.command({ type: "get_fork_messages" })).messages;
		const root = choices.find((choice) => choice.text.includes("ROOT_BRANCH"));
		assert(root, "Root user entry was unavailable to the RPC fork API");
		const forked = await pi.rpc.command({ type: "fork", entryId: root.entryId });
		assert(!forked.cancelled && forked.text.includes("ROOT_BRANCH"), "RPC fork did not move to the selected root entry");
		const start = pi.rpc.events.length;
		await pi.rpc.command({ type: "prompt", message: "FORK_BRANCH continue only from root." });
		await pi.rpc.waitSettled(start);
		assert(!pi.rpc.events.some((event) => event.type === "extension_error"), "Extension error while moving the session tree");
		await stopPi(pi); pi = undefined;
	} finally {
		if (pi?.child.exitCode === null) pi.child.kill("SIGKILL");
		await server.close().catch(() => {});
		await workspace.cleanup();
	}
}

async function concurrentIsolation() {
	const sent = new Set();
	const server = new ModelServer(async (request, res) => {
		const marker = request.text.includes("SESSION_ALPHA") ? "SESSION_ALPHA" : request.text.includes("SESSION_BETA") ? "SESSION_BETA" : undefined;
		assert(marker, "Concurrent request lost its session marker");
		const other = marker === "SESSION_ALPHA" ? "SESSION_BETA" : "SESSION_ALPHA";
		assert(!request.text.includes(other), `${marker} request leaked ${other} context`);
		const hasTool = (request.body.messages ?? []).some((message) => message.role === "tool");
		if (request.role === "observer") {
			if (hasTool) return sendSse(res, { text: "recorded" });
			const id = request.text.match(/Source entry id:\s*([\w-]+)/)?.[1];
			return sendSse(res, { tool: { id: `observe-${marker}`, name: "record_observations", arguments: { observations: [{ timestamp: "2026-08-15 04:10", content: `${marker} isolated memory`, relevance: "high", retention: "contextual", sourceEntryIds: [id] }] } } });
		}
		if (request.role === "contemplator") {
			assert(!toolNames(request.body).has("request_review"), "Reviewer-disabled session exposed request_review");
			if (hasTool || sent.has(marker)) return sendSse(res, { tool: { id: `no-intervention-${marker}`, name: "no_intervention", arguments: { reason: "No further isolated-session probe is warranted." } } });
			sent.add(marker);
			return sendSse(res, { delayMs: marker === "SESSION_ALPHA" ? 400 : 200, tool: { id: `probe-${marker}`, name: "send_probe", arguments: { question: `${marker}_PROBE` } } });
		}
		if (request.text.includes(`${marker}_PROBE`)) return sendSse(res, { text: `${marker}_PROBE_HANDLED` });
		return sendSse(res, { text: `${marker}_IDLE` });
	});
	const workspaces = [await createWorkspace("pi-alpha-e2e-"), await createWorkspace("pi-beta-e2e-")];
	const instances = [];
	try {
		const port = await server.start();
		for (const workspace of workspaces) await prepareWorkspace(workspace, port, omSettings({ reviewerEnabled: false }));
		instances.push(...await Promise.all(workspaces.map((workspace) => launchPi(workspace))));
		await Promise.all(instances.map((pi, index) => pi.rpc.command({ type: "prompt", message: `${index ? "SESSION_BETA" : "SESSION_ALPHA"}: establish isolated state.` })));
		await waitFor(async () => sent.size === 2 && (await Promise.all(instances.map((pi) => pi.rpc.entries()))).every((entries) => entries.some((entry) => entry.customType === "om.contemplator.suggestion" && entry.data?.delivered === false)), "both isolated contemplators persisted pending probes");
		await Promise.all(instances.map((pi, index) => pi.rpc.command({ type: "prompt", message: `${index ? "SESSION_BETA" : "SESSION_ALPHA"}: drain only this session's probe.` })));
		await waitFor(async () => (await Promise.all(instances.map((pi) => pi.rpc.entries()))).every((entries) => entries.some((entry) => entry.customType === "om.contemplator.suggestion" && entry.data?.delivered === true)), "both isolated probes delivered");
		for (let index = 0; index < instances.length; index++) {
			const own = index ? "SESSION_BETA" : "SESSION_ALPHA";
			const other = index ? "SESSION_ALPHA" : "SESSION_BETA";
			const serialized = JSON.stringify(await instances[index].rpc.entries());
			assert(serialized.includes(own) && !serialized.includes(other), `${own} ledger leaked ${other}`);
		}
		await Promise.all(instances.map((pi) => stopPi(pi)));
		instances.length = 0;
		assert(server.maxActive >= 2, "Concurrent sessions never overlapped at the server boundary");
	} finally {
		for (const pi of instances) if (pi.child.exitCode === null) pi.child.kill("SIGKILL");
		await server.close().catch(() => {});
		await Promise.all(workspaces.map((workspace) => workspace.cleanup()));
	}
}

console.log("RPC routing/isolation E2E: role-specific models, passive flags, tree forks, reviewer tool gating, and concurrent session separation");
await modelRoutingAndFeatureFlags();
log("PASS each agent role used its configured model");
await passiveMode();
log("PASS passive mode launched only the primary agent");
await treeForkIsolation();
log("PASS session-tree fork excluded abandoned branch context");
await concurrentIsolation();
log("PASS concurrent sessions overlapped without context, memory, or probe leakage");

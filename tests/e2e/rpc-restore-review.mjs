#!/usr/bin/env node
import { ModelServer, assert, createWorkspace, launchPi, omSettings, prepareWorkspace, sendSse, sleep, stopPi, waitFor } from "./harness.mjs";

const started = Date.now();
const log = (text) => console.log(`[restore-review-e2e +${((Date.now() - started) / 1000).toFixed(1)}s] ${text}`);
const PROBE = "E2E_RESTART_PENDING_PROBE";

function observation(request, res, marker) {
	const hasTool = (request.body.messages ?? []).some((message) => message.role === "tool");
	if (hasTool) return sendSse(res, { text: "observation recorded" });
	const id = request.text.match(/Source entry id:\s*([\w-]+)/)?.[1];
	return sendSse(res, { tool: { id: `observe-${marker}`, name: "record_observations", arguments: { observations: [{ timestamp: "2026-08-15 01:00", content: `${marker} durable restart evidence`, relevance: "high", sourceEntryIds: [id] }] } } });
}

async function pendingProbeRestart() {
	const state = { probeSent: false, main: 0 };
	const server = new ModelServer(async (request, res) => {
		if (request.role === "observer") return observation(request, res, "probe-restart");
		if (request.role === "contemplator") {
			const hasTool = (request.body.messages ?? []).some((message) => message.role === "tool");
			if (hasTool || state.probeSent) return sendSse(res, { text: "done" });
			await sleep(500);
			state.probeSent = true;
			return sendSse(res, { tool: { id: "restart-probe", name: "send_probe", arguments: { question: PROBE } } });
		}
		state.main++;
		if (state.main === 1) return sendSse(res, { text: "main is now idle" });
		assert(request.text.includes(PROBE), "Restored pending probe was absent from the next primary request");
		return sendSse(res, { text: "restored probe handled" });
	});
	const workspace = await createWorkspace("pi-restore-probe-e2e-");
	let pi;
	try {
		const port = await server.start();
		await prepareWorkspace(workspace, port, omSettings({ reviewerEnabled: false }));
		pi = await launchPi(workspace);
		const first = pi.rpc.events.length;
		await pi.rpc.command({ type: "prompt", message: "Create restart evidence, then become idle." });
		await pi.rpc.waitSettled(first);
		await waitFor(async () => (await pi.rpc.entries()).some((e) => e.customType === "om.contemplator.suggestion" && e.data?.delivered === false), "pending probe before restart");
		const sessionFile = (await pi.rpc.state()).sessionFile;
		await stopPi(pi); pi = undefined;
		pi = await launchPi(workspace, { session: sessionFile });
		const restored = await pi.rpc.entries();
		const restoredProbeEntries = restored.filter((e) => e.customType === "om.contemplator.suggestion" && e.data?.delivered === false);
		const restoredProbeIds = new Set(restoredProbeEntries.map((e) => e.data.probeId));
		assert(restoredProbeIds.size === 1 && restoredProbeEntries.some((e) => e.data?.source === "restore"), `Restart duplicated or dropped logical pending probe state: ${JSON.stringify(restoredProbeEntries.map((e) => e.data))}`);
		const next = pi.rpc.events.length;
		await pi.rpc.command({ type: "prompt", message: "Resume this restored session." });
		await pi.rpc.waitSettled(next);
		const final = await pi.rpc.entries();
		assert(final.some((e) => e.customType === "om.contemplator.suggestion" && e.data?.delivered === true), "Restored probe was not acknowledged");
		assert(state.main === 2, `Probe was not delivered exactly once (main requests: ${state.main})`);
		await stopPi(pi); pi = undefined;
	} finally {
		if (pi?.child.exitCode === null) pi.child.kill("SIGKILL");
		await server.close().catch(() => {});
		await workspace.cleanup();
	}
}

async function reviewerRestart() {
	const state = { reviewRequested: false, reviewerCalls: 0, holdSecond: true };
	const server = new ModelServer(async (request, res) => {
		const hasTool = (request.body.messages ?? []).some((message) => message.role === "tool");
		if (request.role === "observer") return observation(request, res, "review-restart");
		if (request.role === "contemplator") {
			if (hasTool || state.reviewRequested) return sendSse(res, { text: "review requested" });
			state.reviewRequested = true;
			return sendSse(res, { tool: { id: "request-restored-review", name: "request_review", arguments: { scope: "workflow", evidence: "[000000000000] repeated restart evidence", concern: "Determine whether resumability has a structural weakness.", review_focus: "Reach one terminal evidence-based outcome.", constraints: "Preserve asynchronous operation." } } });
		}
		if (request.role === "reviewer") {
			state.reviewerCalls++;
			if (state.reviewerCalls === 1) return sendSse(res, { text: "I reviewed the initial evidence and must now record a terminal decision." });
			if (state.holdSecond) { await sleep(8_000); return sendSse(res, { text: "obsolete pre-restart response" }); }
			return sendSse(res, { tool: { id: "restored-terminal", name: "review_concluded_no_proposal", arguments: { reason: "The restart transcript resumed correctly and reveals no structural defect.", evidence_reviewed: "The durable first reviewer message and restored request.", reconsider_if: "A resumed review duplicates or loses transcript messages." } } });
		}
		return sendSse(res, { text: "primary complete" });
	});
	const workspace = await createWorkspace("pi-restore-review-e2e-");
	let pi;
	try {
		const port = await server.start();
		await prepareWorkspace(workspace, port, omSettings());
		pi = await launchPi(workspace);
		await pi.rpc.command({ type: "prompt", message: "Generate evidence for a restartable structural review." });
		await waitFor(async () => state.reviewerCalls >= 2 && (await pi.rpc.entries()).filter((e) => e.customType === "om.reviewer.message").length >= 1, "reviewer persisted first message and entered second invocation");
		const before = await pi.rpc.entries();
		const requestId = before.find((e) => e.customType === "om.review.request")?.data?.request?.id;
		assert(requestId, "Review request was not persisted before restart");
		const preRestartMessages = before.filter((e) => e.customType === "om.reviewer.message");
		assert(preRestartMessages.length >= 1, `Expected durable pre-restart reviewer messages, got ${preRestartMessages.length}`);
		const sessionFile = (await pi.rpc.state()).sessionFile;
		await stopPi(pi); pi = undefined;
		state.holdSecond = false;
		pi = await launchPi(workspace, { session: sessionFile });
		await waitFor(async () => (await pi.rpc.entries()).some((e) => e.customType === "om.review.result" && e.data?.result?.reviewRequestId === requestId), "resumed reviewer terminal result", 20_000);
		const final = await pi.rpc.entries();
		assert(final.filter((e) => e.customType === "om.review.request").length === 1, "Review request duplicated after restart");
		assert(final.filter((e) => e.customType === "om.review.result" && e.data?.result?.reviewRequestId === requestId).length === 1, "Resumed review did not produce exactly one terminal result");
		const finalMessages = final.filter((e) => e.customType === "om.reviewer.message");
		assert(finalMessages.length > preRestartMessages.length, "Resumed reviewer transcript did not append its terminal message");
		for (const prior of preRestartMessages) assert(finalMessages.filter((e) => e.id === prior.id).length === 1, `Reviewer transcript entry ${prior.id} was duplicated on restore`);
		assert(state.reviewerCalls === 3, `Expected one resumed provider invocation, got ${state.reviewerCalls - 2}`);
		await stopPi(pi); pi = undefined;
	} finally {
		if (pi?.child.exitCode === null) pi.child.kill("SIGKILL");
		await server.close().catch(() => {});
		await workspace.cleanup();
	}
}

async function reviewerBudgetExhaustion() {
	const state = { requested: false, reviewerCalls: 0 };
	const server = new ModelServer(async (request, res) => {
		const hasTool = (request.body.messages ?? []).some((message) => message.role === "tool");
		if (request.role === "observer") return observation(request, res, "budget");
		if (request.role === "contemplator") {
			if (hasTool || state.requested) return sendSse(res, { text: "done" });
			state.requested = true;
			return sendSse(res, { tool: { id: "request-budget-review", name: "request_review", arguments: { scope: "software", evidence: "[000000000000] budget evidence", concern: "Assess this bounded review.", review_focus: "Reach a terminal outcome.", constraints: "Respect the lifetime budget." } } });
		}
		if (request.role === "reviewer") {
			state.reviewerCalls++;
			return sendSse(res, { text: "No terminal tool call before lifetime budget ends.", outputTokens: 1_000_000 });
		}
		return sendSse(res, { text: "primary complete" });
	});
	const workspace = await createWorkspace("pi-review-budget-e2e-");
	let pi;
	try {
		const port = await server.start();
		await prepareWorkspace(workspace, port, omSettings());
		pi = await launchPi(workspace);
		await pi.rpc.command({ type: "prompt", message: "Generate evidence for budget exhaustion." });
		await waitFor(async () => (await pi.rpc.entries()).some((e) => e.customType === "om.review.result"), "budget exhaustion terminal result");
		const entries = await pi.rpc.entries();
		const result = entries.find((e) => e.customType === "om.review.result")?.data?.result;
		assert(result?.outcome === "no_proposal" && /budget/i.test(result.reason), "Budget exhaustion did not persist an explanatory terminal no_proposal");
		const sessionFile = (await pi.rpc.state()).sessionFile;
		await stopPi(pi); pi = undefined;
		pi = await launchPi(workspace, { session: sessionFile });
		await sleep(1_000);
		assert(state.reviewerCalls === 1, "Completed budget-exhausted review relaunched after restore");
		await stopPi(pi); pi = undefined;
	} finally {
		if (pi?.child.exitCode === null) pi.child.kill("SIGKILL");
		await server.close().catch(() => {});
		await workspace.cleanup();
	}
}

console.log("RPC restore/reviewer E2E: pending delivery, durable reviewer resume, and terminal budget exhaustion");
await pendingProbeRestart();
log("PASS pending probe survived process restart and delivered exactly once");
await reviewerRestart();
log("PASS reviewer resumed from durable transcript and produced one terminal result");
await reviewerBudgetExhaustion();
log("PASS exhausted review was tombstoned and did not relaunch after restart");

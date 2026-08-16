#!/usr/bin/env node
import { ModelServer, assert, createWorkspace, launchPi, omSettings, prepareWorkspace, sendSse, sleep, stopPi, textOf, waitFor } from "./harness.mjs";

const PARALLEL = "E2E_PARALLEL_BATCH";
const IDLE = "E2E_IDLE_HIDDEN";
const PROBE = "E2E_DELIVERY_PROBE";
const started = Date.now();
const log = (text) => console.log(`[delivery-e2e +${((Date.now() - started) / 1000).toFixed(1)}s] ${text}`);

async function sendParallel(res) {
	res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
	const base = { id: "parallel-tools", object: "chat.completion.chunk", created: 1, model: "mock-model" };
	const calls = [
		{ index: 0, id: "parallel-fast-fail", type: "function", function: { name: "bash", arguments: JSON.stringify({ command: "sleep 1; echo fast-failed; exit 7" }) } },
		{ index: 1, id: "parallel-slow-ok", type: "function", function: { name: "bash", arguments: JSON.stringify({ command: "sleep 2; echo slow-succeeded" }) } },
	];
	res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: calls }, finish_reason: null }] })}\n\n`);
	res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 20, completion_tokens: 1, total_tokens: 21 } })}\n\n`);
	res.end("data: [DONE]\n\n");
}

async function runCase({ marker, visible }) {
	const state = { main: 0, observer: 0, contemplator: 0, parallelIssued: false, probeSent: false };
	const server = new ModelServer(async (request, res) => {
		const hasTool = (request.body.messages ?? []).some((message) => message.role === "tool");
		if (request.role === "observer") {
			state.observer++;
			if (hasTool) return sendSse(res, { text: "observed" });
			const id = request.text.match(/Source entry id:\s*([\w-]+)/)?.[1];
			return sendSse(res, { tool: { id: `obs-${state.observer}`, name: "record_observations", arguments: { observations: [{ timestamp: "2026-08-15 00:00", content: `${marker} durable delivery evidence`, relevance: "high", retention: "contextual", sourceEntryIds: [id] }] } } });
		}
		if (request.role === "contemplator") {
			state.contemplator++;
			if (hasTool) return sendSse(res, { text: "probe complete" });
			if (state.probeSent) return sendSse(res, { text: "no second probe" });
			if (marker === PARALLEL) await waitFor(() => state.parallelIssued, "parallel tools issued");
			else await sleep(900);
			state.probeSent = true;
			return sendSse(res, { tool: { id: `probe-${marker}`, name: "send_probe", arguments: { question: `${PROBE}:${marker}` } } });
		}
		state.main++;
		if (marker === PARALLEL) {
			if (state.main === 1) return sendSse(res, { tool: { id: "seed", name: "bash", arguments: { command: `echo ${marker}` } } });
			if (state.main === 2) { state.parallelIssued = true; return sendParallel(res); }
			assert(request.text.includes("fast-failed") && request.text.includes("slow-succeeded"), "Post-batch context lacked one of the parallel tool results");
			assert(request.text.includes(`${PROBE}:${marker}`), "Probe did not drain after the complete parallel batch");
			return sendSse(res, { text: "PARALLEL_BATCH_DONE" });
		}
		if (state.main === 1) return sendSse(res, { text: "IDLE_BEFORE_PROBE" });
		assert(request.text.includes(`${PROBE}:${marker}`), "Idle pending probe was absent from the next genuine user run");
		return sendSse(res, { text: "IDLE_PROBE_DONE" });
	});
	const workspace = await createWorkspace("pi-delivery-e2e-");
	let pi;
	try {
		const port = await server.start();
		await prepareWorkspace(workspace, port, omSettings({ showContemplatorMessages: visible, reviewerEnabled: false }));
		pi = await launchPi(workspace);
		const start = pi.rpc.events.length;
		await pi.rpc.command({ type: "prompt", message: `${marker}: begin deterministic delivery test.` });
		if (marker === PARALLEL) {
			await waitFor(async () => (await pi.rpc.entries()).some((entry) => entry.customType === "om.contemplator.suggestion" && entry.data?.delivered === false), "probe pending during parallel tools");
			assert(!pi.rpc.events.slice(start).some((event) => event.type === "tool_execution_end" && event.toolCallId === "parallel-slow-ok"), "Probe was not queued until after the slow parallel tool ended");
			assert(state.main === 2, "Provider was called before all parallel tools completed");
			await pi.rpc.waitSettled(start);
			const events = pi.rpc.events.slice(start);
			const slowEnd = events.findIndex((event) => event.type === "tool_execution_end" && event.toolCallId === "parallel-slow-ok");
			assert(slowEnd >= 0, "Slow parallel tool did not complete");
			const entries = await pi.rpc.entries();
			const activity = entries.filter((entry) => entry.customType === "om.agent.activity").reduce((sum, entry) => sum + (entry.data?.durationMs ?? 0), 0);
			assert(activity >= 1_800, `Cumulative activity omitted live tool time: ${activity}ms`);
			assert(activity < 5_000, `Concurrent tools appear double-counted: ${activity}ms`);
			assert(entries.some((entry) => entry.type === "message" && entry.message?.role === "assistant" && textOf(entry.message).includes("PARALLEL_BATCH_DONE")), "Parallel scenario did not finish");
		} else {
			await pi.rpc.waitSettled(start);
			await waitFor(async () => (await pi.rpc.entries()).some((entry) => entry.customType === "om.contemplator.suggestion" && entry.data?.delivered === false), "idle pending probe");
			assert(state.main === 1, "Idle contemplator probe incorrectly started a new primary turn");
			const entriesBefore = await pi.rpc.entries();
			assert(entriesBefore.filter((entry) => entry.type === "custom_message" && entry.customType === "om.contemplator.suggestion").every((entry) => entry.display === false), "Visibility-off probe was not marked hidden");
			const next = pi.rpc.events.length;
			await pi.rpc.command({ type: "prompt", message: "A genuine user message now resumes work." });
			await pi.rpc.waitSettled(next);
			const entries = await pi.rpc.entries();
			assert(entries.some((entry) => entry.customType === "om.contemplator.suggestion" && entry.data?.delivered === true), "Idle probe was not acknowledged");
			assert(entries.filter((entry) => entry.type === "custom_message" && entry.customType === "om.contemplator.suggestion").every((entry) => entry.display === false), "Visibility-off probe appeared in chat");
		}
		assert(!pi.rpc.events.some((event) => event.type === "extension_error"), "Extension error in delivery scenario");
		await stopPi(pi); pi = undefined;
	} finally {
		if (pi?.child.exitCode === null) pi.child.kill("SIGKILL");
		await server.close().catch(() => {});
		await workspace.cleanup();
	}
}

console.log("RPC delivery/activity E2E: parallel batches, failures, idle probes, visibility, and cumulative wall time");
await runCase({ marker: PARALLEL, visible: true });
log("PASS parallel batch: probe waited for slow+failed tools and wall time was not double-counted");
await runCase({ marker: IDLE, visible: false });
log("PASS idle/hidden: no manufactured turn; next user run delivered without display");

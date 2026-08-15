#!/usr/bin/env node
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import process from "node:process";

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), "../..");
const PI = join(ROOT, "node_modules/.bin/pi");
const EXTENSION = join(ROOT, "src/index.ts");
const MANUAL = "SCENARIO_MANUAL_COMPACTION";
const AUTOMATIC = "SCENARIO_AUTOMATIC_COMPACTION";
const MANUAL_PROBE = "Before continuing, verify that the compaction retained the manual scenario and its next action.";
const MANUAL_CONTINUATION = "After compaction, verify the queued contemplator probe and report MANUAL_COMPACTION_RESUMED.";
const startedAt = Date.now();

function progress(message) {
	const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1).padStart(5);
	console.log(`[compaction-e2e +${elapsed}s] ${message}`);
}

function assert(condition, message) {
	if (!condition) throw new Error(message);
}

function sleep(ms) {
	return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function waitFor(check, message, timeoutMs = 20_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const value = await check();
		if (value) return value;
		await sleep(25);
	}
	throw new Error(`Timed out: ${message}`);
}

function messageText(message) {
	if (typeof message?.content === "string") return message.content;
	if (!Array.isArray(message?.content)) return "";
	return message.content.map((part) => typeof part?.text === "string" ? part.text : "").join("\n");
}

function toolsIn(body) {
	return new Set((body.tools ?? []).map((tool) => tool?.function?.name).filter(Boolean));
}

function usage(input = 20, output = 1) {
	return { prompt_tokens: input, completion_tokens: output, total_tokens: input + output };
}

async function sendSse(res, { text, tool, inputTokens = 20, outputTokens = 1, delayMs = 0 }) {
	if (delayMs) await sleep(delayMs);
	res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
	const id = `chatcmpl-${Math.random().toString(16).slice(2)}`;
	const base = { id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "mock-model" };
	const emit = (value) => res.write(`data: ${JSON.stringify(value)}\n\n`);
	if (tool) {
		emit({ ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: tool.id, type: "function", function: { name: tool.name, arguments: JSON.stringify(tool.arguments) } }] }, finish_reason: null }] });
		emit({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: usage(inputTokens, outputTokens) });
	} else {
		emit({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: text ?? "ok" }, finish_reason: null }] });
		emit({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: usage(inputTokens, outputTokens) });
	}
	res.end("data: [DONE]\n\n");
}

class CompactionServer {
	server = createServer((req, res) => void this.handle(req, res).catch((error) => {
		res.writeHead(500, { "content-type": "application/json" });
		res.end(JSON.stringify({ error: { message: String(error) } }));
	}));
	requests = [];
	mainCounts = new Map();
	heldContemplator = new Map();
	interventionsSent = new Set();
	manualSawProbe = false;
	manualSawContinuation = false;
	automaticUnexpectedRestart = false;

	async start() {
		this.server.listen(0, "127.0.0.1");
		await once(this.server, "listening");
		return this.server.address().port;
	}

	async close() {
		this.server.close();
		await once(this.server, "close");
	}

	async releaseContemplator(scenario) {
		const held = this.heldContemplator.get(scenario);
		assert(held, `No held contemplator request for ${scenario}`);
		this.heldContemplator.delete(scenario);
		this.interventionsSent.add(scenario);
		await sendSse(held, {
			tool: { id: `probe-${scenario}`, name: "send_probe", arguments: { question: MANUAL_PROBE } },
		});
	}

	async handle(req, res) {
		let raw = "";
		for await (const chunk of req) raw += chunk;
		const body = JSON.parse(raw || "{}");
		const tools = toolsIn(body);
		const serialized = JSON.stringify(body.messages ?? []);
		const scenario = serialized.includes(MANUAL) || serialized.includes(MANUAL_CONTINUATION) || serialized.includes(MANUAL_PROBE)
			? MANUAL
			: serialized.includes(AUTOMATIC)
				? AUTOMATIC
				: undefined;
		const role = tools.has("record_observations") ? "observer" : tools.has("send_probe") ? "contemplator" : "main";
		this.requests.push({ role, scenario, body });
		const hasToolResult = (body.messages ?? []).some((message) => message.role === "tool");

		if (role === "observer") {
			if (hasToolResult) return sendSse(res, { text: "Observation complete.", delayMs: 100 });
			const sourceId = serialized.match(/Source entry id:\s*([a-zA-Z0-9_-]+)/)?.[1];
			assert(sourceId, "Compaction observer request lacked a source entry id");
			return sendSse(res, {
				delayMs: 100,
				tool: {
					id: `observe-${scenario}`,
					name: "record_observations",
					arguments: { observations: [{
						timestamp: "2026-08-15 00:00",
						content: `${scenario}: preserve this compaction checkpoint and its continuation requirement.`,
						relevance: "high",
						sourceEntryIds: [sourceId],
					}] },
				},
			});
		}

		if (role === "contemplator") {
			if (hasToolResult) return sendSse(res, { text: "Probe recorded." });
			if (this.interventionsSent.has(scenario)) return sendSse(res, { text: "No additional intervention." });
			assert(scenario === MANUAL, `Unexpected held contemplator request for ${scenario}`);
			assert(!this.heldContemplator.has(scenario), "Duplicate held contemplator request");
			this.heldContemplator.set(scenario, res);
			return;
		}

		assert(scenario, "Main request did not contain a compaction scenario marker");
		const count = (this.mainCounts.get(scenario) ?? 0) + 1;
		this.mainCounts.set(scenario, count);

		if (scenario === MANUAL) {
			if (count === 1) return sendSse(res, {
				delayMs: 250,
				tool: { id: "manual-bash", name: "bash", arguments: { command: `printf '${MANUAL}:checkpoint\\n'` } },
			});
			if (count === 2) {
				await waitFor(() => this.heldContemplator.has(MANUAL), "manual contemplator request before compact_context");
				await this.releaseContemplator(MANUAL);
				// Keep the primary request open while the contemplator's send_probe tool
				// queues its steer, then terminate this turn via compact_context. This is
				// the race: the queued steer must survive session compaction and resume.
				return sendSse(res, {
					delayMs: 500,
					tool: { id: "manual-compact", name: "compact_context", arguments: { short_continuation_prompt: MANUAL_CONTINUATION } },
				});
			}
			this.manualSawProbe ||= serialized.includes(MANUAL_PROBE);
			this.manualSawContinuation ||= serialized.includes(MANUAL_CONTINUATION);
			if (this.manualSawProbe && this.manualSawContinuation) return sendSse(res, { text: "MANUAL_COMPACTION_RESUMED" });
			return sendSse(res, { text: "Waiting for the remaining queued post-compaction message." });
		}

		if (count === 1) return sendSse(res, {
			delayMs: 250,
			tool: { id: "automatic-bash", name: "bash", arguments: { command: `printf '${AUTOMATIC}:checkpoint\\n'` } },
		});
		if (count === 2) return sendSse(res, { text: "AUTOMATIC_PRECOMPACTION_COMPLETE", outputTokens: 200 });
		this.automaticUnexpectedRestart = true;
		return sendSse(res, { text: "UNEXPECTED_PROACTIVE_RESTART" });
	}
}

class RpcClient {
	constructor(child) {
		this.child = child;
		this.nextId = 1;
		this.pending = new Map();
		this.events = [];
		this.stderr = "";
		child.stderr.on("data", (chunk) => { this.stderr += chunk; });
		const decoder = new StringDecoder("utf8");
		let buffer = "";
		child.stdout.on("data", (chunk) => {
			buffer += decoder.write(chunk);
			while (true) {
				const newline = buffer.indexOf("\n");
				if (newline < 0) break;
				const line = buffer.slice(0, newline).replace(/\r$/, "");
				buffer = buffer.slice(newline + 1);
				if (line) this.handle(JSON.parse(line));
			}
		});
	}

	handle(message) {
		if (message.type === "response" && message.id && this.pending.has(message.id)) {
			const pending = this.pending.get(message.id);
			this.pending.delete(message.id);
			if (message.success) pending.resolve(message.data);
			else pending.reject(new Error(message.error ?? `RPC ${message.command} failed`));
			return;
		}
		this.events.push(message);
	}

	command(command) {
		const id = `compaction-e2e-${this.nextId++}`;
		return new Promise((resolveResponse, reject) => {
			this.pending.set(id, { resolve: resolveResponse, reject });
			this.child.stdin.write(`${JSON.stringify({ id, ...command })}\n`);
		});
	}

	async entries() {
		return (await this.command({ type: "get_entries" })).entries;
	}
}

async function launchPi({ workspace, project, agentDir, sessions, providerExtension, compactAfterTokens, contemplatorEnabled }) {
	await mkdir(join(project, ".pi"), { recursive: true });
	await mkdir(agentDir, { recursive: true });
	await mkdir(sessions, { recursive: true });
	await writeFile(join(project, ".pi/settings.json"), JSON.stringify({
		compaction: { enabled: false, reserveTokens: 512, keepRecentTokens: 1 },
		"observational-memory": {
			observeAfterTokens: 1,
			reflectAfterTokens: 1000000,
			compactAfterTokens,
			agentMaxTurns: 4,
			model: { provider: "e2e", id: "mock-model", thinking: "off" },
			contemplatorEnabled,
			contemplatorModel: { provider: "e2e", id: "mock-model", thinking: "off" },
			contemplatorMinNewObservations: 1,
			contemplatorMinNewReflections: 1,
			contemplatorMinTurns: 1,
			showWorkerNotifications: false,
			showContemplatorMessages: true,
			reviewerEnabled: false,
			compactionObserverEnabled: false,
			debugLog: true,
		},
	}, null, 2));
	const child = spawn(PI, [
		"--mode", "rpc", "--provider", "e2e", "--model", "mock-model", "--thinking", "off",
		"--session-dir", sessions, "--offline", "--approve", "--no-extensions",
		"-e", providerExtension, "-e", EXTENSION,
	], {
		cwd: project,
		env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1" },
		stdio: ["pipe", "pipe", "pipe"],
	});
	const rpc = new RpcClient(child);
	await waitFor(async () => {
		try { return (await rpc.command({ type: "get_state" }))?.model?.provider === "e2e"; }
		catch { return false; }
	}, "Pi RPC startup");
	return { child, rpc, exited: once(child, "exit").then(([code, signal]) => ({ code, signal })) };
}

async function stopPi(instance) {
	instance.child.kill("SIGTERM");
	const result = await instance.exited;
	assert(result.code === 0 || result.code === 143 || result.signal === "SIGTERM", `Pi exited unexpectedly: ${JSON.stringify(result)}\n${instance.rpc.stderr}`);
}

async function run() {
	console.log("RPC compaction E2E test plan:\n  1. Main agent calls compact_context with an authored continuation\n  2. Contemplator queues a steer immediately before manual compaction\n  3. Manual compaction preserves the probe and resumes with the authored instruction\n  4. Proactive automatic compaction runs after a normally completed agent turn\n  5. Proactive maintenance does not restart the settled agent\n");
	const workspace = await mkdtemp(join(tmpdir(), "pi-contemplator-compaction-e2e-"));
	const server = new CompactionServer();
	let instance;
	try {
		const port = await server.start();
		const providerExtension = join(workspace, "mock-provider.ts");
		await writeFile(providerExtension, `export default function (pi) {\n  pi.registerProvider("e2e", {\n    name: "E2E Mock", baseUrl: "http://127.0.0.1:${port}/v1", apiKey: "e2e-test-key", api: "openai-completions",\n    models: [{ id: "mock-model", name: "Mock Model", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 }]\n  });\n}\n`);

		progress("TEST 1/2: agent-requested compact_context with queued contemplator probe");
		const manualBase = join(workspace, "manual");
		instance = await launchPi({
			workspace,
			project: join(manualBase, "project"),
			agentDir: join(manualBase, "agent"),
			sessions: join(manualBase, "sessions"),
			providerExtension,
			compactAfterTokens: 1000000,
			contemplatorEnabled: true,
		});
		const manualEventStart = instance.rpc.events.length;
		await instance.rpc.command({ type: "prompt", message: `${MANUAL}: perform work, then compact using compact_context and obey its continuation.` });
		await waitFor(() => instance.rpc.events.slice(manualEventStart).some((event) => event.type === "compaction_end" && event.reason === "manual" && event.result), "successful manual compaction event");
		await waitFor(() => server.manualSawProbe && server.manualSawContinuation, "post-compaction context containing both queued probe and authored continuation");
		await waitFor(async () => (await instance.rpc.entries()).some((entry) => entry.type === "message" && entry.message?.role === "assistant" && messageText(entry.message).includes("MANUAL_COMPACTION_RESUMED")), "manual resumed assistant response");
		const manualEntries = await instance.rpc.entries();
		const manualCompactions = manualEntries.filter((entry) => entry.type === "compaction");
		const manualProbeStates = manualEntries.filter((entry) => entry.customType === "om.contemplator.suggestion");
		assert(manualCompactions.length === 1, `Expected one manual compaction, got ${manualCompactions.length}`);
		assert(manualCompactions[0].details?.type === "om.folded", "Manual compaction did not use the observational-memory hook");
		assert(manualProbeStates.some((entry) => entry.data?.delivered === true), "Queued contemplator probe was not acknowledged after manual compaction");
		assert(!manualProbeStates.filter((entry) => entry.data?.delivered === false).some((pending) => !manualProbeStates.some((entry) => entry.data?.probeId === pending.data?.probeId && entry.data?.delivered === true)), "A manual-compaction probe remained pending");
		assert(manualEntries.some((entry) => entry.type === "message" && entry.message?.role === "assistant" && entry.message.content?.some?.((part) => part.type === "toolCall" && part.name === "compact_context")), "Main agent never called compact_context");
		assert(!instance.rpc.events.some((event) => event.type === "extension_error"), "Extension error during manual compaction race");
		progress("PASS 1/2: queued steer survived compaction and authored continuation resumed automatically");
		await stopPi(instance);
		instance = undefined;

		progress("TEST 2/2: proactive compaction after normal completion does not restart work");
		const autoBase = join(workspace, "automatic");
		instance = await launchPi({
			workspace,
			project: join(autoBase, "project"),
			agentDir: join(autoBase, "agent"),
			sessions: join(autoBase, "sessions"),
			providerExtension,
			compactAfterTokens: 1,
			contemplatorEnabled: false,
		});
		const autoEventStart = instance.rpc.events.length;
		await instance.rpc.command({ type: "prompt", message: `${AUTOMATIC}: perform enough work to cross the proactive compaction threshold.` });
		await waitFor(() => instance.rpc.events.slice(autoEventStart).some((event) => event.type === "compaction_end" && event.reason === "manual" && event.result), "successful proactive compaction event");
		// This delay is deliberately longer than the old immediate continuation and
		// retry windows. The pre-fix implementation sends a hidden followUp here,
		// producing a third provider request and failing this regression assertion.
		await sleep(1_500);
		const autoEntries = await instance.rpc.entries();
		const autoCompactions = autoEntries.filter((entry) => entry.type === "compaction");
		assert(autoCompactions.length >= 1, "Expected at least one proactive compaction");
		assert(autoCompactions.every((entry) => entry.details?.type === "om.folded"), "Proactive compaction did not use the observational-memory hook");
		assert(!autoEntries.some((entry) => entry.type === "message" && entry.message?.role === "assistant" && entry.message.content?.some?.((part) => part.type === "toolCall" && part.name === "compact_context")), "Automatic scenario unexpectedly depended on compact_context");
		assert(server.mainCounts.get(AUTOMATIC) === 2 && !server.automaticUnexpectedRestart, "Proactive compaction restarted normally completed agent work");
		assert(!autoEntries.some((entry) => entry.type === "custom_message" && entry.customType === "om.compaction.resume"), "Proactive compaction queued a hidden resume message");
		assert(!instance.rpc.events.some((event) => event.type === "extension_error"), "Extension error during proactive compaction");
		progress("PASS 2/2: proactive threshold compacted without restarting settled work");
		await stopPi(instance);
		instance = undefined;
		progress("ALL COMPACTION TESTS PASSED: manual continuation, queued-probe race, proactive threshold, and no settled-work restart");
	} catch (error) {
		console.error("Compaction E2E failure:", error?.stack ?? error);
		console.error("Mock requests:", server.requests.map((request) => `${request.role}:${request.scenario}`).join(", "));
		if (instance) {
			console.error("Recent RPC events:", JSON.stringify(instance.rpc.events.slice(-20), null, 2));
			console.error("Pi stderr:", instance.rpc.stderr);
		}
		throw error;
	} finally {
		if (instance?.child.exitCode === null) instance.child.kill("SIGKILL");
		await server.close().catch(() => {});
		if (process.env.E2E_KEEP) console.error(`Preserved compaction E2E workspace: ${workspace}`);
		else await rm(workspace, { recursive: true, force: true });
	}
}

run().catch((error) => {
	console.error(error?.stack ?? error);
	process.exitCode = 1;
});

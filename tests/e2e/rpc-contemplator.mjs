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
const PROBE_TEXT = "Memory evidence shows repeated assumptions; what direct check would distinguish the current approach from the alternative?";
const SCENARIOS = ["SCENARIO_PROBE", "SCENARIO_PROPOSAL", "SCENARIO_REJECT"];

function assert(condition, message) {
	if (!condition) throw new Error(message);
}

function sleep(ms) {
	return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function waitFor(check, message, timeoutMs = 15_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const value = await check();
		if (value) return value;
		await sleep(25);
	}
	throw new Error(`Timed out: ${message}`);
}

async function waitForBackgroundQuiet(rpc, server, quietMs = 500, timeoutMs = 15_000) {
	const deadline = Date.now() + timeoutMs;
	let signature = "";
	let stableSince = Date.now();
	while (Date.now() < deadline) {
		const entries = await rpc.entries();
		const next = `${entries.length}:${server.requests.length}`;
		if (next !== signature) {
			signature = next;
			stableSince = Date.now();
		} else if (Date.now() - stableSince >= quietMs) {
			return;
		}
		await sleep(50);
	}
	throw new Error("Timed out waiting for observer/contemplator/reviewer background work to settle");
}

function messageText(message) {
	if (typeof message?.content === "string") return message.content;
	if (!Array.isArray(message?.content)) return "";
	return message.content.map((part) => typeof part?.text === "string" ? part.text : "").join("\n");
}

function latestScenario(body) {
	const text = JSON.stringify(body.messages ?? []);
	let selected;
	let selectedAt = -1;
	for (const scenario of SCENARIOS) {
		const at = text.lastIndexOf(scenario);
		if (at > selectedAt) {
			selected = scenario;
			selectedAt = at;
		}
	}
	return selected;
}

function toolNames(body) {
	return new Set((body.tools ?? []).map((tool) => tool?.function?.name).filter(Boolean));
}

function usage(outputTokens = 1) {
	return { prompt_tokens: 20, completion_tokens: outputTokens, total_tokens: 20 + outputTokens };
}

function sendSse(res, { text, tool, outputTokens = 1 }) {
	res.writeHead(200, {
		"content-type": "text/event-stream",
		"cache-control": "no-cache",
		connection: "keep-alive",
	});
	const id = `chatcmpl-${Math.random().toString(16).slice(2)}`;
	const emit = (value) => res.write(`data: ${JSON.stringify(value)}\n\n`);
	const base = { id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "mock-model" };
	if (tool) {
		emit({ ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: tool.id, type: "function", function: { name: tool.name, arguments: JSON.stringify(tool.arguments) } }] }, finish_reason: null }] });
		emit({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: usage(outputTokens) });
	} else {
		emit({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: text ?? "ok" }, finish_reason: null }] });
		emit({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: usage(outputTokens) });
	}
	res.end("data: [DONE]\n\n");
}

class MockModelServer {
	server = createServer((req, res) => void this.handle(req, res).catch((error) => {
		res.writeHead(500, { "content-type": "application/json" });
		res.end(JSON.stringify({ error: { message: String(error) } }));
	}));
	requests = [];
	mainCounts = new Map();
	heldMain = new Map();
	interventionsSent = new Set();

	async start() {
		this.server.listen(0, "127.0.0.1");
		await once(this.server, "listening");
		return this.server.address().port;
	}

	async close() {
		this.server.close();
		await once(this.server, "close");
	}

	releaseMain(scenario) {
		const held = this.heldMain.get(scenario);
		assert(held, `No held main request for ${scenario}`);
		this.heldMain.delete(scenario);
		sendSse(held, { text: `Background work for ${scenario} can now be incorporated.` });
	}

	async handle(req, res) {
		let raw = "";
		for await (const chunk of req) raw += chunk;
		const body = JSON.parse(raw || "{}");
		const tools = toolNames(body);
		const scenario = latestScenario(body);
		const role = tools.has("record_observations")
			? "observer"
			: tools.has("send_probe")
				? "contemplator"
				: tools.has("submit_workflow_proposal") || tools.has("submit_software_proposal") || tools.has("review_concluded_no_proposal")
					? "reviewer"
					: "main";
		this.requests.push({ role, scenario, body });

		const hasToolResult = (body.messages ?? []).some((message) => message.role === "tool");
		if (role === "observer") {
			if (hasToolResult) return sendSse(res, { text: "Observation coverage complete." });
			const sourceId = JSON.stringify(body.messages ?? []).match(/Source entry id:\s*([a-zA-Z0-9_-]+)/)?.[1];
			assert(sourceId, "Observer request did not contain a source entry id");
			return sendSse(res, {
				tool: {
					id: `observe-${scenario}`,
					name: "record_observations",
					arguments: {
						observations: [{
							timestamp: "2026-08-15 00:00",
							content: `${scenario}: the primary agent repeatedly depends on an assumption that needs an independent check.`,
							relevance: "high",
							sourceEntryIds: [sourceId],
						}],
					},
				},
			});
		}

		if (role === "contemplator") {
			if (hasToolResult) return sendSse(res, { text: "Intervention recorded." });
			if (this.interventionsSent.has(scenario)) return sendSse(res, { text: "No additional intervention is warranted for this update." });
			this.interventionsSent.add(scenario);
			const memoryId = JSON.stringify(body.messages ?? []).match(/\[([a-f0-9]{12})\]/)?.[1] ?? "000000000000";
			if (scenario === "SCENARIO_PROBE") {
				return sendSse(res, { tool: { id: "probe-call", name: "send_probe", arguments: { question: `[${memoryId}] ${PROBE_TEXT}` } } });
			}
			return sendSse(res, {
				tool: {
					id: `review-call-${scenario}`,
					name: "request_review",
					arguments: {
						scope: scenario === "SCENARIO_PROPOSAL" ? "workflow" : "software",
						evidence: `[${memoryId}] ${scenario} recurring evidence`,
						concern: `${scenario}: determine whether the recurring assumption indicates a durable structural issue.`,
						review_focus: "Independently evaluate the evidence and reach one terminal outcome.",
						constraints: "Remain conceptual and preserve the user's requested behavior.",
					},
				},
			});
		}

		if (role === "reviewer") {
			if (hasToolResult) return sendSse(res, { text: "Terminal review complete." });
			if (scenario === "SCENARIO_PROPOSAL") {
				return sendSse(res, {
					tool: {
						id: "proposal-terminal",
						name: "submit_workflow_proposal",
						arguments: {
							title: "Reusable evidence checkpoint",
							summary: "Preserve a reusable checkpoint that tests the recurring assumption before repeated work continues.",
							evidence: "The cited memories show repeated reconstruction around the same uncertainty.",
							inefficiency: "The primary agent repeatedly spends work without obtaining distinguishing evidence.",
							conceptual_design: "Maintain a reusable evidence checkpoint that records the question, direct test, and result for later rounds.",
							inputs: "The active assumption and available direct evidence.",
							outputs: "A durable result that later reasoning can reuse.",
							integration: "Consult and refresh the checkpoint when the same uncertainty recurs.",
							expected_effect: "Reduce repeated investigation and improve reviewability.",
							uncertainties: "The primary agent must decide which checks are stable enough to preserve.",
						},
					},
				});
			}
			return sendSse(res, {
				tool: {
					id: "reject-terminal",
					name: "review_concluded_no_proposal",
					arguments: {
						reason: "The evidence is currently a single local symptom and does not justify a durable software proposal.",
						evidence_reviewed: "The cited observation and current primary-chat context were reviewed.",
						reconsider_if: "Reconsider if the same structural symptom recurs across independent changes.",
					},
				},
			});
		}

		assert(scenario, "Main request did not contain a scenario marker");
		const count = (this.mainCounts.get(scenario) ?? 0) + 1;
		this.mainCounts.set(scenario, count);
		const serialized = JSON.stringify(body.messages ?? []);
		if (count === 1) {
			return sendSse(res, {
				outputTokens: 200,
				tool: { id: `read-${scenario}`, name: "read", arguments: { path: "./fixture.txt" } },
			});
		}
		if (count === 2) {
			assert(!this.heldMain.has(scenario), `Main request already held for ${scenario}`);
			this.heldMain.set(scenario, res);
			return;
		}
		if (scenario === "SCENARIO_PROBE") {
			assert(serialized.includes(PROBE_TEXT), "Probe was absent from the next main-agent provider request");
			return sendSse(res, { text: "PROBE_RECEIVED_BY_MAIN_AGENT" });
		}
		if (scenario === "SCENARIO_PROPOSAL") {
			assert(serialized.includes("BACKGROUND WORKFLOW REVIEW PROPOSAL"), "Review proposal notice was absent from the next main-agent request");
			return sendSse(res, { text: "PROPOSAL_RECEIVED_BY_MAIN_AGENT" });
		}
		throw new Error(`Unexpected extra main request for ${scenario}`);
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
		this.attach(child.stdout);
	}

	attach(stream) {
		const decoder = new StringDecoder("utf8");
		let buffer = "";
		stream.on("data", (chunk) => {
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
			const { resolve: resolveResponse, reject } = this.pending.get(message.id);
			this.pending.delete(message.id);
			if (message.success) resolveResponse(message.data);
			else reject(new Error(message.error ?? `RPC ${message.command} failed`));
			return;
		}
		this.events.push(message);
	}

	command(command) {
		const id = `e2e-${this.nextId++}`;
		return new Promise((resolveResponse, reject) => {
			this.pending.set(id, { resolve: resolveResponse, reject });
			this.child.stdin.write(`${JSON.stringify({ id, ...command })}\n`);
		});
	}

	async entries() {
		return (await this.command({ type: "get_entries" })).entries;
	}

	async waitSettled(afterIndex) {
		await waitFor(() => this.events.slice(afterIndex).some((event) => event.type === "agent_settled"), "agent_settled RPC event", 20_000);
	}
}

async function run() {
	const workspace = await mkdtemp(join(tmpdir(), "pi-contemplator-e2e-"));
	const project = join(workspace, "project");
	const agentDir = join(workspace, "agent");
	const sessions = join(workspace, "sessions");
	const providerExtension = join(workspace, "mock-provider.ts");
	const server = new MockModelServer();
	let child;
	let rpc;
	try {
		await mkdir(join(project, ".pi"), { recursive: true });
		await mkdir(agentDir, { recursive: true });
		await mkdir(sessions, { recursive: true });
		await writeFile(join(project, "fixture.txt"), "deterministic fixture for the real read tool\n");
		await writeFile(join(project, ".pi/settings.json"), JSON.stringify({
			"observational-memory": {
				observeAfterTokens: 1,
				reflectAfterTokens: 1000000,
				compactAfterTokens: 1000000,
				agentMaxTurns: 4,
				model: { provider: "e2e", id: "mock-model", thinking: "off" },
				contemplatorEnabled: true,
				contemplatorModel: { provider: "e2e", id: "mock-model", thinking: "off" },
				contemplatorMinNewObservations: 1,
				contemplatorMinNewReflections: 1,
				contemplatorMinTurns: 1,
				showWorkerNotifications: false,
				showContemplatorMessages: true,
				reviewerEnabled: true,
				reviewerModel: { provider: "e2e", id: "mock-model", thinking: "off" },
				compactionObserverEnabled: false,
				debugLog: true,
			},
		}, null, 2));

		const port = await server.start();
		await writeFile(providerExtension, `export default function (pi) {\n  pi.registerProvider("e2e", {\n    name: "E2E Mock",\n    baseUrl: "http://127.0.0.1:${port}/v1",\n    apiKey: "e2e-test-key",\n    api: "openai-completions",\n    models: [{ id: "mock-model", name: "Mock Model", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 }]\n  });\n}\n`);

		child = spawn(PI, [
			"--mode", "rpc",
			"--provider", "e2e",
			"--model", "mock-model",
			"--thinking", "off",
			"--session-dir", sessions,
			"--offline",
			"--approve",
			"--no-extensions",
			"-e", providerExtension,
			"-e", EXTENSION,
		], {
			cwd: project,
			env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1" },
			stdio: ["pipe", "pipe", "pipe"],
		});
		rpc = new RpcClient(child);
		const exited = once(child, "exit").then(([code, signal]) => ({ code, signal }));

		await waitFor(async () => {
			try {
				const state = await rpc.command({ type: "get_state" });
				return state?.model?.provider === "e2e";
			} catch {
				return false;
			}
		}, "RPC startup with mock model");

		for (const scenario of SCENARIOS) {
			const eventStart = rpc.events.length;
			await rpc.command({ type: "prompt", message: `${scenario}: perform a multi-round task and keep working through tool results.` });
			await waitFor(() => server.heldMain.has(scenario), `${scenario} second main request`);

			if (scenario === "SCENARIO_PROBE") {
				await waitFor(async () => (await rpc.entries()).some((entry) => entry.customType === "om.contemplator.suggestion" && entry.data?.delivered === false), "pending contemplator probe");
			} else {
				const expectedOutcome = scenario === "SCENARIO_PROPOSAL" ? "proposal" : "no_proposal";
				await waitFor(async () => (await rpc.entries()).some((entry) => entry.customType === "om.review.result" && entry.data?.result?.outcome === expectedOutcome), `${expectedOutcome} review result`, 20_000);
				if (scenario === "SCENARIO_PROPOSAL") {
					await waitFor(async () => (await rpc.entries()).some((entry) => entry.customType === "om.reviewer.notice"), "queued reviewer proposal notice");
				}
			}

			server.releaseMain(scenario);
			await rpc.waitSettled(eventStart);
			// agent_settled covers the primary run, not fire-and-forget memory workers.
			// Do not begin the next scenario while a prior consolidation still owns
			// Runtime.consolidationPromise or its turn-end trigger can be skipped.
			await waitForBackgroundQuiet(rpc, server);
		}

		const entries = await rpc.entries();
		const observations = entries.filter((entry) => entry.customType === "om.observations.recorded");
		const probeTracking = entries.filter((entry) => entry.customType === "om.contemplator.suggestion" && typeof entry.data?.probeId === "string");
		const deliveredProbes = probeTracking.filter((entry) => entry.data?.delivered === true);
		const reviewRequests = entries.filter((entry) => entry.customType === "om.review.request");
		const reviewResultEntries = entries.filter((entry) => entry.customType === "om.review.result");
		const reviewResults = reviewResultEntries.map((entry) => entry.data?.result?.outcome);
		const reviewerMessages = entries.filter((entry) => entry.customType === "om.reviewer.message");
		const contemplatorMessages = entries.filter((entry) => entry.customType === "om.contemplator.message");
		const reviewerNotices = entries.filter((entry) => entry.customType === "om.reviewer.notice");
		const customMessages = entries.filter((entry) => entry.type === "custom_message");
		const latestProbeState = new Map(probeTracking.map((entry) => [entry.data.probeId, entry.data.delivered === true]));
		assert(observations.length >= 3, `Expected observer memories for all scenarios, got ${observations.length}`);
		assert(contemplatorMessages.length >= 6, "Expected persisted contemplator prompts and responses");
		assert(deliveredProbes.length === 1, `Expected exactly one acknowledged probe, got ${deliveredProbes.length}`);
		assert([...latestProbeState.values()].every(Boolean), "Every queued probe must finish acknowledged");
		assert(reviewRequests.length === 2, `Expected exactly two review requests, got ${reviewRequests.length}`);
		assert(reviewResultEntries.length === 2, `Expected exactly two review results, got ${reviewResultEntries.length}`);
		assert(reviewResults.includes("proposal"), "Expected a reviewer proposal result");
		assert(reviewResults.includes("no_proposal"), "Expected a reviewer no-proposal result");
		assert(reviewerMessages.length >= 2, "Expected durable reviewer transcripts");
		assert(reviewerNotices.length === 1, `Only the accepted proposal should queue a main-agent notice; got ${reviewerNotices.length}`);
		assert(customMessages.some((entry) => entry.customType === "om.contemplator.suggestion"), "Expected probe insertion in the main conversation stream");
		assert(customMessages.filter((entry) => entry.customType === "om.review.proposal").length === 1, "Expected exactly one proposal notice in the main conversation stream");
		assert(!rpc.events.some((event) => event.type === "extension_error"), "The real Pi harness reported an extension error");
		assert(server.requests.some((request) => request.role === "observer"), "Observer never reached the mock server");
		assert(server.requests.some((request) => request.role === "contemplator"), "Contemplator never reached the mock server");
		assert(server.requests.some((request) => request.role === "reviewer"), "Reviewer never reached the mock server");

		child.kill("SIGTERM");
		const result = await exited;
		assert(result.code === 0 || result.code === 143 || result.signal === "SIGTERM", `Pi exited unexpectedly: ${JSON.stringify(result)}\n${rpc.stderr}`);
		console.log(`RPC E2E passed: ${observations.length} observation batches, ${deliveredProbes.length} delivered probe, proposal + no-proposal reviewer outcomes.`);
	} catch (error) {
		console.error("E2E failure:", error?.stack ?? error);
		console.error("Mock requests:", server.requests.map((request) => `${request.role}:${request.scenario}`).join(", "));
		if (rpc) {
			console.error("Recent RPC events:", JSON.stringify(rpc.events.slice(-12), null, 2));
			console.error("Pi stderr:", rpc.stderr);
		}
		throw error;
	} finally {
		if (child && child.exitCode === null) child.kill("SIGKILL");
		await server.close().catch(() => {});
		if (process.env.E2E_KEEP) console.error(`Preserved E2E workspace: ${workspace}`);
		else await rm(workspace, { recursive: true, force: true });
	}
}

run().catch((error) => {
	console.error(error?.stack ?? error);
	process.exitCode = 1;
});

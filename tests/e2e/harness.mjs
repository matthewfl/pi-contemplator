import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

export const ROOT = resolve(dirname(new URL(import.meta.url).pathname), "../..");
export const PI = join(ROOT, "node_modules/.bin/pi");
export const EXTENSION = join(ROOT, "src/index.ts");

export function assert(condition, message) {
	if (!condition) throw new Error(message);
}

export function sleep(ms) {
	return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

export async function waitFor(check, message, timeoutMs = 20_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const value = await check();
		if (value) return value;
		await sleep(25);
	}
	throw new Error(`Timed out: ${message}`);
}

export function textOf(message) {
	if (typeof message?.content === "string") return message.content;
	if (!Array.isArray(message?.content)) return "";
	return message.content.map((part) => typeof part?.text === "string" ? part.text : "").join("\n");
}

export function toolNames(body) {
	return new Set((body.tools ?? []).map((tool) => tool?.function?.name).filter(Boolean));
}

export function classify(body) {
	const tools = toolNames(body);
	if (tools.has("record_observations")) return "observer";
	if (tools.has("summarize") && tools.has("fix_summary") && tools.has("done")) return "summarizer";
	if (tools.has("send_probe")) return "contemplator";
	if (tools.has("submit_workflow_proposal") || tools.has("submit_software_proposal") || tools.has("review_concluded_no_proposal")) return "reviewer";
	return "main";
}

export function usage(input = 20, output = 1) {
	return { prompt_tokens: input, completion_tokens: output, total_tokens: input + output };
}

export async function sendSse(res, { text, tool, inputTokens = 20, outputTokens = 1, delayMs = 0, finishReason } = {}) {
	if (delayMs) await sleep(delayMs);
	res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
	const id = `chatcmpl-${Math.random().toString(16).slice(2)}`;
	const base = { id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "mock-model" };
	const emit = (value) => res.write(`data: ${JSON.stringify(value)}\n\n`);
	if (tool) {
		emit({ ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: tool.id, type: "function", function: { name: tool.name, arguments: JSON.stringify(tool.arguments) } }] }, finish_reason: null }] });
		emit({ ...base, choices: [{ index: 0, delta: {}, finish_reason: finishReason ?? "tool_calls" }], usage: usage(inputTokens, outputTokens) });
	} else {
		emit({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: text ?? "ok" }, finish_reason: null }] });
		emit({ ...base, choices: [{ index: 0, delta: {}, finish_reason: finishReason ?? "stop" }], usage: usage(inputTokens, outputTokens) });
	}
	res.end("data: [DONE]\n\n");
}

export class ModelServer {
	constructor(router) {
		this.router = router;
		this.server = createServer((req, res) => void this.handle(req, res));
		this.requests = [];
		this.active = 0;
		this.maxActive = 0;
		this.activeByRole = new Map();
		this.maxActiveByRole = new Map();
	}
	async handle(req, res) {
		this.active++;
		this.maxActive = Math.max(this.maxActive, this.active);
		let role;
		let request;
		try {
			let raw = "";
			for await (const chunk of req) raw += chunk;
			const body = JSON.parse(raw || "{}");
			role = classify(body);
			const roleActive = (this.activeByRole.get(role) ?? 0) + 1;
			this.activeByRole.set(role, roleActive);
			this.maxActiveByRole.set(role, Math.max(this.maxActiveByRole.get(role) ?? 0, roleActive));
			request = { body, role, text: JSON.stringify(body.messages ?? []), startedAt: Date.now() };
			this.requests.push(request);
			await this.router(request, res, this);
		} catch (error) {
			if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
			if (!res.writableEnded) res.end(JSON.stringify({ error: { message: String(error) } }));
		} finally {
			if (request) request.endedAt = Date.now();
			if (role) this.activeByRole.set(role, Math.max(0, (this.activeByRole.get(role) ?? 1) - 1));
			this.active--;
		}
	}
	async start() {
		this.server.listen(0, "127.0.0.1");
		await once(this.server, "listening");
		return this.server.address().port;
	}
	async close() {
		this.server.close();
		await once(this.server, "close");
	}
}

export class RpcClient {
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
		this.events.push({ ...message, receivedAt: Date.now() });
	}
	command(command) {
		const id = `e2e-${this.nextId++}`;
		return new Promise((resolveResponse, reject) => {
			this.pending.set(id, { resolve: resolveResponse, reject });
			this.child.stdin.write(`${JSON.stringify({ id, ...command })}\n`);
		});
	}
	async entries() { return (await this.command({ type: "get_entries" })).entries; }
	async state() { return this.command({ type: "get_state" }); }
	async waitSettled(after = 0, timeoutMs = 20_000) {
		return waitFor(() => this.events.slice(after).some((event) => event.type === "agent_settled"), "agent_settled", timeoutMs);
	}
}

export async function createWorkspace(prefix = "pi-contemplator-e2e-") {
	const root = await mkdtemp(join(tmpdir(), prefix));
	return {
		root,
		project: join(root, "project"),
		agentDir: join(root, "agent"),
		sessions: join(root, "sessions"),
		providerExtension: join(root, "provider.ts"),
		async cleanup() { if (!process.env.E2E_KEEP) await rm(root, { recursive: true, force: true }); },
	};
}

export async function prepareWorkspace(workspace, port, settings, models = [{ id: "mock-model", contextWindow: 128000 }]) {
	await mkdir(join(workspace.project, ".pi"), { recursive: true });
	await mkdir(workspace.agentDir, { recursive: true });
	await mkdir(workspace.sessions, { recursive: true });
	await writeFile(join(workspace.project, ".pi/settings.json"), JSON.stringify(settings, null, 2));
	const modelDefs = models.map((model) => ({ id: model.id, name: model.id, reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: model.contextWindow ?? 128000, maxTokens: model.maxTokens ?? 4096 }));
	await writeFile(workspace.providerExtension, `export default function (pi) { pi.registerProvider("e2e", { name: "E2E", baseUrl: "http://127.0.0.1:${port}/v1", apiKey: "test", api: "openai-completions", models: ${JSON.stringify(modelDefs)} }); }\n`);
}

export function omSettings(overrides = {}) {
	return { "observational-memory": {
		observeAfterTokens: 1, compactAfterTokens: 1000000,
		agentMaxTurns: 8, model: { provider: "e2e", id: "mock-model", thinking: "off" },
		contemplatorEnabled: true, contemplatorModel: { provider: "e2e", id: "mock-model", thinking: "off" },
		contemplatorMinNewObservations: 1, contemplatorMinTurns: 1,
		showWorkerNotifications: false, showContemplatorMessages: true, reviewerEnabled: true, summarizerEnabled: false,
		reviewerModel: { provider: "e2e", id: "mock-model", thinking: "off" }, compactionObserverEnabled: false,
		debugLog: true, ...overrides,
	} };
}

export async function launchPi(workspace, { session, model = "mock-model", extraExtensions = [] } = {}) {
	const args = ["--mode", "rpc", "--provider", "e2e", "--model", model, "--thinking", "off", "--session-dir", workspace.sessions, "--offline", "--approve", "--no-extensions", "-e", workspace.providerExtension, "-e", EXTENSION];
	for (const extension of extraExtensions) args.push("-e", extension);
	if (session) args.push("--session", session);
	const child = spawn(PI, args, { cwd: workspace.project, env: { ...process.env, PI_CODING_AGENT_DIR: workspace.agentDir, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1" }, stdio: ["pipe", "pipe", "pipe"] });
	const rpc = new RpcClient(child);
	const exited = once(child, "exit").then(([code, signal]) => ({ code, signal }));
	await waitFor(async () => { try { return (await rpc.state())?.model?.provider === "e2e"; } catch { return false; } }, "Pi startup");
	return { child, rpc, exited };
}

export async function stopPi(instance, signal = "SIGTERM") {
	if (instance.child.exitCode === null) instance.child.kill(signal);
	const result = await instance.exited;
	assert(result.code === 0 || result.code === 143 || result.signal === signal || result.signal === "SIGKILL", `Pi exited unexpectedly: ${JSON.stringify(result)}\n${instance.rpc.stderr}`);
}

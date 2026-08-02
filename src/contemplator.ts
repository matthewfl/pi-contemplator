import { agentLoop, type AgentContext, type AgentLoopConfig, type AgentMessage, type AgentTool } from "@earendil-works/pi-agent-core";
import { Type, type Message, type Model } from "@earendil-works/pi-ai";
import type { Static } from "typebox";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import { generateSummary } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { fullProjection, type Entry } from "./session-ledger/index.js";
import { createSearchMemoriesAgentTool } from "./tools/search-memories.js";
import { createRecallAgentTool } from "./tools/recall-observation.js";
import type { MemoryUpdateCtx, Runtime } from "./runtime.js";
import { logAgentStreamError } from "./agents/stream-errors.js";
import { debugLog, withDebugLogContext } from "./debug-log.js";
import { boundedMaxTokens, AGENT_LOOP_MAX_TOKENS } from "./model-budget.js";

const CONTEMPLATOR_SYSTEM = `You are the background contemplator supporting a primary agent. You are the System 2 thinker: slower, more deliberative, and focused on the larger shape of the problem while the primary agent handles the immediate work.

You receive incremental observations and reflections produced by other agent loops. Some memories summarize user messages. Pay extra attention to memories about the user’s intent, priorities, constraints, and desired outcome.

Each memory has an identifier. Mention relevant identifiers in a probe when they would help the primary agent recover the supporting context.

Maintain an evolving understanding of:

* what the user is ultimately trying to accomplish;
* the primary agent’s apparent direction;
* important assumptions and unresolved questions;
* connections and recurring patterns across memories;
* alternative ways to frame or decompose the problem.

Look for high-level insights that could help the primary agent:

* focus more clearly on the actual goal;
* question an assumption underlying its current direction;
* discover a useful connection between memories;
* break the problem into smaller or more revealing units;
* find a simpler or more productive framing;
* recognize that it is stuck in a loop;
* notice repeated work or an approach that is clearly wasting time;
* reconsider a direction weakened by new evidence.

Prefer asking one probing question over prescribing a solution. A good probe helps the primary agent examine its reasoning, distinguish between competing explanations, identify a useful intermediate step, or notice an inefficient pattern.

For example:

* “Memories O14 and O19 suggest the same failure is recurring after each broad change. Is there a smaller signal that could distinguish the likely causes before repeating the full workflow?”
* “R7 assumes the user wants the existing behavior replaced, but O22 emphasizes preserving it. Could the problem be reframed as adding a layer rather than replacing the current one?”
* “O31 and O34 both depend on the same unstated assumption. What result would show that assumption is false?”

You have access to a search_memories tool for finding older observations and reflections on the current branch. Use it when the updates provided do not contain enough context, searching with distinctive terms rather than broad questions. The results include memory identifiers that you can cite in a probe. You also have a recall tool for recovering exact source context behind a specific memory identifier; use it when a search result is important but compressed.

Do not ask about routine execution details or basic tasks the primary agent can manage itself. Low-level details such as tests, commands, files, syntax, or programming language matter only when they reveal a broader strategic issue, repeated bottleneck, or useful way to reduce the problem.

Do not try to manage the primary agent, provide status updates, repeat memories, offer encouragement, or produce a probe merely to remain active. Do not invent details absent from the memories.

When one high-signal probe could materially improve the primary agent’s understanding or approach, call send_probe with a concise, natural-language message. Include a short statement of the relevant pattern when the question would otherwise lack context.

Send only one probe per update. If no useful probe exists, do not call the tool.`;

interface PendingUpdate { observations: string[]; reflections: string[]; }

function mergeMemoryLines(existing: string[], incoming: string[]): string[] {
	const merged = [...existing];
	const seen = new Set(existing.map((line) => line.match(/^\[([^\]]+)\]/)?.[1] ?? line));
	for (const line of incoming) {
		const key = line.match(/^\[([^\]]+)\]/)?.[1] ?? line;
		if (seen.has(key)) continue;
		seen.add(key);
		merged.push(line);
	}
	return merged;
}
const CONTEMPLATOR_MESSAGE = "om.contemplator.message";
const CONTEMPLATOR_STATE = "om.contemplator.state";
const CONTEMPLATOR_SUGGESTION = "om.contemplator.suggestion";
const SendProbeSchema = Type.Object({ question: Type.String({ minLength: 1, description: "One concise, high-level probing question, optionally preceded by one short sentence of context." }) });
type SendProbeArgs = Static<typeof SendProbeSchema>;

function createSendProbeTool(onProbe: (question: string) => void): AgentTool<typeof SendProbeSchema> {
	return {
		name: "send_probe",
		label: "Send probe",
		description: "Send one concise, high-level probing question to the primary agent asynchronously. Use it only when the question could materially improve the agent’s framing, expose a weak assumption, break an unproductive loop, or reveal a better decomposition. The message must contain a focused question, optionally preceded by one short sentence of context. Include relevant memory identifiers when useful. Do not use it for routine reminders, status updates, or direct task management.",
		parameters: SendProbeSchema,
		execute: async (_toolCallId, params: SendProbeArgs) => {
			const question = params.question.trim();
			onProbe(question);
			debugLog("contemplator.tool_call", {
				tool: "send_probe",
				suggestionLength: question.length,
			});
			return {
				content: [{ type: "text", text: "Probe queued for the primary agent's next context." }],
				details: { queued: true },
			};
		},
	};
}

export class Contemplator {
	private history: AgentMessage[] = [];
	private pending: PendingUpdate | undefined;
	private running = false;
	private seenObservationIds = new Set<string>();
	private seenReflectionIds = new Set<string>();
	private deliveredProbeIds = new Set<string>();
	private requeuedProbeIds = new Set<string>();
	private sessionGeneration = 0;
	private turnsSinceRun = 0;
	private restoredTipId: string | undefined;

	constructor(private readonly pi: ExtensionAPI, private readonly runtime: Runtime) {}

	register(): void {
		this.runtime.setMemoryUpdateListener((ctx) => this.withDebugContext(ctx, () => this.observeTurn(ctx)));
		this.pi.on("session_start", (_event: any, ctx: ExtensionContext) => {
			this.sessionGeneration++;
			this.restore(ctx, true);
		});
		this.pi.on("session_compact", (_event: any, ctx: ExtensionContext) => {
			if (this.history.length === 0) return;
			// The in-flight prompt is persisted by flush after its agent loop. Do not
			// snapshot it here or compaction would make restore replay it twice.
			const history = this.running ? this.history.slice(0, -1) : this.history;
			this.pi.appendEntry(CONTEMPLATOR_STATE, { version: 1, history });
			this.markTipPersisted(ctx);
			debugLog("contemplator.state_persisted", { historyMessageCount: history.length, running: this.running });
		});
		this.pi.on("context", (event: any, ctx: ExtensionContext) => {
			const delivered = event.messages?.find((message: any) => message?.role === "custom" && message.customType === CONTEMPLATOR_SUGGESTION && typeof message.details?.probeId === "string");
			if (!delivered || this.deliveredProbeIds.has(delivered.details.probeId)) return;
			this.deliveredProbeIds.add(delivered.details.probeId);
			this.pi.appendEntry(CONTEMPLATOR_SUGGESTION, {
				version: 1,
				suggestion: typeof delivered.details.question === "string" ? delivered.details.question : String(delivered.content ?? ""),
				probeId: delivered.details.probeId,
				delivered: true,
			});
			this.markTipPersisted(ctx);
			debugLog("contemplator.suggestion_delivered", { probeId: delivered.details.probeId });
		});
		this.pi.on("turn_end", (_event: any, ctx: ExtensionContext) => {
			this.turnsSinceRun++;
			this.withDebugContext(ctx, () => this.observeTurn(ctx));
		});
	}

	private withDebugContext<T>(ctx: MemoryUpdateCtx, fn: () => T): T {
		this.runtime.ensureConfig(ctx.cwd);
		const sessionManager = ctx.sessionManager as { getSessionId?: () => string; getSessionFile?: () => string };
		return withDebugLogContext({
			enabled: this.runtime.config.debugLog === true,
			cwd: ctx.cwd,
			sessionId: sessionManager.getSessionId?.(),
			sessionFile: sessionManager.getSessionFile?.(),
		}, fn);
	}

	private restore(ctx: MemoryUpdateCtx, resetTracking = false): void {
		const entries = ctx.sessionManager.getBranch() as Entry[];
		const tipId = entries.at(-1)?.id;
		if (this.running && !resetTracking) return;
		if (tipId === this.restoredTipId && !resetTracking) return;
		this.history = [];
		if (resetTracking) {
			this.deliveredProbeIds.clear();
			this.requeuedProbeIds.clear();
			const projection = fullProjection(entries);
			this.seenObservationIds = new Set(projection.observations.map((item) => item.id));
			this.seenReflectionIds = new Set(projection.reflections.map((item) => item.id));
			this.pending = undefined;
		}
		let undeliveredSuggestion: { question: string; probeId?: string } | undefined;
		for (const entry of entries) {
			if (entry.customType === CONTEMPLATOR_STATE && entry.data && typeof entry.data === "object") {
				const state = entry.data as { history?: unknown };
				if (Array.isArray(state.history)) this.history = state.history.filter((message): message is AgentMessage => !!message && typeof message === "object");
			}
			if (entry.customType === CONTEMPLATOR_MESSAGE && entry.data && typeof entry.data === "object") {
				const data = entry.data as { message?: unknown; compacted?: unknown };
				const message = data.message;
				if (message && typeof message === "object") {
					if (data.compacted === true) this.history = [message as AgentMessage];
					else this.history.push(message as AgentMessage);
				}
			}
			if (entry.customType === CONTEMPLATOR_SUGGESTION && entry.data && typeof entry.data === "object") {
				const data = entry.data as { suggestion?: unknown; delivered?: unknown; probeId?: unknown };
				if (data.delivered === true) {
					if (typeof data.probeId === "string") this.deliveredProbeIds.add(data.probeId);
					undeliveredSuggestion = undefined;
				}
				if (typeof data.suggestion === "string" && data.delivered !== true) {
					undeliveredSuggestion = { question: data.suggestion, probeId: typeof data.probeId === "string" ? data.probeId : undefined };
				}
			}
		}
		this.restoredTipId = tipId;
		if (undeliveredSuggestion?.probeId && !this.requeuedProbeIds.has(undeliveredSuggestion.probeId)) {
			this.requeuedProbeIds.add(undeliveredSuggestion.probeId);
			this.queueProbe(ctx, undeliveredSuggestion.question, "restore", undeliveredSuggestion.probeId);
		}
	}

	private observeTurn(ctx: MemoryUpdateCtx): void {
		this.restore(ctx);
		this.runtime.ensureConfig(ctx.cwd);
		if (!this.runtime.config.contemplatorEnabled) {
			debugLog("contemplator.skipped", { reason: "disabled" });
			return;
		}
		if (this.runtime.config.passive) {
			debugLog("contemplator.skipped", { reason: "passive" });
			return;
		}
		const projection = fullProjection(ctx.sessionManager.getBranch() as Entry[]);
		const observations = projection.observations.map((item) => `[${item.id}] ${item.content}`);
		const reflections = projection.reflections.map((item) => `[${item.id}] ${item.content}`);
		const newObservations = observations.filter((line) => {
			const id = line.match(/^\[([^\]]+)\]/)?.[1] ?? line;
			return !this.seenObservationIds.has(id);
		});
		const newReflections = reflections.filter((line) => {
			const id = line.match(/^\[([^\]]+)\]/)?.[1] ?? line;
			return !this.seenReflectionIds.has(id);
		});
		for (const line of newObservations) this.seenObservationIds.add(line.match(/^\[([^\]]+)\]/)?.[1] ?? line);
		for (const line of newReflections) this.seenReflectionIds.add(line.match(/^\[([^\]]+)\]/)?.[1] ?? line);
		debugLog("contemplator.update", {
			observationCount: observations.length,
			reflectionCount: reflections.length,
			newObservationCount: newObservations.length,
			newReflectionCount: newReflections.length,
			turnsSinceRun: this.turnsSinceRun,
			pending: this.pending !== undefined,
			running: this.running,
		});
		if (newObservations.length > 0 || newReflections.length > 0) {
			this.pending = {
				observations: mergeMemoryLines(this.pending?.observations ?? [], newObservations),
				reflections: mergeMemoryLines(this.pending?.reflections ?? [], newReflections),
			};
		}
		if (!this.pending) return;
		const enoughMemories = this.pending.observations.length >= this.runtime.config.contemplatorMinNewObservations || this.pending.reflections.length >= this.runtime.config.contemplatorMinNewReflections;
		if (!enoughMemories || this.turnsSinceRun < this.runtime.config.contemplatorMinTurns) {
			debugLog("contemplator.waiting", {
				enoughMemories,
				turnsSinceRun: this.turnsSinceRun,
				minTurns: this.runtime.config.contemplatorMinTurns,
				minNewObservations: this.runtime.config.contemplatorMinNewObservations,
				minNewReflections: this.runtime.config.contemplatorMinNewReflections,
			});
			return;
		}
		debugLog("contemplator.triggered", {
			pendingObservationCount: this.pending.observations.length,
			pendingReflectionCount: this.pending.reflections.length,
			turnsSinceRun: this.turnsSinceRun,
		});
		void this.flush(ctx);
	}

	private async flush(ctx: MemoryUpdateCtx): Promise<void> {
		if (this.running || !this.pending) {
			debugLog("contemplator.flush_skipped", { reason: this.running ? "already_running" : "no_pending_update" });
			return;
		}
		const update = this.pending;
		this.pending = undefined;
		const turnsBeforeRun = this.turnsSinceRun;
		const sessionGeneration = this.sessionGeneration;
		this.running = true;
		this.turnsSinceRun = 0;
		const startedAt = Date.now();
		let failed = false;
		debugLog("contemplator.start", {
			newObservationCount: update.observations.length,
			newReflectionCount: update.reflections.length,
			historyMessageCount: this.history.length,
		});
		try {
			const resolved = await this.runtime.resolveModel({
				model: ctx.model,
				modelRegistry: ctx.modelRegistry,
				hasUI: ctx.hasUI,
				ui: ctx.ui,
				configuredModel: this.runtime.config.contemplatorModel,
			});
			if (!resolved.ok) {
				failed = true;
				debugLog("contemplator.model_unavailable", { reason: resolved.reason });
				if (sessionGeneration === this.sessionGeneration) {
					const pending = this.pending as PendingUpdate | undefined;
					this.pending = {
						observations: mergeMemoryLines(pending?.observations ?? [], update.observations),
						reflections: mergeMemoryLines(pending?.reflections ?? [], update.reflections),
					};
					this.turnsSinceRun = turnsBeforeRun;
				}
				return;
			}
			if (sessionGeneration !== this.sessionGeneration) {
				debugLog("contemplator.flush_stale", { reason: "session_changed" });
				return;
			}
			const selectedModel = resolved.model as { provider?: unknown; id?: unknown; contextWindow?: unknown };
			debugLog("contemplator.model_resolved", {
				provider: selectedModel.provider,
				modelId: selectedModel.id,
				contextWindow: selectedModel.contextWindow,
			});
			const prompt: Message = { role: "user", content: [{ type: "text", text: `NEW MEMORY UPDATE\n\nOBSERVATIONS:\n${update.observations.join("\n") || "(none)"}\n\nREFLECTIONS:\n${update.reflections.join("\n") || "(none)"}\n\nConsider these updates in the context of the accumulated memories. Call send_probe only when one focused question could materially improve how the primary agent understands, frames, decomposes, or proceeds with the problem.` }], timestamp: Date.now() };
			this.history.push(prompt);
			let probe: string | undefined;
			const getBranch = () => ctx.sessionManager.getBranch() as Entry[];
			const searchMemoriesTool = createSearchMemoriesAgentTool(getBranch);
			const recallTool = createRecallAgentTool(getBranch);
			const sendProbe = createSendProbeTool((question) => {
				probe = question;
			});
			const context: AgentContext = { systemPrompt: CONTEMPLATOR_SYSTEM, messages: this.history.slice(0, -1), tools: [searchMemoriesTool as AgentTool<any>, recallTool as AgentTool<any>, sendProbe as AgentTool<any>] };
			const config: AgentLoopConfig = {
				model: resolved.model as Model<any>,
				apiKey: resolved.apiKey,
				headers: resolved.headers,
				maxTokens: boundedMaxTokens(resolved.model as Model<any>, AGENT_LOOP_MAX_TOKENS),
				convertToLlm: (messages) => messages as Message[],
				toolExecution: "sequential",
			};
			const stream = agentLoop([prompt], context, config, undefined, streamSimple);
			for await (const event of stream) logAgentStreamError("contemplator", event);
			const result = await stream.result();
			const assistant = [...result].reverse().find((message) => message.role === "assistant");
			debugLog("contemplator.result", {
				messageCount: result.length,
				assistantFound: assistant !== undefined,
				assistantStopReason: assistant && "stopReason" in assistant ? assistant.stopReason : undefined,
				suggestionQueued: probe !== undefined,
			});
			if (sessionGeneration === this.sessionGeneration) {
				this.pi.appendEntry(CONTEMPLATOR_MESSAGE, { version: 1, message: prompt });
				this.markTipPersisted(ctx);
			}
			if (assistant && sessionGeneration === this.sessionGeneration) {
				this.history.push(assistant);
				this.pi.appendEntry(CONTEMPLATOR_MESSAGE, { version: 1, message: assistant });
				this.markTipPersisted(ctx);
			}
			if (probe && sessionGeneration === this.sessionGeneration) this.queueProbe(ctx, probe, "send_probe");
			if (sessionGeneration === this.sessionGeneration) await this.compactHistory(resolved.model as Model<any>, resolved.apiKey, resolved.headers);
		} catch (error) {
			failed = true;
			debugLog("contemplator.error", { errorMessage: error instanceof Error ? error.message : String(error) });
			if (sessionGeneration === this.sessionGeneration) {
				const pending = this.pending as PendingUpdate | undefined;
				this.pending = {
					observations: mergeMemoryLines(pending?.observations ?? [], update.observations),
					reflections: mergeMemoryLines(pending?.reflections ?? [], update.reflections),
				};
				this.turnsSinceRun = turnsBeforeRun;
			}
		} finally {
			this.running = false;
			debugLog("contemplator.complete", {
				durationMs: Date.now() - startedAt,
				historyMessageCount: this.history.length,
				pendingUpdate: this.pending !== undefined,
			});
			if (!failed && sessionGeneration === this.sessionGeneration && this.pending) void this.flush(ctx);
		}
	}

	private queueProbe(ctx: MemoryUpdateCtx, question: string, source: "send_probe" | "restore", existingProbeId?: string): void {
		const probeId = existingProbeId ?? `${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`;
		this.pi.sendMessage({
			customType: CONTEMPLATOR_SUGGESTION,
			content: `Background contemplator probe (advisory):\n${question}`,
			display: false,
			details: { version: 1, question, source, probeId },
		}, { deliverAs: "steer", triggerTurn: false });
		this.pi.appendEntry(CONTEMPLATOR_SUGGESTION, { version: 1, suggestion: question, delivered: false, source, probeId });
		this.markTipPersisted(ctx);
		debugLog("contemplator.suggestion_queued", {
			probeId,
			suggestionLength: question.length,
			delivery: "pi.sendMessage",
			deliverAs: "steer",
			triggerTurn: false,
			source,
		});
	}

	private markTipPersisted(ctx: MemoryUpdateCtx): void {
		this.restoredTipId = (ctx.sessionManager.getBranch() as Entry[]).at(-1)?.id;
	}

	private async compactHistory(model: Model<any>, apiKey: string, headers?: Record<string, string>): Promise<void> {
		const serializedLength = this.history.reduce((total, message) => total + JSON.stringify(message).length, 0);
		if (this.history.length < 12 || serializedLength < 60_000) return;
		const previousMessageCount = this.history.length;
		debugLog("contemplator.compaction_start", {
			historyMessageCount: previousMessageCount,
			serializedLength,
		});
		const summary = await generateSummary(this.history as AgentMessage[], model, 4_000, apiKey, headers);
		const summaryModel = model as Model<any> & { api?: unknown; provider?: string; id?: string };
		this.history = [{
			role: "assistant",
			content: [{ type: "text", text: `Previous contemplator context summary:\n${summary}` }],
			api: summaryModel.api,
			provider: summaryModel.provider ?? "unknown",
			model: summaryModel.id ?? "contemplator",
			usage: {
				input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		} as AgentMessage];
		this.pi.appendEntry(CONTEMPLATOR_MESSAGE, { version: 1, compacted: true, message: this.history[0] });
		debugLog("contemplator.compaction_complete", {
			previousMessageCount,
			newMessageCount: this.history.length,
			summaryLength: summary.length,
		});
	}
}

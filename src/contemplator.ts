import { agentLoop, type AgentContext, type AgentLoopConfig, type AgentMessage, type AgentTool } from "@earendil-works/pi-agent-core";
import { Type, type Message, type Model } from "@earendil-works/pi-ai";
import type { Static } from "typebox";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import { generateSummary } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { fullProjection, type Entry } from "./session-ledger/index.js";
import type { MemoryUpdateCtx, Runtime } from "./runtime.js";
import { logAgentStreamError } from "./agents/stream-errors.js";
import { debugLog, withDebugLogContext } from "./debug-log.js";
import { boundedMaxTokens, AGENT_LOOP_MAX_TOKENS } from "./model-budget.js";

const CONTEMPLATOR_SYSTEM = `You are a background contemplator supporting a coding assistant.

Review incremental observations and reflections from the assistant's work. Maintain continuity across updates and emit a suggestion only when it would materially help the primary coding agent make a better decision, avoid repeated work, or notice an important risk.

You have no coding tools and must not perform work. Do not invent facts, repeat routine status, or produce general encouragement. If a suggestion would materially help the primary agent, call the send_steer tool with one concise, actionable suggestion. Do not send ordinary text as a suggestion; if there is no useful suggestion, do not call the tool.`;

interface PendingUpdate { observations: string[]; reflections: string[]; }
const CONTEMPLATOR_MESSAGE = "om.contemplator.message";
const CONTEMPLATOR_SUGGESTION = "om.contemplator.suggestion";
const SendSteerSchema = Type.Object({ suggestion: Type.String({ minLength: 1 }) });
type SendSteerArgs = Static<typeof SendSteerSchema>;

export class Contemplator {
	private history: AgentMessage[] = [];
	private pending: PendingUpdate | undefined;
	private running = false;
	private lastObservationCount = 0;
	private lastReflectionCount = 0;
	private turnsSinceRun = 0;
	private pendingSuggestion: string | undefined;
	private restoredTipId: string | undefined;

	constructor(private readonly pi: ExtensionAPI, private readonly runtime: Runtime) {}

	register(): void {
		this.runtime.setMemoryUpdateListener((ctx) => this.withDebugContext(ctx, () => this.observeTurn(ctx)));
		this.pi.on("session_start", (_event: any, ctx: ExtensionContext) => this.restore(ctx));
		this.pi.on("turn_end", (_event: any, ctx: ExtensionContext) => {
			this.turnsSinceRun++;
			this.withDebugContext(ctx, () => this.observeTurn(ctx));
		});
		this.pi.on("context", (_event: any, ctx: ExtensionContext) => this.withDebugContext(ctx as MemoryUpdateCtx, () => {
			if (!this.pendingSuggestion) return;
			const suggestion = this.pendingSuggestion;
			this.pendingSuggestion = undefined;
			debugLog("contemplator.suggestion_injected", { suggestionLength: suggestion.length });
			this.pi.appendEntry(CONTEMPLATOR_SUGGESTION, { version: 1, suggestion, delivered: true });
			this.markTipPersisted(ctx);
			return { messages: [{ role: "user", content: [{ type: "text", text: `Background contemplator suggestion (advisory):\n${suggestion}` }], timestamp: Date.now() }] as AgentMessage[] };
		}));
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

	private restore(ctx: MemoryUpdateCtx): void {
		const entries = ctx.sessionManager.getBranch() as Entry[];
		const tipId = entries.at(-1)?.id;
		if (tipId === this.restoredTipId) return;
		this.history = [];
		this.pendingSuggestion = undefined;
		for (const entry of entries) {
			if (entry.customType === CONTEMPLATOR_MESSAGE && entry.data && typeof entry.data === "object") {
				const message = (entry.data as { message?: unknown }).message;
				if (message && typeof message === "object") this.history.push(message as AgentMessage);
			}
			if (entry.customType === CONTEMPLATOR_SUGGESTION && entry.data && typeof entry.data === "object") {
				const data = entry.data as { suggestion?: unknown; delivered?: unknown };
				if (typeof data.suggestion === "string") this.pendingSuggestion = data.delivered === true ? undefined : data.suggestion;
			}
		}
		this.restoredTipId = tipId;
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
		const newObservations = observations.slice(this.lastObservationCount);
		const newReflections = reflections.slice(this.lastReflectionCount);
		this.lastObservationCount = observations.length;
		this.lastReflectionCount = reflections.length;
		debugLog("contemplator.update", {
			observationCount: observations.length,
			reflectionCount: reflections.length,
			newObservationCount: newObservations.length,
			newReflectionCount: newReflections.length,
			turnsSinceRun: this.turnsSinceRun,
			pending: this.pending !== undefined,
			running: this.running,
		});
		if (newObservations.length === 0 && newReflections.length === 0) return;
		this.pending = { observations: newObservations, reflections: newReflections };
		const enoughMemories = newObservations.length >= this.runtime.config.contemplatorMinNewObservations || newReflections.length >= this.runtime.config.contemplatorMinNewReflections;
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
			newObservationCount: newObservations.length,
			newReflectionCount: newReflections.length,
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
		this.running = true;
		this.turnsSinceRun = 0;
		const startedAt = Date.now();
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
				debugLog("contemplator.model_unavailable", { reason: resolved.reason });
				return;
			}
			const selectedModel = resolved.model as { provider?: unknown; id?: unknown; contextWindow?: unknown };
			debugLog("contemplator.model_resolved", {
				provider: selectedModel.provider,
				modelId: selectedModel.id,
				contextWindow: selectedModel.contextWindow,
			});
			const prompt: Message = { role: "user", content: [{ type: "text", text: `NEW MEMORY UPDATE\n\nOBSERVATIONS:\n${update.observations.join("\n") || "(none)"}\n\nREFLECTIONS:\n${update.reflections.join("\n") || "(none)"}\n\nReview this update in light of your prior context. Call send_steer only if you have one materially useful suggestion.` }], timestamp: Date.now() };
			this.history.push(prompt);
			this.pi.appendEntry(CONTEMPLATOR_MESSAGE, { version: 1, message: prompt });
			this.markTipPersisted(ctx);
			let steerSuggestion: string | undefined;
			const sendSteer: AgentTool<typeof SendSteerSchema> = {
				name: "send_steer",
				label: "Send steer",
				description: "Queue one concise, actionable advisory suggestion for the primary coding agent's next context.",
				parameters: SendSteerSchema,
				execute: async (_toolCallId, params: SendSteerArgs) => {
					const suggestion = params.suggestion.trim();
					steerSuggestion = suggestion;
					debugLog("contemplator.tool_call", {
						tool: "send_steer",
						suggestionLength: suggestion.length,
					});
					return {
						content: [{ type: "text", text: "Steer queued for the primary agent's next context." }],
						details: { queued: true },
					};
				},
			};
			const context: AgentContext = { systemPrompt: CONTEMPLATOR_SYSTEM, messages: this.history.slice(0, -1), tools: [sendSteer as AgentTool<any>] };
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
				suggestionQueued: steerSuggestion !== undefined,
			});
			if (assistant) {
				this.history.push(assistant);
				this.pi.appendEntry(CONTEMPLATOR_MESSAGE, { version: 1, message: assistant });
				this.markTipPersisted(ctx);
			}
			if (steerSuggestion) {
				this.pendingSuggestion = steerSuggestion;
				debugLog("contemplator.suggestion_queued", { suggestionLength: steerSuggestion.length });
				this.pi.appendEntry(CONTEMPLATOR_SUGGESTION, { version: 1, suggestion: steerSuggestion, delivered: false });
				this.markTipPersisted(ctx);
			}
			await this.compactHistory(resolved.model as Model<any>, resolved.apiKey, resolved.headers);
		} catch (error) {
			debugLog("contemplator.error", { errorMessage: error instanceof Error ? error.message : String(error) });
		} finally {
			this.running = false;
			debugLog("contemplator.complete", {
				durationMs: Date.now() - startedAt,
				historyMessageCount: this.history.length,
				pendingUpdate: this.pending !== undefined,
			});
			if (this.pending) void this.flush(ctx);
		}
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
		this.history = [{ role: "user", content: [{ type: "text", text: `Previous contemplator context summary:\n${summary}` }], timestamp: Date.now() }];
		this.pi.appendEntry(CONTEMPLATOR_MESSAGE, { version: 1, compacted: true, message: this.history[0] });
		debugLog("contemplator.compaction_complete", {
			previousMessageCount,
			newMessageCount: this.history.length,
			summaryLength: summary.length,
		});
	}
}

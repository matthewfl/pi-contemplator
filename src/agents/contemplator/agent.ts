import { agentLoop, type AgentContext, type AgentLoopConfig, type AgentMessage, type AgentTool } from "@earendil-works/pi-agent-core";
import { Type, type Message, type Model } from "@earendil-works/pi-ai";
import type { Static } from "typebox";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import { generateSummaryWithUsage } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { assistantOutputTokens, assistantToolCallCount, fullProjection, isReviewRequestEntry, isReviewResultEntry, OM_REVIEWER_MESSAGE, OM_REVIEWER_NOTICE, OM_REVIEWER_STATE, OM_REVIEW_REQUEST, OM_REVIEW_RESULT, type Entry, type ReviewResult, type StructuralReviewRequest } from "../../session-ledger/index.js";
import { hashId } from "../../ids.js";
import { createSearchMemoriesAgentTool } from "../../tools/search-memories.js";
import { createRecallAgentTool } from "../../tools/recall-observation.js";
import type { MemoryUpdateCtx, Runtime } from "../../runtime.js";
import { logAgentStreamError } from "../stream-errors.js";
import { debugLog, withDebugLogContext } from "../../debug-log.js";
import { boundedMaxTokens, AGENT_LOOP_MAX_TOKENS } from "../../model-budget.js";
import { buildContemplatorSystemPrompt } from "./prompts.js";
import { runStructuralReview } from "../reviewer/agent.js";

interface PendingUpdate {
	observations: string[];
	reflections: string[];
	reviews: string[];
	mainAgentOutputTokens: number;
	mainAgentToolCalls: number;
}

type Intervention =
	| { kind: "probe"; question: string }
	| { kind: "review"; request: Omit<StructuralReviewRequest, "createdAt" | "requestedBy"> };

type ReviewerSession = {
	scope: StructuralReviewRequest["scope"];
	history: AgentMessage[];
	/** Latest compact checkpoint; older transcript content stays in referenced append-only entries. */
	checkpointEntryId?: string;
	/** Reviewer message entries appended since checkpointEntryId. */
	messageEntryIds: string[];
};

type QueueStructuralReviewOptions = {
	ctx: MemoryUpdateCtx;
	requestArgs: Extract<Intervention, { kind: "review" }>["request"];
	branchEntries: Entry[];
	model: Model<any>;
	apiKey: string;
	headers: Record<string, string> | undefined;
	sessionGeneration: number;
};

type LaunchStructuralReviewOptions = {
	ctx: MemoryUpdateCtx;
	request: StructuralReviewRequest;
	model: Model<any>;
	apiKey: string;
	headers: Record<string, string> | undefined;
	sessionGeneration: number;
	key?: string;
	history?: AgentMessage[];
};

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

function reviewSummaryLine(review: ReviewResult): string {
	return review.outcome === "proposal"
		? `[${review.id}] ${review.scope} proposal: ${review.title} — ${review.summary}`
		: `[${review.id}] ${review.scope} review concluded with no proposal — ${review.reason}`;
}

function reviewRequestKey(request: RequestReviewArgs): string {
	return `${request.scope}:${hashId(`${request.evidence}\n${request.concern}`)}`;
}
const CONTEMPLATOR_MESSAGE = "om.contemplator.message";
const CONTEMPLATOR_STATE = "om.contemplator.state";
const CONTEMPLATOR_SUGGESTION = "om.contemplator.suggestion";
const SendProbeSchema = Type.Object({ question: Type.String({ minLength: 1, description: "One concise, memory-grounded probing question, optionally preceded by one short sentence of context. Cite relevant memory identifiers." }) });
const ReviewScopeSchema = Type.Union([Type.Literal("workflow"), Type.Literal("software")]);
export const RequestReviewSchema = Type.Object({
	scope: ReviewScopeSchema,
	evidence: Type.String({ minLength: 1, description: "Memory-grounded evidence for the suspected recurring pattern." }),
	concern: Type.String({ minLength: 1, description: "Suspected structural concern stated as a possibility." }),
	review_focus: Type.String({ minLength: 1, description: "What the reviewer should determine without prescribing a solution." }),
	constraints: Type.Optional(Type.String({ minLength: 1, description: "Relevant user requirements, boundaries, or uncertainties." })),
});
type SendProbeArgs = Static<typeof SendProbeSchema>;
export type RequestReviewArgs = Static<typeof RequestReviewSchema>;

export function createSendProbeTool(onProbe: (question: string) => boolean): AgentTool<typeof SendProbeSchema> {
	return {
		name: "send_probe",
		label: "Send probe",
		description: "Send one concise, high-level probing question to the primary agent asynchronously. The message must contain one focused question, optionally preceded by one short sentence of context, and cite relevant memory identifiers. Do not use it for routine reminders, status updates, generic advice, direct task management, or a structural design deserving review.",
		parameters: SendProbeSchema,
		execute: async (_toolCallId, params: SendProbeArgs) => {
			const question = params.question.trim();
			if (!onProbe(question)) {
				return { content: [{ type: "text", text: "No probe was queued because this update already has an intervention. Continue without calling another intervention tool." }], details: { queued: false } };
			}
			debugLog("contemplator.tool_call", { tool: "send_probe", suggestionLength: question.length });
			return { content: [{ type: "text", text: "Probe queued for the primary agent's next context." }], details: { queued: true } };
		},
	};
}

export function createRequestReviewTool(onReview: (request: RequestReviewArgs) => string | undefined): AgentTool<typeof RequestReviewSchema> {
	return {
		name: "request_review",
		label: "Request structural review",
		description: "Request a short-lived structural review grounded in cited memories. Use workflow for recurring problems in how work is performed and software for recurring problems in the product structure. Identify evidence, the suspected concern, review focus, and constraints without designing the solution.",
		parameters: RequestReviewSchema,
		execute: async (_toolCallId, params: RequestReviewArgs) => {
			const request = { ...params, evidence: params.evidence.trim(), concern: params.concern.trim(), review_focus: params.review_focus.trim(), constraints: params.constraints?.trim() || undefined };
			const reviewRequestId = onReview(request);
			if (!reviewRequestId) {
				return { content: [{ type: "text", text: "No review was queued because this update already has an intervention. Continue without calling another intervention tool." }], details: { queued: false, scope: request.scope } };
			}
			debugLog("contemplator.review_requested", { reviewRequestId, scope: request.scope, evidenceLength: request.evidence.length, concernLength: request.concern.length });
			return { content: [{ type: "text", text: `${request.scope === "workflow" ? "Workflow" : "Software"} review queued as [${reviewRequestId}].` }], details: { queued: true, scope: request.scope, reviewRequestId } };
		},
	};
}

export class Contemplator {
	private history: AgentMessage[] = [];
	private pending: PendingUpdate | undefined;
	private running = false;
	private seenObservationIds = new Set<string>();
	private seenReflectionIds = new Set<string>();
	private seenReviewIds = new Set<string>();
	private inFlightReviewKeys = new Set<string>();
	private inFlightReviewIds = new Set<string>();
	private resolvingReviewIds = new Set<string>();
	private resumedReviewIds = new Set<string>();
	private reviewerSessions = new Map<string, ReviewerSession>();
	private deliveredProbeIds = new Set<string>();
	private requeuedProbeIds = new Set<string>();
	private sessionGeneration = 0;
	private latestCtx: MemoryUpdateCtx | undefined;
	private turnsSinceRun = 0;
	private restoredTipId: string | undefined;

	constructor(private readonly pi: ExtensionAPI, private readonly runtime: Runtime) {}

	register(): void {
		this.runtime.setMemoryUpdateListener((ctx) => this.withDebugContext(ctx, () => this.observeTurn(ctx)));
		const restoreSessionBranch = (_event: any, ctx: ExtensionContext) => {
			this.sessionGeneration++;
			this.restore(ctx, true);
		};
		this.pi.on("session_start", restoreSessionBranch);
		this.pi.on("session_tree", restoreSessionBranch);
		this.pi.on("session_shutdown", () => {
			this.sessionGeneration++;
			this.history = [];
			this.pending = undefined;
			this.seenObservationIds.clear();
			this.seenReflectionIds.clear();
			this.seenReviewIds.clear();
			this.inFlightReviewKeys.clear();
			this.inFlightReviewIds.clear();
			this.resolvingReviewIds.clear();
			this.resumedReviewIds.clear();
			this.reviewerSessions.clear();
			this.deliveredProbeIds.clear();
			this.requeuedProbeIds.clear();
			this.latestCtx = undefined;
			this.turnsSinceRun = 0;
			this.restoredTipId = undefined;
		});
		this.pi.on("session_compact", (_event: any, ctx: ExtensionContext) => {
			// The in-flight prompt is persisted by flush after its agent loop. Do not
			// snapshot it here or compaction would make restore replay it twice.
			const history = this.running ? this.history.slice(0, -1) : this.history;
			if (history.length > 0) {
				this.pi.appendEntry(CONTEMPLATOR_STATE, { version: 1, history });
				this.markTipPersisted(ctx);
				debugLog("contemplator.state_persisted", { historyMessageCount: history.length, running: this.running });
			}
			this.persistReviewerStates(ctx);
		});
		this.pi.on("context", (event: any, ctx: ExtensionContext) => {
			const deliveredMessages = event.messages?.filter((message: any) => message?.role === "custom" && message.customType === CONTEMPLATOR_SUGGESTION && typeof message.details?.probeId === "string") ?? [];
			for (const delivered of deliveredMessages) {
				if (this.deliveredProbeIds.has(delivered.details.probeId)) continue;
				this.deliveredProbeIds.add(delivered.details.probeId);
				this.pi.appendEntry(CONTEMPLATOR_SUGGESTION, {
					version: 1,
					suggestion: typeof delivered.details.question === "string" ? delivered.details.question : String(delivered.content ?? ""),
					probeId: delivered.details.probeId,
					delivered: true,
				});
				this.markTipPersisted(ctx);
				debugLog("contemplator.suggestion_delivered", { probeId: delivered.details.probeId });
			}
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
		this.latestCtx = ctx;
		const entries = ctx.sessionManager.getBranch() as Entry[];
		const tipId = entries.at(-1)?.id;
		if (this.running && !resetTracking) return;
		if (tipId === this.restoredTipId && !resetTracking) return;
		this.history = [];
		if (resetTracking) {
			this.deliveredProbeIds.clear();
			this.requeuedProbeIds.clear();
			this.inFlightReviewIds.clear();
			this.resolvingReviewIds.clear();
			this.resumedReviewIds.clear();
			this.reviewerSessions.clear();
			const projection = fullProjection(entries);
			this.seenObservationIds = new Set(projection.observations.map((item) => item.id));
			this.seenReflectionIds = new Set(projection.reflections.map((item) => item.id));
			this.seenReviewIds = new Set((projection.reviews ?? []).map((item) => item.id));
			this.pending = undefined;
			this.turnsSinceRun = 0;
		}
		const undeliveredSuggestions = new Map<string, string>();
		const queuedProbeIds = new Set<string>();
		for (const entry of entries) {
			if (entry.customType === CONTEMPLATOR_SUGGESTION && entry.type === "custom_message") {
				const details = entry.details as { probeId?: unknown } | undefined;
				if (typeof details?.probeId === "string") queuedProbeIds.add(details.probeId);
			}
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
			if (entry.customType === OM_REVIEWER_STATE && entry.data && typeof entry.data === "object") {
				const state = entry.data as { version?: unknown; reviewRequestId?: unknown; scope?: unknown; history?: unknown; messageEntryIds?: unknown };
				if (typeof state.reviewRequestId === "string" && (state.scope === "workflow" || state.scope === "software")) {
					if (state.version === 1 && Array.isArray(state.history)) {
						// Backward compatibility for the old, expensive full-transcript snapshots.
						this.reviewerSessions.set(state.reviewRequestId, {
							scope: state.scope,
							history: state.history.filter((message): message is AgentMessage => !!message && typeof message === "object"),
							checkpointEntryId: entry.id,
							messageEntryIds: [],
						});
					} else if (state.version === 2 && Array.isArray(state.messageEntryIds) && state.messageEntryIds.every((id) => typeof id === "string")) {
						// V2 checkpoints contain references only. The referenced state/messages
						// have already been folded while walking this append-only branch.
						const session = this.reviewerSessions.get(state.reviewRequestId) ?? { scope: state.scope, history: [], messageEntryIds: [] };
						session.checkpointEntryId = entry.id;
						session.messageEntryIds = [];
						this.reviewerSessions.set(state.reviewRequestId, session);
					}
				}
			}
			if (entry.customType === OM_REVIEWER_MESSAGE && entry.data && typeof entry.data === "object") {
				const data = entry.data as { reviewRequestId?: unknown; scope?: unknown; message?: unknown };
				if (typeof data.reviewRequestId === "string" && (data.scope === "workflow" || data.scope === "software") && data.message && typeof data.message === "object") {
					const session = this.reviewerSessions.get(data.reviewRequestId) ?? { scope: data.scope, history: [], messageEntryIds: [] };
					session.history.push(data.message as AgentMessage);
					session.messageEntryIds.push(entry.id);
					this.reviewerSessions.set(data.reviewRequestId, session);
				}
			}
			if (entry.customType === CONTEMPLATOR_SUGGESTION && entry.data && typeof entry.data === "object") {
				const data = entry.data as { suggestion?: unknown; delivered?: unknown; probeId?: unknown };
				if (typeof data.probeId !== "string") continue;
				if (data.delivered === true) {
					this.deliveredProbeIds.add(data.probeId);
					undeliveredSuggestions.delete(data.probeId);
				} else if (typeof data.suggestion === "string") {
					undeliveredSuggestions.set(data.probeId, data.suggestion);
				}
			}
		}
		this.restoredTipId = tipId;
		for (const [probeId, question] of undeliveredSuggestions) {
			if (queuedProbeIds.has(probeId) || this.requeuedProbeIds.has(probeId)) continue;
			this.requeuedProbeIds.add(probeId);
			this.queueProbe(ctx, question, "restore", probeId);
		}
		if (resetTracking) void this.resumePendingReviews(ctx);
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
		const reviews = projection.reviews ?? [];
		const newObservationItems = projection.observations.filter((item) => !this.seenObservationIds.has(item.id));
		const newReflectionItems = projection.reflections.filter((item) => !this.seenReflectionIds.has(item.id));
		const newReviewItems = reviews.filter((item) => !this.seenReviewIds.has(item.id));
		const newObservations = newObservationItems.map((item) => `[${item.id}] ${item.content}`);
		const newReflections = newReflectionItems.map((item) => `[${item.id}] ${item.content}`);
		const newReviews = newReviewItems.map(reviewSummaryLine);
		for (const item of newObservationItems) this.seenObservationIds.add(item.id);
		for (const item of newReflectionItems) this.seenReflectionIds.add(item.id);
		for (const item of newReviewItems) this.seenReviewIds.add(item.id);
		debugLog("contemplator.update", {
			observationCount: observations.length,
			reflectionCount: reflections.length,
			newObservationCount: newObservations.length,
			newReflectionCount: newReflections.length,
			newReviewCount: newReviews.length,
			turnsSinceRun: this.turnsSinceRun,
			pending: this.pending !== undefined,
			running: this.running,
		});
		if (newObservations.length > 0 || newReflections.length > 0 || newReviews.length > 0) {
			this.pending = {
				observations: mergeMemoryLines(this.pending?.observations ?? [], newObservations),
				reflections: mergeMemoryLines(this.pending?.reflections ?? [], newReflections),
				reviews: mergeMemoryLines(this.pending?.reviews ?? [], newReviews),
				mainAgentOutputTokens: assistantOutputTokens(ctx.sessionManager.getBranch() as Entry[]),
				mainAgentToolCalls: assistantToolCallCount(ctx.sessionManager.getBranch() as Entry[]),
			};
		}
		if (!this.pending) return;
		const enoughMemories = this.pending.reviews.length > 0 || this.pending.observations.length >= this.runtime.config.contemplatorMinNewObservations || this.pending.reflections.length >= this.runtime.config.contemplatorMinNewReflections;
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
			pendingReviewCount: this.pending.reviews.length,
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
		let promptPersisted = false;
		let promptMessage: Message | undefined;
		debugLog("contemplator.start", {
			newObservationCount: update.observations.length,
			newReflectionCount: update.reflections.length,
			newReviewCount: update.reviews.length,
			historyMessageCount: this.history.length,
		});
		try {
			const resolved = await this.runtime.resolveModel({
				model: ctx.model,
				modelRegistry: ctx.modelRegistry,
				hasUI: ctx.hasUI,
				ui: ctx.ui,
				configuredModel: this.runtime.config.contemplatorModel ?? null,
			});
			if (!resolved.ok) {
				failed = true;
				debugLog("contemplator.model_unavailable", { reason: resolved.reason });
				if (sessionGeneration === this.sessionGeneration) {
					const pending = this.pending as PendingUpdate | undefined;
					this.pending = {
						observations: mergeMemoryLines(pending?.observations ?? [], update.observations),
						reflections: mergeMemoryLines(pending?.reflections ?? [], update.reflections),
						reviews: mergeMemoryLines(pending?.reviews ?? [], update.reviews),
						mainAgentOutputTokens: update.mainAgentOutputTokens,
						mainAgentToolCalls: update.mainAgentToolCalls,
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
			const reviewerEnabled = this.runtime.config.reviewerEnabled;
			const updateSections: string[] = [];
			if (update.observations.length > 0) updateSections.push(`OBSERVATIONS:\n${update.observations.join("\n")}`);
			if (update.reflections.length > 0) updateSections.push(`REFLECTIONS:\n${update.reflections.join("\n")}`);
			if (update.reviews.length > 0) updateSections.push(`REVIEWS:\n${update.reviews.join("\n")}`);
			const updateBody = updateSections.length > 0 ? updateSections.join("\n\n") : "(no new memories)";
			const interventionInstruction = reviewerEnabled
				? "Use send_probe for one focused question, or request_review only when a deeper workflow or software review is justified. Use no more than one intervention."
				: "Use send_probe only when one focused question is materially useful. Use no more than one intervention.";
			const prompt: Message = { role: "user", content: [{ type: "text", text: `NEW MEMORY UPDATE\n\n${updateBody}\n\nACTIVITY SIGNAL cumulative primary-agent generated tokens: ${update.mainAgentOutputTokens}; cumulative primary-agent tool calls: ${update.mainAgentToolCalls}\n\nConsider these updates in the context of the accumulated memories. Prioritize reasoning gaps, contradictions, user-intent alignment, relevant overlooked alternatives, well-supported loops, and recurring structural patterns. ${interventionInstruction}` }], timestamp: Date.now() };
			promptMessage = prompt;
			this.history.push(prompt);
			let intervention: Intervention | undefined;
			const branchEntries = ctx.sessionManager.getBranch() as Entry[];
			const getBranch = () => branchEntries;
			const searchMemoriesTool = createSearchMemoriesAgentTool(getBranch);
			const recallTool = createRecallAgentTool(getBranch);
			const sendProbe = createSendProbeTool((question) => {
				if (intervention) return false;
				intervention = { kind: "probe", question };
				return true;
			});
			const tools: AgentTool<any>[] = [searchMemoriesTool as AgentTool<any>, recallTool as AgentTool<any>, sendProbe as AgentTool<any>];
			if (reviewerEnabled) {
				const requestReview = createRequestReviewTool((request) => {
					if (intervention) return undefined;
					const id = `review-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`;
					intervention = { kind: "review", request: {
						id,
						scope: request.scope,
						evidence: request.evidence,
						concern: request.concern,
						reviewFocus: request.review_focus,
						constraints: request.constraints,
					} };
					return id;
				});
				tools.push(requestReview as AgentTool<any>);
			}
			const context: AgentContext = { systemPrompt: buildContemplatorSystemPrompt(reviewerEnabled), messages: this.history.slice(0, -1), tools };
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
			// The LLM call happened and was billed regardless of what we do next, so
			// record its usage even if the session generation changed mid-run.
			for (const message of result) {
				if (message.role === "assistant" && message.usage) {
					this.runtime.recordAgentUsage(message.usage);
				}
			}
			const assistant = [...result].reverse().find((message) => message.role === "assistant");
			debugLog("contemplator.result", {
				messageCount: result.length,
				assistantFound: assistant !== undefined,
				assistantStopReason: assistant && "stopReason" in assistant ? assistant.stopReason : undefined,
				intervention: intervention?.kind,
			});
			if (sessionGeneration === this.sessionGeneration) {
				this.pi.appendEntry(CONTEMPLATOR_MESSAGE, { version: 1, message: prompt });
				promptPersisted = true;
				this.markTipPersisted(ctx);
			}
			if (assistant && sessionGeneration === this.sessionGeneration) {
				this.history.push(assistant);
				this.pi.appendEntry(CONTEMPLATOR_MESSAGE, { version: 1, message: assistant });
				this.markTipPersisted(ctx);
			}
			if (intervention?.kind === "probe" && sessionGeneration === this.sessionGeneration) this.queueProbe(ctx, intervention.question, "send_probe");
			if (intervention?.kind === "review" && this.runtime.config.reviewerEnabled && sessionGeneration === this.sessionGeneration) {
				const reviewerModel = await this.runtime.resolveModel({
					model: ctx.model,
					modelRegistry: ctx.modelRegistry,
					hasUI: ctx.hasUI,
					ui: ctx.ui,
					configuredModel: this.runtime.config.reviewerModel ?? null,
				});
				if (!reviewerModel.ok) {
					debugLog("reviewer.model_unavailable", { reason: reviewerModel.reason });
				} else {
					this.queueStructuralReview({
						ctx,
						requestArgs: intervention.request,
						branchEntries,
						model: reviewerModel.model as Model<any>,
						apiKey: reviewerModel.apiKey,
						headers: reviewerModel.headers,
						sessionGeneration,
					});
				}
			}
			if (sessionGeneration === this.sessionGeneration) await this.compactHistory(resolved.model as Model<any>, resolved.apiKey, resolved.headers, sessionGeneration);
		} catch (error) {
			failed = true;
			debugLog("contemplator.error", { errorMessage: error instanceof Error ? error.message : String(error) });
			if (sessionGeneration === this.sessionGeneration && !promptPersisted) {
				if (promptMessage && this.history.at(-1) === promptMessage) this.history.pop();
				const pending = this.pending as PendingUpdate | undefined;
				this.pending = {
					observations: mergeMemoryLines(pending?.observations ?? [], update.observations),
					reflections: mergeMemoryLines(pending?.reflections ?? [], update.reflections),
					reviews: mergeMemoryLines(pending?.reviews ?? [], update.reviews),
					mainAgentOutputTokens: update.mainAgentOutputTokens,
					mainAgentToolCalls: update.mainAgentToolCalls,
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
			if (!failed && sessionGeneration === this.sessionGeneration && this.pending) this.observeTurn(ctx);
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

	private queueStructuralReview(options: QueueStructuralReviewOptions): void {
		const { ctx, requestArgs, branchEntries, model, apiKey, headers, sessionGeneration } = options;
		const requestForKey: RequestReviewArgs = { scope: requestArgs.scope, evidence: requestArgs.evidence, concern: requestArgs.concern, review_focus: requestArgs.reviewFocus, constraints: requestArgs.constraints };
		const key = reviewRequestKey(requestForKey);
		const duplicateRequest = branchEntries.some((entry) => isReviewRequestEntry(entry) && reviewRequestKey({ scope: entry.data.request.scope, evidence: entry.data.request.evidence, concern: entry.data.request.concern, review_focus: entry.data.request.reviewFocus, constraints: entry.data.request.constraints }) === key);
		if (this.inFlightReviewKeys.has(key) || duplicateRequest) {
			debugLog("contemplator.review_coalesced", { scope: requestArgs.scope, key });
			return;
		}
		const request: StructuralReviewRequest = { ...requestArgs, id: requestArgs.id, createdAt: Date.now(), requestedBy: "contemplator" };
		this.pi.appendEntry(OM_REVIEW_REQUEST, { version: 1, request });
		this.markTipPersisted(ctx);
		this.launchStructuralReview({ ctx, request, model, apiKey, headers, sessionGeneration, key });
	}

	private launchStructuralReview(options: LaunchStructuralReviewOptions): boolean {
		const { ctx, request, model, apiKey, headers, sessionGeneration, key } = options;
		if (this.runtime.reviewInFlight || this.inFlightReviewIds.has(request.id)) return false;
		// Do not spin a no-progress reviewer repeatedly in one live session. The
		// request stays pending and a later session/tree restoration resumes it.
		this.resumedReviewIds.add(request.id);
		this.inFlightReviewIds.add(request.id);
		if (key) this.inFlightReviewKeys.add(key);
		const session = this.reviewerSessions.get(request.id) ?? { scope: request.scope, history: options.history ?? [], messageEntryIds: [] };
		this.reviewerSessions.set(request.id, session);
		const task = this.runtime.launchReviewTask(ctx, async () => {
			try {
				debugLog("reviewer.started", { reviewRequestId: request.id, scope: request.scope, resumed: session.history.length > 0 });
				const result = await runStructuralReview({
					request, model, apiKey, headers,
					getBranch: () => ctx.sessionManager.getBranch() as Entry[],
					recordUsage: (usage) => this.runtime.recordAgentUsage(usage),
					history: session.history,
					onMessages: (messages) => {
						if (sessionGeneration !== this.sessionGeneration || !this.reviewIsPending(ctx, request.id)) return;
						for (const message of messages) {
							session.history.push(message);
							this.pi.appendEntry(OM_REVIEWER_MESSAGE, { version: 1, reviewRequestId: request.id, scope: request.scope, message });
							const entryId = this.markTipPersisted(ctx);
							if (entryId) session.messageEntryIds.push(entryId);
						}
					},
				});
				if (sessionGeneration !== this.sessionGeneration) {
					debugLog("reviewer.failed", { reviewRequestId: request.id, reason: "session_changed" });
					return;
				}
				if (!this.reviewIsPending(ctx, request.id)) {
					debugLog("reviewer.failed", { reviewRequestId: request.id, reason: "request_no_longer_pending" });
					return;
				}
				if (!result) {
					debugLog("reviewer.incomplete", { reviewRequestId: request.id, reason: "no_terminal_tool_call" });
					return;
				}
				this.pi.appendEntry(OM_REVIEW_RESULT, { result });
				this.reviewerSessions.delete(request.id);
				this.markTipPersisted(ctx);
				debugLog(result.outcome === "proposal" ? "reviewer.proposal_created" : "reviewer.no_proposal", { reviewRequestId: request.id, reviewMemoryId: result.id, scope: result.scope });
				if (result.outcome === "proposal") {
					const notice = `BACKGROUND ${result.scope.toUpperCase()} REVIEW PROPOSAL [${result.id}]\n\n${result.summary}\n\nRecall memory [${result.id}] to read the full conceptual proposal when it is relevant.\n\nThis is advisory. Evaluate it against the actual environment and current work.`;
					this.pi.sendMessage({ customType: "om.review.proposal", content: notice, display: false, details: { version: 1, reviewRequestId: request.id, reviewMemoryId: result.id, scope: result.scope } }, { deliverAs: "steer", triggerTurn: false });
					this.pi.appendEntry(OM_REVIEWER_NOTICE, { version: 1, reviewRequestId: request.id, reviewMemoryId: result.id, scope: result.scope, content: notice });
					this.markTipPersisted(ctx);
					debugLog("reviewer.primary_notice_queued", { reviewRequestId: request.id, reviewMemoryId: result.id });
				}
				this.runtime.notifyMemoryUpdate(ctx);
			} finally {
				this.inFlightReviewIds.delete(request.id);
				if (key) this.inFlightReviewKeys.delete(key);
			}
		});
		if (!task) {
			this.inFlightReviewIds.delete(request.id);
			this.resumedReviewIds.delete(request.id);
			if (key) this.inFlightReviewKeys.delete(key);
			return false;
		}
		// Runtime clears reviewInFlight in its own finally before this continuation,
		// so the next persisted pending request can start without overlap.
		void task.then(() => {
			const resumeCtx = this.latestCtx;
			if (resumeCtx) void this.resumePendingReviews(resumeCtx);
		});
		return true;
	}

	private reviewIsPending(ctx: MemoryUpdateCtx, reviewRequestId: string): boolean {
		const entries = ctx.sessionManager.getBranch() as Entry[];
		return entries.some((entry) => isReviewRequestEntry(entry) && entry.data.request.id === reviewRequestId)
			&& !entries.some((entry) => isReviewResultEntry(entry) && entry.data.result.reviewRequestId === reviewRequestId);
	}

	private persistReviewerStates(ctx: MemoryUpdateCtx): void {
		for (const [reviewRequestId, session] of this.reviewerSessions) {
			if (session.messageEntryIds.length === 0) continue;
			this.pi.appendEntry(OM_REVIEWER_STATE, {
				version: 2,
				reviewRequestId,
				scope: session.scope,
				previousStateEntryId: session.checkpointEntryId,
				messageEntryIds: session.messageEntryIds,
			});
			const checkpointEntryId = this.markTipPersisted(ctx);
			if (checkpointEntryId) session.checkpointEntryId = checkpointEntryId;
			session.messageEntryIds = [];
		}
	}

	private async resumePendingReviews(ctx: MemoryUpdateCtx): Promise<void> {
		if (!this.runtime.config.reviewerEnabled || this.runtime.config.passive || this.runtime.reviewInFlight) return;
		const entries = ctx.sessionManager.getBranch() as Entry[];
		const completed = new Set(entries.filter(isReviewResultEntry).map((entry) => entry.data.result.reviewRequestId));
		const request = entries.filter(isReviewRequestEntry).map((entry) => entry.data.request).find((item) => !completed.has(item.id) && !this.resumedReviewIds.has(item.id) && !this.inFlightReviewIds.has(item.id) && !this.resolvingReviewIds.has(item.id));
		if (!request) return;
		this.resolvingReviewIds.add(request.id);
		const generation = this.sessionGeneration;
		try {
			const resolved = await this.runtime.resolveModel({ model: ctx.model, modelRegistry: ctx.modelRegistry, hasUI: ctx.hasUI, ui: ctx.ui, configuredModel: this.runtime.config.reviewerModel ?? null });
			if (!resolved.ok || generation !== this.sessionGeneration) {
				debugLog("reviewer.resume_skipped", { reviewRequestId: request.id, reason: resolved.ok ? "session_changed" : resolved.reason });
				return;
			}
			this.launchStructuralReview({ ctx, request, model: resolved.model as Model<any>, apiKey: resolved.apiKey, headers: resolved.headers, sessionGeneration: generation, history: this.reviewerSessions.get(request.id)?.history ?? [] });
		} finally {
			this.resolvingReviewIds.delete(request.id);
		}
	}

	private markTipPersisted(ctx: MemoryUpdateCtx): string | undefined {
		this.restoredTipId = (ctx.sessionManager.getBranch() as Entry[]).at(-1)?.id;
		return this.restoredTipId;
	}

	private async compactHistory(model: Model<any>, apiKey: string, headers: Record<string, string> | undefined, sessionGeneration: number): Promise<void> {
		const serializedLength = this.history.reduce((total, message) => total + JSON.stringify(message).length, 0);
		if (this.history.length < 12 || serializedLength < 60_000) return;
		const previousMessageCount = this.history.length;
		debugLog("contemplator.compaction_start", {
			historyMessageCount: previousMessageCount,
			serializedLength,
		});
		const history = this.history.slice();
		const summaryWithUsage = await generateSummaryWithUsage(history as AgentMessage[], model, 4_000, apiKey, headers);
		this.runtime.recordAgentUsage(summaryWithUsage.usage);
		if (sessionGeneration !== this.sessionGeneration) {
			debugLog("contemplator.compaction_stale", { reason: "session_or_branch_changed" });
			return;
		}
		const summary = summaryWithUsage.text;
		const summaryModel = model as Model<any> & { api?: unknown; provider?: string; id?: string };
		const summaryUsage = summaryWithUsage.usage;
		this.history = [{
			role: "assistant",
			content: [{ type: "text", text: `Previous contemplator context summary:\n${summary}` }],
			api: summaryModel.api,
			provider: summaryModel.provider ?? "unknown",
			model: summaryModel.id ?? "contemplator",
			usage: {
				input: summaryUsage.input,
				output: summaryUsage.output,
				cacheRead: summaryUsage.cacheRead,
				cacheWrite: summaryUsage.cacheWrite,
				totalTokens: summaryUsage.input + summaryUsage.output + summaryUsage.cacheRead + summaryUsage.cacheWrite,
				cost: summaryUsage.cost,
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

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { newMemoryIdsSinceSummarizerCoverage, runSummarizer } from "../agents/summarizer/agent.js";
import { runObserver } from "../agents/observer/agent.js";
import { debugLog, withDebugLogContext } from "../debug-log.js";
import { resolveObserverChunkMaxTokens } from "../config.js";
import type { ResolveResult, Runtime } from "../runtime.js";
import { serializeSourceAddressedBranchEntries } from "../serialize.js";
import {
	OM_SUMMARIZER_COMMIT,
	OM_OBSERVATIONS_RECORDED,
	agentActiveTimeMs,
	buildObservationsRecordedData,
	foldLedger,
	fullProjection,
	isSourceEntry,
	latestCoverageIndex,
	observationToSummaryLine,
	rawTokensSinceObservationCoverage,
	summaryToSummaryLine,
	type Entry,
} from "../session-ledger/index.js";

type ResolvedModel = Extract<ResolveResult, { ok: true }>;

export type ConsolidationCtx = {
	cwd: string;
	hasUI: boolean;
	ui?: { notify: (message: string, type?: "warning" | "info" | "error") => void };
	model: unknown;
	modelRegistry: any;
	sessionManager: {
		getBranch: () => readonly unknown[];
		getSessionId?: () => string;
		getSessionFile?: () => string | undefined;
	};
};

type StageOutcome = "continue" | "abort";

function sourceEntriesAfter(entries: Entry[], index: number): Entry[] {
	return entries.slice(index + 1).filter(isSourceEntry);
}

function appendEntry(pi: ExtensionAPI, customType: string, data: unknown): void {
	pi.appendEntry(customType, data);
}

function anyStageDue(entries: Entry[], runtime: Runtime): boolean {
	return rawTokensSinceObservationCoverage(entries) >= runtime.config.observeAfterTokens;
}

function shouldNotifyWorker(runtime: Runtime, ctx: ConsolidationCtx): boolean {
	return runtime.config.showWorkerNotifications && ctx.hasUI;
}

function makeModelResolver(runtime: Runtime, ctx: ConsolidationCtx): (stage: "observer") => Promise<ResolvedModel | undefined> {
	let cached: ResolveResult | undefined;
	return async (stage) => {
		cached ??= await runtime.resolveModel({
			model: ctx.model,
			modelRegistry: ctx.modelRegistry,
			hasUI: ctx.hasUI,
			ui: ctx.ui,
		});
		if (cached.ok) {
			runtime.resolveFailureNotified = false;
			return cached;
		}
		debugLog(`${stage}.model_unavailable`, { reason: cached.reason });
		if (!runtime.resolveFailureNotified && ctx.hasUI && ctx.ui) {
			ctx.ui.notify(`Observational memory: ${stage} skipped — ${cached.reason}`, "warning");
			runtime.resolveFailureNotified = true;
		}
		return undefined;
	};
}

export function registerConsolidationTrigger(pi: ExtensionAPI, runtime: Runtime): void {
	const launch = (_event: unknown, ctx: ConsolidationCtx) => {
		maybeLaunchConsolidation(pi, runtime, ctx);
	};
	pi.on("agent_start", (event, ctx) => {
		launch(event, ctx);
		syncAndScheduleSummarizer(pi, runtime, ctx as ConsolidationCtx);
	});
	pi.on("turn_end", (event, ctx) => {
		launch(event, ctx);
		syncAndScheduleSummarizer(pi, runtime, ctx as ConsolidationCtx);
	});
	runtime.setAgentActivityListener((ctx) => {
		runtime.ensureConfig(ctx.cwd);
		// Contemplator calls this only after the elapsed interval is durable, avoiding
		// any dependence on ordering between Pi event handlers. Do not perform a full
		// new-memory scan at every checkpoint; observer completion marks dirty work.
		scheduleSummarizer(pi, runtime, ctx as ConsolidationCtx);
	});
}

function debugSessionMetadata(ctx: ConsolidationCtx): { sessionId?: string; sessionFile?: string } {
	try {
		return {
			sessionId: ctx.sessionManager.getSessionId?.(),
			sessionFile: ctx.sessionManager.getSessionFile?.(),
		};
	} catch {
		return {};
	}
}

function maybeLaunchConsolidation(pi: ExtensionAPI, runtime: Runtime, ctx: ConsolidationCtx): void {
	runtime.ensureConfig(ctx.cwd);
	if (runtime.config.passive === true) return;
	if (runtime.consolidationInFlight) return;

	const entries = ctx.sessionManager.getBranch() as Entry[];
	if (!anyStageDue(entries, runtime)) return;

	const runId = `consolidation-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`;
	const consolidationCtx: ConsolidationCtx = {
		cwd: ctx.cwd,
		hasUI: ctx.hasUI,
		ui: ctx.ui,
		model: ctx.model,
		modelRegistry: ctx.modelRegistry,
		sessionManager: ctx.sessionManager,
	};

	const sessionMetadata = debugSessionMetadata(ctx);
	void runtime.launchConsolidationTask(ctx, async () => withDebugLogContext({
		enabled: runtime.config.debugLog === true,
		cwd: ctx.cwd,
		...sessionMetadata,
		runId,
	}, async () => {
		await runConsolidationPipeline(pi, runtime, consolidationCtx);
	}));
}

export function launchCompactionObserver(
	pi: ExtensionAPI,
	runtime: Runtime,
	ctx: ConsolidationCtx,
	branchEntries: Entry[],
): void {
	runtime.ensureConfig(ctx.cwd);
	if (runtime.config.passive === true || runtime.consolidationInFlight) return;

	const lastCoverageIdx = latestCoverageIndex(branchEntries, OM_OBSERVATIONS_RECORDED);
	if (sourceEntriesAfter(branchEntries, lastCoverageIdx).length === 0) return;

	const runId = `compaction-observer-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`;
	const sessionMetadata = debugSessionMetadata(ctx);
	void runtime.launchConsolidationTask(ctx, async () => withDebugLogContext({
		enabled: runtime.config.debugLog === true,
		cwd: ctx.cwd,
		...sessionMetadata,
		runId,
	}, async () => {
		await runConsolidationPipeline(pi, runtime, ctx, {
			forceObserver: true,
			observerEntries: branchEntries,
			observerOnly: true,
		});
	}));
}

export type ConsolidationPipelineOptions = {
	forceObserver?: boolean;
	observerEntries?: Entry[];
	observerOnly?: boolean;
};

export async function runConsolidationPipeline(
	pi: ExtensionAPI,
	runtime: Runtime,
	ctx: ConsolidationCtx,
	options: ConsolidationPipelineOptions = {},
): Promise<void> {
	const resolveModel = makeModelResolver(runtime, ctx);
	const contextGeneration = runtime.getContextGeneration();

	const beforeFold = foldLedger(ctx.sessionManager.getBranch() as Entry[]);
	runtime.consolidationPhase = "observer";
	try {
		const observerOutcome = await runObserverStage(pi, runtime, ctx, resolveModel, {
			force: options.forceObserver === true,
			entries: options.observerEntries,
			contextGeneration,
		});
		if (observerOutcome === "abort") return;
	} catch (error) {
		debugLog("observer.error", { errorMessage: runtime.recordConsolidationStageError(ctx, "observer", error) });
		return;
	}
	const afterFold = foldLedger(ctx.sessionManager.getBranch() as Entry[]);
	const beforeIds = new Set(beforeFold.observations.map((item) => item.id));
	const added = afterFold.observations.filter((item) => !beforeIds.has(item.id));
	if (added.length > 0) {
		const entries = ctx.sessionManager.getBranch() as Entry[];
		runtime.markSummarizerDirty(added.length, added.reduce((sum, item) => sum + item.tokenCount, 0), agentActiveTimeMs(entries));
		scheduleSummarizer(pi, runtime, ctx);
	}
	if (contextGeneration === runtime.getContextGeneration()) runtime.notifyMemoryUpdate?.(ctx);
}

function activeMemoryTokens(entries: Entry[]): number {
	const folded = foldLedger(entries);
	return [...folded.activeObservations, ...folded.activeSummaries].reduce((sum, item) => sum + item.tokenCount, 0);
}

export function summarizerScheduleDelayMs(runtime: Runtime, activeTokens: number, agentTimeMs: number): number | undefined {
	if (!runtime.config.summarizerEnabled || runtime.summarizerDirtySince === undefined) return undefined;
	const minute = 60_000;
	if (runtime.summarizerPendingTokens >= runtime.config.summarizerMaxPendingMemoryTokens) return 0;
	const minimumAt = (runtime.summarizerLastStartedAt ?? Number.NEGATIVE_INFINITY) + runtime.config.summarizerMinIntervalMinutes * minute;
	const pressureThreshold = runtime.config.observationsPoolTargetTokens * runtime.config.summarizerPressureTriggerRatio;
	const thresholdReady = runtime.summarizerPendingTokens >= runtime.config.summarizerMinNewMemoryTokens || activeTokens >= pressureThreshold;
	const maximumAt = runtime.summarizerDirtySince + runtime.config.summarizerMaxDelayMinutes * minute;
	const desiredAt = thresholdReady ? agentTimeMs : maximumAt;
	return Math.max(0, Math.max(minimumAt, desiredAt) - agentTimeMs);
}

export function summarizerDirtySinceAgentTime(entries: Entry[], newIds: ReadonlySet<string>): number {
	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i];
		if (entry.type !== "custom" || entry.customType !== OM_OBSERVATIONS_RECORDED || !entry.data || typeof entry.data !== "object") continue;
		const observations = (entry.data as { observations?: Array<{ id?: unknown }> }).observations;
		if (observations?.some((observation) => typeof observation.id === "string" && newIds.has(observation.id))) {
			return agentActiveTimeMs(entries.slice(0, i + 1));
		}
	}
	return agentActiveTimeMs(entries);
}

function syncAndScheduleSummarizer(pi: ExtensionAPI, runtime: Runtime, ctx: ConsolidationCtx): void {
	runtime.ensureConfig(ctx.cwd);
	if (runtime.config.passive || !runtime.config.summarizerEnabled) return;
	if (runtime.summarizerDirtySince === undefined) {
		const entries = ctx.sessionManager.getBranch() as Entry[];
		const newIds = newMemoryIdsSinceSummarizerCoverage(entries);
		if (newIds.size > 0) {
			const folded = foldLedger(entries);
			let tokens = 0;
			for (const id of newIds) tokens += folded.observationsById.get(id)?.tokenCount ?? 0;
			runtime.markSummarizerDirty(newIds.size, tokens, summarizerDirtySinceAgentTime(entries, newIds));
		}
	}
	scheduleSummarizer(pi, runtime, ctx);
}

export function scheduleSummarizer(pi: ExtensionAPI, runtime: Runtime, ctx: ConsolidationCtx, agentTimeOverride?: number): void {
	if (runtime.config.passive || !runtime.config.summarizerEnabled || runtime.summarizerInFlight || runtime.summarizerDirtySince === undefined) return;
	const entries = ctx.sessionManager.getBranch() as Entry[];
	const agentTime = agentTimeOverride ?? agentActiveTimeMs(entries);
	const remainingActiveTime = summarizerScheduleDelayMs(runtime, activeMemoryTokens(entries), agentTime);
	if (remainingActiveTime === undefined || remainingActiveTime > 0) return;
	// No wall-clock timer: scheduling is revisited at main-agent activity
	// checkpoints, so idle time waiting for the user never ages this work.
	const generation = runtime.getContextGeneration();
	const capturedCount = runtime.summarizerPendingCount;
	const capturedTokens = runtime.summarizerPendingTokens;
	const capturedDirtySince = runtime.summarizerDirtySince;
	runtime.clearSummarizerDirty();
	const runId = `summarizer-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`;
	const sessionMetadata = debugSessionMetadata(ctx);
	void runtime.launchSummarizerTask(ctx, async () => withDebugLogContext({
		enabled: runtime.config.debugLog === true,
		cwd: ctx.cwd,
		...sessionMetadata,
		runId,
	}, async () => {
		let completed = false;
		const startedAt = Date.now();
		runtime.lastSummarizerRun = { startedAt, status: "running", messages: [] };
		try {
			const resolved = await runtime.resolveModel({ model: ctx.model, modelRegistry: ctx.modelRegistry, hasUI: ctx.hasUI, ui: ctx.ui });
			if (!resolved.ok) {
				debugLog("summarizer.model_unavailable", { reason: resolved.reason });
				runtime.lastSummarizerRun = { startedAt, status: "failed", messages: [], error: resolved.reason };
				return;
			}
			if (generation !== runtime.getContextGeneration()) return;
			if (shouldNotifyWorker(runtime, ctx)) ctx.ui?.notify("Observational memory: summarizer running", "info");
			const result = await runSummarizer({
				model: resolved.model as any,
				apiKey: resolved.apiKey,
				headers: resolved.headers,
				getBranch: () => ctx.sessionManager.getBranch() as Entry[],
				targetTokens: runtime.config.observationsPoolTargetTokens,
				samplingThresholdTokens: runtime.config.summarizerSamplingThresholdTokens,
				fairness: runtime.summarizerFairness,
				maxTurns: runtime.config.agentMaxTurns,
				thinkingLevel: runtime.config.model?.thinking ?? "low",
				recordUsage: (usage) => runtime.recordAgentUsage(usage),
				onMessages: (messages) => {
					if (generation === runtime.getContextGeneration()) runtime.lastSummarizerRun = { startedAt, status: "running", messages: messages.slice() };
				},
			});
			if (generation !== runtime.getContextGeneration()) return;
			if (!result.completed) {
				runtime.lastSummarizerRun = { ...runtime.lastSummarizerRun!, status: "incomplete" };
				return;
			}
			completed = true;
			if (result.commit) {
				pi.appendEntry(OM_SUMMARIZER_COMMIT, result.commit);
				const summary = `${result.commit.summaries.length} summaries consumed ${result.commit.metrics.consumedMemoryCount} memories, reducing visible memory by ~${result.commit.metrics.estimatedTokenReduction.toLocaleString()} tokens.`;
				runtime.lastSummarizerRun = { ...runtime.lastSummarizerRun!, status: "completed", summary };
				debugLog("summarizer.appended", { summaries: result.commit.summaries.length, consumed: result.commit.metrics.consumedMemoryCount, sampled: result.sample?.sampled ?? false });
				if (shouldNotifyWorker(runtime, ctx)) ctx.ui?.notify(`Observational memory: summarizer completed — ${summary}`, "info");
				runtime.notifyMemoryUpdate(ctx);
			} else {
				runtime.lastSummarizerRun = { ...runtime.lastSummarizerRun!, status: "completed", summary: "No safe summaries were created." };
				if (shouldNotifyWorker(runtime, ctx)) ctx.ui?.notify("Observational memory: summarizer completed — no safe summaries", "info");
			}
		} catch (error) {
			if (generation === runtime.getContextGeneration() && runtime.lastSummarizerRun) {
				runtime.lastSummarizerRun = { ...runtime.lastSummarizerRun, status: "failed", error: error instanceof Error ? error.message : String(error) };
			}
			throw error;
		} finally {
			if (!completed && generation === runtime.getContextGeneration()) runtime.markSummarizerDirty(capturedCount, capturedTokens, capturedDirtySince);
			if (completed) setTimeout(() => {
				if (generation === runtime.getContextGeneration()) scheduleSummarizer(pi, runtime, ctx);
			}, 0);
		}
	}), agentTime);
}

async function runObserverStage(
	pi: ExtensionAPI,
	runtime: Runtime,
	ctx: ConsolidationCtx,
	resolveModel: (stage: "observer") => Promise<ResolvedModel | undefined>,
	options: { force?: boolean; entries?: Entry[]; contextGeneration?: number } = {},
): Promise<StageOutcome> {
	const entries = options.entries ?? (ctx.sessionManager.getBranch() as Entry[]);
	const tokens = rawTokensSinceObservationCoverage(entries);
	if (!options.force && tokens < runtime.config.observeAfterTokens) return "continue";

	// Resolve the model before building the chunk: the default chunk cap
	// derives from the resolved model's context window.
	const resolved = await resolveModel("observer");
	if (!resolved) return "abort";
	if (options.contextGeneration !== undefined && options.contextGeneration !== runtime.getContextGeneration()) {
		debugLog("observer.stale", { reason: "session_or_branch_changed" });
		return "abort";
	}

	const lastCoverageIdx = latestCoverageIndex(entries, OM_OBSERVATIONS_RECORDED);
	const backlogEntries = sourceEntriesAfter(entries, lastCoverageIdx);

	// Budget the text that is actually sent to the observer, including source
	// labels and rendered message content. Complete entries are kept intact.
	// Only a first entry that cannot fit by itself is represented by a clearly
	// marked head/tail excerpt; the original ledger entry remains untouched.
	const contextWindow = (resolved.model as { contextWindow?: number }).contextWindow;
	const maxChunkTokens = resolveObserverChunkMaxTokens(runtime.config, contextWindow);
	const {
		text: chunk,
		sourceEntryIds,
		estimatedTokens: chunkTokens,
		truncatedSourceEntryIds,
	} = serializeSourceAddressedBranchEntries(backlogEntries, { maxTokens: maxChunkTokens });
	if (!chunk.trim() || sourceEntryIds.length === 0) return "continue";
	const coversUpToId = sourceEntryIds.at(-1);
	if (!coversUpToId) return "continue";

	if (sourceEntryIds.length < backlogEntries.length || truncatedSourceEntryIds.length > 0) {
		debugLog("observer.chunk_capped", {
			maxChunkTokens,
			backlogEntries: backlogEntries.length,
			backlogTokens: tokens,
			chunkEntries: sourceEntryIds.length,
			chunkTokens,
			truncatedSourceEntryIds,
		});
	}

	const memory = fullProjection(entries);
	const priorSummaries = memory.summaries.map(summaryToSummaryLine);
	const priorObservations = memory.observations.map(observationToSummaryLine);

	if (shouldNotifyWorker(runtime, ctx)) ctx.ui?.notify(
		`Observational memory: observer running on ~${chunkTokens.toLocaleString()}-token chunk`,
		"info",
	);
	debugLog("observer.start", {
		tokens,
		chunkTokens,
		coversUpToId,
		sourceEntryIds,
		sourceEntryCount: sourceEntryIds.length,
		priorSummaries: priorSummaries.length,
		priorObservations: priorObservations.length,
	});

	const observations = await runObserver({
		model: resolved.model as any,
		apiKey: resolved.apiKey,
		headers: resolved.headers,
		priorSummaries,
		priorObservations,
		chunk,
		allowedSourceEntryIds: sourceEntryIds,
		maxTurns: runtime.config.agentMaxTurns,
		thinkingLevel: runtime.config.model?.thinking ?? "low",
		recordUsage: (usage) => runtime.recordAgentUsage(usage),
	});
	if (options.contextGeneration !== undefined && options.contextGeneration !== runtime.getContextGeneration()) {
		debugLog("observer.stale", { reason: "session_or_branch_changed" });
		return "abort";
	}
	if (!observations || observations.length === 0) {
		debugLog("observer.empty", { coversUpToId });
		if (ctx.hasUI) ctx.ui?.notify(
			"Observational memory: observer returned no observations",
			"warning",
		);
		return "continue";
	}

	const currentEntries = ctx.sessionManager.getBranch() as Entry[];
	let effectiveCoversUpToId = coversUpToId;
	if (!currentEntries.some((entry) => entry.id === coversUpToId)) {
		// A fire-and-forget compaction observer may finish after compaction has
		// folded its source target away. Never append an unresolvable marker: it
		// would make these observations invisible to projection and recall.
		const compaction = [...currentEntries].reverse().find((entry) => entry.type === "compaction");
		effectiveCoversUpToId = compaction?.id ?? currentEntries.at(-1)?.id ?? coversUpToId;
		debugLog("observer.coverage_target_folded", {
			requestedCoversUpToId: coversUpToId,
			effectiveCoversUpToId,
			compactionId: compaction?.id,
		});
	}
	const data = buildObservationsRecordedData(observations, effectiveCoversUpToId);
	if (!data) return "continue";
	debugLog("observer.records", {
		count: observations.length,
		observationTokens: observations.reduce((sum, observation) => sum + observation.tokenCount, 0),
		coversUpToId: effectiveCoversUpToId,
	});
	appendEntry(pi, OM_OBSERVATIONS_RECORDED, data);
	debugLog("observer.appended", { count: observations.length, coversUpToId: effectiveCoversUpToId });
	if (shouldNotifyWorker(runtime, ctx)) ctx.ui?.notify(
		`Observational memory: ${observations.length} observation${observations.length === 1 ? "" : "s"} recorded`,
		"info",
	);
	return "continue";
}

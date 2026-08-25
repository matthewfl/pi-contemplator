import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { runSummarizer } from "../agents/summarizer/agent.js";
import { runObserver } from "../agents/observer/agent.js";
import { debugLog, withDebugLogContext } from "../debug-log.js";
import { resolveObserverChunkMaxTokens } from "../config.js";
import type { ResolveResult, Runtime } from "../runtime.js";
import { serializeSourceAddressedBranchEntries } from "../serialize.js";
import {
	OM_SUMMARIZER_COMMIT,
	OM_OBSERVATIONS_RECORDED,
	buildObservationsRecordedData,
	foldLedger,
	fullProjection,
	isSourceEntry,
	latestCoverageIndex,
	observationToSummaryLine,
	partitionMemoryPools,
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

/** Abort only when a summarizer produces no stream/message progress for this long. */
export const SUMMARIZER_STALL_TIMEOUT_MS = 15 * 60_000;

export function createSummarizerStallWatchdog(
	timeoutMs: number,
	onStall: (signal: AbortSignal) => void,
): { signal: AbortSignal; progress: () => void; dispose: () => void } {
	const controller = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const progress = () => {
		if (controller.signal.aborted) return;
		if (timer !== undefined) clearTimeout(timer);
		timer = setTimeout(() => {
			timer = undefined;
			controller.abort(new Error(`summarizer produced no progress for ${Math.round(timeoutMs / 60_000)} minutes`));
			onStall(controller.signal);
		}, timeoutMs);
		(timer as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.();
	};
	progress();
	return {
		signal: controller.signal,
		progress,
		dispose: () => {
			if (timer !== undefined) clearTimeout(timer);
			timer = undefined;
		},
	};
}

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
			ctx.ui.notify(`pi-contemplator: ${stage} skipped — ${cached.reason}`, "warning");
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
		// Token pools are re-evaluated at every primary-agent progress checkpoint;
		// idle wall-clock time has no scheduling meaning.
		scheduleSummarizer(pi, runtime, ctx as ConsolidationCtx);
	});
	runtime.setSettingsUpdateListener((ctx, settings) => {
		const affectsScheduling = settings.summarizerEnabled !== undefined ||
			settings.newMemoryPoolMaxTokens !== undefined ||
			settings.oldMemoryPoolTargetTokens !== undefined ||
			settings.summarizerRetriggerTokens !== undefined;
		if (!affectsScheduling) return;
		runtime.ensureConfig(ctx.cwd);
		// A changed pool boundary starts a fresh threshold cycle.
		runtime.summarizerNextTriggerTokens = undefined;
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

export function shouldScheduleSummarizerFromObserver(options: ConsolidationPipelineOptions): boolean {
	return options.observerOnly !== true;
}

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
	runtime.lastObserverStartedAt = Date.now();
	try {
		// A large backlog is drained in bounded, oldest-first chunks. The normal
		// trigger threshold controls when the batch stops; a static compaction
		// snapshot is intentionally processed only once. Coverage must advance on
		// every iteration, otherwise stop rather than spin on a failed chunk.
		while (true) {
			const beforeEntries = ctx.sessionManager.getBranch() as Entry[];
			const beforeCoverage = latestCoverageIndex(beforeEntries, OM_OBSERVATIONS_RECORDED);
			const observerOutcome = await runObserverStage(pi, runtime, ctx, resolveModel, {
				force: options.forceObserver === true,
				entries: options.observerEntries,
				contextGeneration,
			});
			if (observerOutcome === "abort") return;
			if (options.observerEntries) break;

			const afterEntries = ctx.sessionManager.getBranch() as Entry[];
			const afterCoverage = latestCoverageIndex(afterEntries, OM_OBSERVATIONS_RECORDED);
			const remainingTokens = rawTokensSinceObservationCoverage(afterEntries);
			if (afterCoverage <= beforeCoverage || remainingTokens < runtime.config.observeAfterTokens) break;
			debugLog("observer.backlog_continue", { remainingTokens, afterCoverage });
		}
	} catch (error) {
		debugLog("observer.error", { errorMessage: runtime.recordConsolidationStageError(ctx, "observer", error) });
		return;
	} finally {
		runtime.lastObserverCompletedAt = Date.now();
	}
	const afterFold = foldLedger(ctx.sessionManager.getBranch() as Entry[]);
	const beforeIds = new Set(beforeFold.observations.map((item) => item.id));
	const added = afterFold.observations.filter((item) => !beforeIds.has(item.id));
	if (added.length > 0 && shouldScheduleSummarizerFromObserver(options)) scheduleSummarizer(pi, runtime, ctx);
	if (contextGeneration === runtime.getContextGeneration()) runtime.notifyMemoryUpdate?.(ctx);
}

export function currentMemoryPools(runtime: Runtime, entries: Entry[]) {
	const folded = foldLedger(entries);
	return partitionMemoryPools(
		folded.activeObservations,
		folded.activeSummaries,
		runtime.config.newMemoryPoolMaxTokens,
	);
}

export function summarizerTriggerTokens(runtime: Runtime): number {
	return runtime.summarizerNextTriggerTokens ?? runtime.config.oldMemoryPoolTargetTokens;
}

export function nextSummarizerTriggerTokens(targetTokens: number, postRunOldTokens: number, retriggerTokens: number): number {
	return postRunOldTokens <= targetTokens
		? targetTokens
		: Math.max(targetTokens, postRunOldTokens + retriggerTokens);
}

/** Failed/incomplete launches must remain eligible at the prior threshold. */
export function summarizerTriggerAfterRun(
	successfullyCompleted: boolean,
	currentTriggerTokens: number | undefined,
	targetTokens: number,
	postRunOldTokens: number,
	retriggerTokens: number,
): number | undefined {
	return successfullyCompleted
		? nextSummarizerTriggerTokens(targetTokens, postRunOldTokens, retriggerTokens)
		: currentTriggerTokens;
}

function syncAndScheduleSummarizer(pi: ExtensionAPI, runtime: Runtime, ctx: ConsolidationCtx): void {
	runtime.ensureConfig(ctx.cwd);
	scheduleSummarizer(pi, runtime, ctx);
}

export function scheduleSummarizer(pi: ExtensionAPI, runtime: Runtime, ctx: ConsolidationCtx): void {
	if (runtime.config.passive || !runtime.config.summarizerEnabled || runtime.summarizerInFlight) return;
	const entries = ctx.sessionManager.getBranch() as Entry[];
	const pools = currentMemoryPools(runtime, entries);
	if (pools.oldTokens <= summarizerTriggerTokens(runtime)) return;
	const generation = runtime.getContextGeneration();
	const runId = `summarizer-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`;
	const sessionMetadata = debugSessionMetadata(ctx);
	void runtime.launchSummarizerTask(ctx, async () => withDebugLogContext({
		enabled: runtime.config.debugLog === true,
		cwd: ctx.cwd,
		...sessionMetadata,
		runId,
	}, async () => {
		let stalled = false;
		let successfullyCompleted = false;
		let disposeStallWatchdog = () => {};
		const startedAt = Date.now();
		runtime.lastSummarizerStartedAt = startedAt;
		runtime.lastSummarizerRun = { startedAt, status: "running", messages: [] };
		try {
			const resolved = await runtime.resolveModel({ model: ctx.model, modelRegistry: ctx.modelRegistry, hasUI: ctx.hasUI, ui: ctx.ui });
			if (!resolved.ok) {
				debugLog("summarizer.model_unavailable", { reason: resolved.reason });
				runtime.lastSummarizerRun = { startedAt, status: "failed", messages: [], error: resolved.reason };
				return;
			}
			if (generation !== runtime.getContextGeneration()) return;
			if (shouldNotifyWorker(runtime, ctx)) ctx.ui?.notify("pi-contemplator: summarizer running", "info");
			const watchdog = createSummarizerStallWatchdog(SUMMARIZER_STALL_TIMEOUT_MS, (signal) => {
				stalled = true;
				const reason = signal.reason instanceof Error ? signal.reason.message : "summarizer stalled";
				debugLog("summarizer.stalled", { reason });
				if (shouldNotifyWorker(runtime, ctx)) ctx.ui?.notify(`pi-contemplator: ${reason}; cancelling and leaving the backlog eligible for retry`, "warning");
			});
			disposeStallWatchdog = watchdog.dispose;
			const result = await runSummarizer({
				signal: watchdog.signal,
				model: resolved.model as any,
				apiKey: resolved.apiKey,
				headers: resolved.headers,
				getBranch: () => ctx.sessionManager.getBranch() as Entry[],
				targetTokens: runtime.config.oldMemoryPoolTargetTokens,
				newPoolMaxTokens: runtime.config.newMemoryPoolMaxTokens,
				samplingThresholdTokens: runtime.config.summarizerSamplingThresholdTokens,
				maxTurns: runtime.config.agentMaxTurns,
				thinkingLevel: runtime.config.model?.thinking ?? "minimal",
				recordUsage: (usage) => runtime.recordAgentUsage(usage),
				onMessages: (messages) => {
					watchdog.progress();
					if (generation === runtime.getContextGeneration()) runtime.lastSummarizerRun = { startedAt, status: "running", messages: messages.slice() };
				},
			});
			if (generation !== runtime.getContextGeneration()) return;
			if (!result.completed) {
				runtime.lastSummarizerRun = stalled
					? { ...runtime.lastSummarizerRun!, status: "failed", error: "Summarizer stalled and was cancelled; memory remains eligible for retry." }
					: { ...runtime.lastSummarizerRun!, status: "incomplete" };
				return;
			}
			if (result.commit) {
				pi.appendEntry(OM_SUMMARIZER_COMMIT, result.commit);
				successfullyCompleted = true;
				const summary = `${result.commit.summaries.length} summaries consumed ${result.commit.metrics.consumedMemoryCount} memories, reducing visible memory by ~${result.commit.metrics.estimatedTokenReduction.toLocaleString()} tokens.`;
				runtime.lastSummarizerRun = { ...runtime.lastSummarizerRun!, status: "completed", summary };
				debugLog("summarizer.appended", { summaries: result.commit.summaries.length, consumed: result.commit.metrics.consumedMemoryCount, sampled: result.sample?.sampled ?? false });
				if (shouldNotifyWorker(runtime, ctx)) ctx.ui?.notify(`pi-contemplator: summarizer completed — ${summary}`, "info");
				runtime.notifyMemoryUpdate(ctx);
			} else {
				successfullyCompleted = true;
				runtime.lastSummarizerRun = { ...runtime.lastSummarizerRun!, status: "completed", summary: "No safe summaries were created." };
				if (shouldNotifyWorker(runtime, ctx)) ctx.ui?.notify("pi-contemplator: summarizer completed — no safe summaries", "info");
			}
		} catch (error) {
			if (generation === runtime.getContextGeneration() && runtime.lastSummarizerRun) {
				runtime.lastSummarizerRun = { ...runtime.lastSummarizerRun, status: "failed", error: error instanceof Error ? error.message : String(error) };
			}
			throw error;
		} finally {
			disposeStallWatchdog();
			if (generation === runtime.getContextGeneration()) {
				const completedAt = Date.now();
				runtime.lastSummarizerCompletedAt = completedAt;
				if (runtime.lastSummarizerRun) runtime.lastSummarizerRun = { ...runtime.lastSummarizerRun, completedAt };
				const postRunPools = currentMemoryPools(runtime, ctx.sessionManager.getBranch() as Entry[]);
				const target = runtime.config.oldMemoryPoolTargetTokens;
				runtime.summarizerNextTriggerTokens = summarizerTriggerAfterRun(
					successfullyCompleted,
					runtime.summarizerNextTriggerTokens,
					target,
					postRunPools.oldTokens,
					runtime.config.summarizerRetriggerTokens,
				);
			}
		}
	}));
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
		`pi-contemplator: observer running on ~${chunkTokens.toLocaleString()}-token chunk`,
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
	const accepted = observations ?? [];
	const data = buildObservationsRecordedData(accepted, effectiveCoversUpToId);
	if (!data) return "continue";
	debugLog(accepted.length > 0 ? "observer.records" : "observer.coverage_only", {
		count: accepted.length,
		observationTokens: accepted.reduce((sum, observation) => sum + observation.tokenCount, 0),
		coversUpToId: effectiveCoversUpToId,
	});
	// A clean zero-observation verdict is still successful coverage. Persist an
	// empty batch so the next bounded pass starts after this chunk instead of
	// retrying the same low-information source forever. Failures throw above and
	// therefore never reach this coverage commit.
	appendEntry(pi, OM_OBSERVATIONS_RECORDED, data);
	debugLog("observer.appended", { count: accepted.length, coversUpToId: effectiveCoversUpToId });
	if (shouldNotifyWorker(runtime, ctx)) ctx.ui?.notify(
		accepted.length > 0
			? `pi-contemplator: ${accepted.length} observation${accepted.length === 1 ? "" : "s"} recorded`
			: "pi-contemplator: observer found no new information; processed chunk marked covered",
		"info",
	);
	return "continue";
}

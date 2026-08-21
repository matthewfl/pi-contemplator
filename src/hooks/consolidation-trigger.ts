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
		// Contemplator calls this only after the elapsed interval is durable, avoiding
		// any dependence on ordering between Pi event handlers. Do not perform a full
		// new-memory scan at every checkpoint; observer completion marks dirty work.
		scheduleSummarizer(pi, runtime, ctx as ConsolidationCtx);
	});
	runtime.setSettingsUpdateListener((ctx, settings) => {
		const affectsScheduling = settings.summarizerEnabled !== undefined ||
			settings.observationsPoolTargetTokens !== undefined ||
			settings.summarizerMinIntervalMinutes !== undefined ||
			settings.summarizerMaxDelayMinutes !== undefined ||
			settings.summarizerMinNewMemoryTokens !== undefined ||
			settings.summarizerMaxPendingMemoryTokens !== undefined ||
			settings.summarizerPressureTriggerRatio !== undefined;
		if (!affectsScheduling) return;
		runtime.ensureConfig(ctx.cwd);
		if (runtime.config.passive || !runtime.config.summarizerEnabled) return;
		const entries = ctx.sessionManager.getBranch() as Entry[];
		const folded = foldLedger(entries);
		const active = [...folded.activeObservations, ...folded.activeSummaries];
		const activeTokens = active.reduce((sum, memory) => sum + memory.tokenCount, 0);
		const pressureThreshold = runtime.config.observationsPoolTargetTokens * runtime.config.summarizerPressureTriggerRatio;
		if (activeTokens >= pressureThreshold) {
			runtime.requestSummarizerMaintenance(active.length, activeTokens, agentActiveTimeMs(entries));
		} else if (!runtime.summarizerInFlight) {
			reconcileSummarizerDirty(runtime, entries);
		}
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
		const observerOutcome = await runObserverStage(pi, runtime, ctx, resolveModel, {
			force: options.forceObserver === true,
			entries: options.observerEntries,
			contextGeneration,
		});
		if (observerOutcome === "abort") return;
	} catch (error) {
		debugLog("observer.error", { errorMessage: runtime.recordConsolidationStageError(ctx, "observer", error) });
		return;
	} finally {
		runtime.lastObserverCompletedAt = Date.now();
	}
	const afterFold = foldLedger(ctx.sessionManager.getBranch() as Entry[]);
	const beforeIds = new Set(beforeFold.observations.map((item) => item.id));
	const added = afterFold.observations.filter((item) => !beforeIds.has(item.id));
	if (added.length > 0) {
		const entries = ctx.sessionManager.getBranch() as Entry[];
		runtime.markSummarizerDirty(added.length, added.reduce((sum, item) => sum + item.tokenCount, 0), agentActiveTimeMs(entries));
		// A compaction observer is a capture sidecar. Preserve its new work as
		// dirty, but never start a summarizer from inside compaction. The next
		// normal activity/session checkpoint will reconcile and schedule it.
		if (shouldScheduleSummarizerFromObserver(options)) scheduleSummarizer(pi, runtime, ctx);
	}
	if (contextGeneration === runtime.getContextGeneration()) runtime.notifyMemoryUpdate?.(ctx);
}

function latestObservationBatchId(entries: Entry[]): string | undefined {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry.type === "custom" && entry.customType === OM_OBSERVATIONS_RECORDED) return entry.id;
	}
	return undefined;
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

export function reconcileSummarizerDirty(runtime: Runtime, entries: Entry[]): Set<string> {
	const newIds = newMemoryIdsSinceSummarizerCoverage(entries);
	const maintenanceRequested = runtime.summarizerMaintenanceRequested;
	const priorDirtySince = runtime.summarizerDirtySince;
	// The ledger coverage marker is authoritative. Replace counters rather than
	// adding to them so observations captured during an in-flight run cannot be
	// double-counted or retain the completed run's older dirty timestamp.
	runtime.clearSummarizerDirty();
	if (newIds.size > 0 || maintenanceRequested) {
		const folded = foldLedger(entries);
		let newTokens = 0;
		for (const id of newIds) newTokens += folded.observationsById.get(id)?.tokenCount ?? 0;
		const active = [...folded.activeObservations, ...folded.activeSummaries];
		const activeTokens = maintenanceRequested ? active.reduce((sum, memory) => sum + memory.tokenCount, 0) : 0;
		const dirtySince = maintenanceRequested && priorDirtySince !== undefined
			? priorDirtySince
			: newIds.size > 0
				? summarizerDirtySinceAgentTime(entries, newIds)
				: agentActiveTimeMs(entries);
		if (maintenanceRequested) {
			runtime.requestSummarizerMaintenance(
				Math.max(newIds.size, active.length),
				Math.max(newTokens, activeTokens),
				dirtySince,
			);
		} else {
			runtime.markSummarizerDirty(newIds.size, newTokens, dirtySince);
		}
	}
	return newIds;
}

function syncAndScheduleSummarizer(pi: ExtensionAPI, runtime: Runtime, ctx: ConsolidationCtx): void {
	runtime.ensureConfig(ctx.cwd);
	if (runtime.config.passive || !runtime.config.summarizerEnabled) return;
	// Do not replace the incremental mid-flight backlog while a snapshot is
	// being processed. The worker reconciles exactly against its coverage when
	// it exits, whether it succeeds or fails.
	if (!runtime.summarizerInFlight) reconcileSummarizerDirty(runtime, ctx.sessionManager.getBranch() as Entry[]);
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
		let coverageAdvanced = false;
		let reviewedUpToId: string | undefined;
		let stalled = false;
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
				targetTokens: runtime.config.observationsPoolTargetTokens,
				samplingThresholdTokens: runtime.config.summarizerSamplingThresholdTokens,
				fairness: runtime.summarizerFairness,
				maxTurns: runtime.config.agentMaxTurns,
				thinkingLevel: runtime.config.model?.thinking ?? "minimal",
				recordUsage: (usage) => runtime.recordAgentUsage(usage),
				onMessages: (messages) => {
					watchdog.progress();
					if (generation === runtime.getContextGeneration()) runtime.lastSummarizerRun = { startedAt, status: "running", messages: messages.slice() };
				},
			});
			if (generation !== runtime.getContextGeneration()) return;
			reviewedUpToId = result.reviewedUpToId;
			if (!result.completed) {
				runtime.lastSummarizerRun = stalled
					? { ...runtime.lastSummarizerRun!, status: "failed", error: "Summarizer stalled and was cancelled; memory remains eligible for retry." }
					: { ...runtime.lastSummarizerRun!, status: "incomplete" };
				return;
			}
			completed = true;
			if (result.commit) {
				pi.appendEntry(OM_SUMMARIZER_COMMIT, result.commit);
				coverageAdvanced = true;
				const summary = `${result.commit.summaries.length} summaries consumed ${result.commit.metrics.consumedMemoryCount} memories, reducing visible memory by ~${result.commit.metrics.estimatedTokenReduction.toLocaleString()} tokens.`;
				runtime.lastSummarizerRun = { ...runtime.lastSummarizerRun!, status: "completed", summary };
				debugLog("summarizer.appended", { summaries: result.commit.summaries.length, consumed: result.commit.metrics.consumedMemoryCount, sampled: result.sample?.sampled ?? false });
				if (shouldNotifyWorker(runtime, ctx)) ctx.ui?.notify(`pi-contemplator: summarizer completed — ${summary}`, "info");
				runtime.notifyMemoryUpdate(ctx);
			} else {
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
				// A completed pass has honored an explicit target/settings request. A
				// failed or stalled pass leaves it set so normal checkpoints can retry.
				if (completed) runtime.summarizerMaintenanceRequested = false;
				reconcileSummarizerDirty(runtime, ctx.sessionManager.getBranch() as Entry[]);
				// A durable commit advances coverage. A successful no-op normally waits
				// for later activity, but if observations arrived after its immutable
				// snapshot, immediately give the enlarged set another opportunity.
				const newerObservationsArrived = reviewedUpToId !== undefined && latestObservationBatchId(ctx.sessionManager.getBranch() as Entry[]) !== reviewedUpToId;
				if (completed && (coverageAdvanced || newerObservationsArrived)) setTimeout(() => {
					if (generation === runtime.getContextGeneration()) syncAndScheduleSummarizer(pi, runtime, ctx);
				}, 0);
			}
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
	if (!observations || observations.length === 0) {
		debugLog("observer.empty", { coversUpToId });
		if (ctx.hasUI) ctx.ui?.notify(
			"pi-contemplator: observer returned no observations",
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
		`pi-contemplator: ${observations.length} observation${observations.length === 1 ? "" : "s"} recorded`,
		"info",
	);
	return "continue";
}

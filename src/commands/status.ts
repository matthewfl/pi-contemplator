import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolveCompactAfterTokens } from "../config.js";
import type { Runtime } from "../runtime.js";
import {
	agentActiveTimeMs,
	diffProjection,
	foldLedger,
	fullProjection,
	rawTokensSinceLastCompaction,
	rawTokensSinceObservationCoverage,
	visibleProjection,
	type Entry,
} from "../session-ledger/index.js";

const CONTEMPLATOR_SUGGESTION = "om.contemplator.suggestion";
const REVIEWER_NOTICE = "om.reviewer.notice";

function pct(current: number, total: number): number {
	return total > 0 ? Math.round((current / total) * 100) : 0;
}

function formatTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
	return String(n);
}

function formatDuration(durationMs: number): string {
	const totalSeconds = Math.floor(durationMs / 1_000);
	const hours = Math.floor(totalSeconds / 3_600);
	const minutes = Math.floor((totalSeconds % 3_600) / 60);
	const seconds = totalSeconds % 60;
	if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
	if (minutes > 0) return `${minutes}m ${seconds}s`;
	return `${seconds}s`;
}

function formatRunAge(timestamp: number): string {
	return `${new Date(timestamp).toLocaleString()} (${formatDuration(Math.max(0, Date.now() - timestamp))} ago)`;
}

function contemplatorWaitingLabel(waitingFor: Runtime["contemplatorState"]["waitingFor"]): string {
	switch (waitingFor) {
		case "memories": return "waiting for memory threshold";
		case "responses": return "waiting for response spacing";
		case "ready": return "ready to launch";
		case "running": return "running";
		case "disabled": return "disabled";
		case "passive": return "passive mode";
		default: return "idle; no pending memories";
	}
}

function truncateStatusText(value: string, limit = 1_000): string {
	return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

function tokenSum(items: { tokenCount: number }[]): number {
	return items.reduce((sum, item) => sum + item.tokenCount, 0);
}

function addedSuffix(count: number): string | undefined {
	return count > 0 ? `+${count.toLocaleString()}` : undefined;
}

function removedSuffix(count: number): string | undefined {
	return count > 0 ? `-${count.toLocaleString()}` : undefined;
}

function appendSuffixes(line: string, suffixes: (string | undefined)[]): string {
	const rendered = suffixes.filter((suffix): suffix is string => suffix !== undefined);
	return rendered.length > 0 ? `${line} ${rendered.join(" ")}` : line;
}

export function registerStatusCommand(pi: ExtensionAPI, runtime: Runtime): void {
	pi.registerCommand("om:status", {
		description: "Show observational memory status",
		handler: async (_args, ctx) => {
			runtime.ensureConfig(ctx.cwd);
			const entries = ctx.sessionManager.getBranch() as Entry[];
			const folded = foldLedger(entries);
			const visible = visibleProjection(entries);
			const full = fullProjection(entries);
			const drift = diffProjection(visible, full);

			const visibleObservationTokens = tokenSum(visible.observations);
			const visibleSummaryTokens = tokenSum(visible.summaries);
			const activeMemoryTokens = tokenSum([...folded.activeObservations, ...folded.activeSummaries]);
			const observationLine = appendSuffixes(
				`Observations: ${folded.observations.length} recorded / ${folded.activeObservations.length} active / ${visible.observations.length} visible`,
				[addedSuffix(drift.observationsOnlyInFull.length), removedSuffix(drift.observationsOnlyInVisible.length)],
			);
			const summaryLine = appendSuffixes(
				`Summaries:    ${folded.summaries.length} recorded / ${folded.activeSummaries.length} active / ${visible.summaries.length} visible`,
				[addedSuffix(drift.summariesOnlyInFull.length), removedSuffix(drift.summariesOnlyInVisible.length)],
			);
			const obsProgress = rawTokensSinceObservationCoverage(entries);
			const compactionProgress = rawTokensSinceLastCompaction(entries);
			const contextWindow = typeof ctx.model?.contextWindow === "number" ? ctx.model.contextWindow : undefined;
			const compactThreshold = resolveCompactAfterTokens(runtime.config, contextWindow);

			const passiveLines = runtime.config.passive === true
				? [
					"── Mode ──",
					"Passive: automatic memory workers and auto-compaction disabled; manual/Pi compaction, commands, and recall remain active",
					"",
				]
				: [];

			const summarizerPendingCount = runtime.summarizerPendingCount;
			const summarizerPendingTokens = runtime.summarizerPendingTokens;
			const summarizerMinInterval = runtime.config.summarizerMinIntervalMinutes;
			const summarizerMaxDelay = runtime.config.summarizerMaxDelayMinutes;
			const summarizerNewTokenTrigger = runtime.config.summarizerMinNewMemoryTokens;
			const summarizerUrgentTokenTrigger = runtime.config.summarizerMaxPendingMemoryTokens;
			const summarizerPressureRatio = runtime.config.summarizerPressureTriggerRatio;
			const summarizerSamplingTokens = runtime.config.summarizerSamplingThresholdTokens;
			const lines = [
				...passiveLines,
				"── Memory ──",
				observationLine,
				summaryLine,
				"",
				"── Activity ──",
				`Next observation: ~${obsProgress.toLocaleString()} / ${runtime.config.observeAfterTokens.toLocaleString()} tokens (${pct(obsProgress, runtime.config.observeAfterTokens)}%)`,
				`Summarizer backlog: ${summarizerPendingCount.toLocaleString()} memories / ~${summarizerPendingTokens.toLocaleString()} tokens${runtime.summarizerDirtySince === undefined ? " (clean)" : " (dirty)"}`,
				`Next compaction:  ~${compactionProgress.toLocaleString()} / ${compactThreshold.toLocaleString()} tokens (${pct(compactionProgress, compactThreshold)}%)`,
				`Visible observation pool: ~${visibleObservationTokens.toLocaleString()} tokens`,
				`Active memory pool:      ~${activeMemoryTokens.toLocaleString()} / ${runtime.config.observationsPoolTargetTokens.toLocaleString()} advisory target tokens (${pct(activeMemoryTokens, runtime.config.observationsPoolTargetTokens)}%)`,
				`Summary pool:            ~${visibleSummaryTokens.toLocaleString()} visible tokens`,
				`Summarizer:              ${runtime.config.summarizerEnabled === false ? "disabled" : "enabled"}; min ${summarizerMinInterval} active-m / max ${summarizerMaxDelay} active-m / new-token trigger ${summarizerNewTokenTrigger.toLocaleString()} / urgent ${summarizerUrgentTokenTrigger.toLocaleString()} / pressure ${summarizerPressureRatio}× / sample above ~${summarizerSamplingTokens.toLocaleString()} tokens`,
				`Cumulative agent time:   ${formatDuration(agentActiveTimeMs(entries))}`,
				`Compaction observer:     ${runtime.config.compactionObserverEnabled === false ? "disabled" : "enabled"}`,
				`Contemplator:             ${runtime.config.contemplatorEnabled ? "enabled" : "disabled"}`,
				`Contemplator trigger:     ${runtime.contemplatorState.pendingObservations} observations / ${runtime.contemplatorState.pendingSummaries} summaries / ${runtime.contemplatorState.pendingReviews} reviews pending; ${runtime.contemplatorState.responsesSinceRun} / ${runtime.config.contemplatorMinTurns} primary responses; ${contemplatorWaitingLabel(runtime.contemplatorState.waitingFor)}`,
				`Contemplator model:      ${runtime.config.contemplatorModel ? `${runtime.config.contemplatorModel.provider}/${runtime.config.contemplatorModel.id}` : "current session model"}`,
				`Contemplator messages:   ${runtime.config.showContemplatorMessages ? "visible" : "hidden"}`,
				`Structural reviewer:     ${runtime.config.reviewerEnabled === false ? "disabled" : "enabled"}`,
				`Reviewer model:          ${runtime.config.reviewerModel ? `${runtime.config.reviewerModel.provider}/${runtime.config.reviewerModel.id}` : "current session model"}`,
			];

			lines.push(`Last observer start:     ${runtime.lastObserverStartedAt === undefined ? "not run this launch" : formatRunAge(runtime.lastObserverStartedAt)}`);
			lines.push(`Last observer end:       ${runtime.lastObserverCompletedAt === undefined ? "not completed this launch" : formatRunAge(runtime.lastObserverCompletedAt)}`);
			lines.push(`Last summarizer start:   ${runtime.lastSummarizerStartedAt === undefined ? "not run this launch" : formatRunAge(runtime.lastSummarizerStartedAt)}`);
			lines.push(`Last summarizer end:     ${runtime.lastSummarizerCompletedAt === undefined ? "not completed this launch" : formatRunAge(runtime.lastSummarizerCompletedAt)}`);
			lines.push(`Last contemplator start: ${runtime.contemplatorState.lastStartedAt === undefined ? "not run this launch" : formatRunAge(runtime.contemplatorState.lastStartedAt)}`);
			lines.push(`Last contemplator end:   ${runtime.contemplatorState.lastCompletedAt === undefined ? "not completed this launch" : formatRunAge(runtime.contemplatorState.lastCompletedAt)}`);

			if (runtime.agentUsage.runs > 0) {
				const u = runtime.agentUsage;
				lines.push(`Token usage:            ↑${formatTokens(u.input)} ↓${formatTokens(u.output)}${u.cacheRead ? ` R${formatTokens(u.cacheRead)}` : ""}${u.cacheWrite ? ` W${formatTokens(u.cacheWrite)}` : ""} $${u.cost.toFixed(3)} (${u.runs} call${u.runs === 1 ? "" : "s"})`);
			}

			// Probe stats come from the branch ledger (like /om:view contemplator):
			// deduped by probeId so restore re-queues don't inflate the count, and
			// entries without a probeId (sent before probe tracking existed) count
			// individually. Survives reloads, unlike an in-memory counter.
			const probeSuggestions: { suggestion: string }[] = [];
			const probeIndexByProbeId = new Map<string, number>();
			for (const entry of entries) {
				if (entry.customType !== CONTEMPLATOR_SUGGESTION) continue;
				const data = (entry.data ?? {}) as { suggestion?: unknown; probeId?: unknown };
				if (typeof data.suggestion !== "string") continue;
				if (typeof data.probeId !== "string") {
					probeSuggestions.push({ suggestion: data.suggestion });
					continue;
				}
				const existingIndex = probeIndexByProbeId.get(data.probeId);
				if (existingIndex === undefined) {
					probeIndexByProbeId.set(data.probeId, probeSuggestions.length);
					probeSuggestions.push({ suggestion: data.suggestion });
				} else {
					probeSuggestions[existingIndex] = { suggestion: data.suggestion };
				}
			}
			if (probeSuggestions.length > 0) {
				lines.push(`Probes sent:            ${probeSuggestions.length}`);
				lines.push(`Last probe:             ${probeSuggestions[probeSuggestions.length - 1].suggestion}`);
			}

			const latestReview = full.reviews?.at(-1);
			if (latestReview) {
				lines.push(`Last review:            [${latestReview.id}] ${latestReview.scope} ${latestReview.outcome}`);
				if (latestReview.outcome === "proposal") lines.push(`Last review summary:    ${truncateStatusText(latestReview.summary)}`);
				else lines.push(`Last review reason:     ${truncateStatusText(latestReview.reason)}`);
			}
			let latestNotice: string | undefined;
			for (const entry of entries) {
				if (entry.customType !== REVIEWER_NOTICE || !entry.data || typeof entry.data !== "object") continue;
				const content = (entry.data as { content?: unknown }).content;
				if (typeof content === "string") latestNotice = content;
			}
			if (latestNotice) lines.push(`Last reviewer notice:  ${truncateStatusText(latestNotice)}`);

			if (runtime.consolidationInFlight || runtime.summarizerInFlight || runtime.contemplatorState.running || runtime.compactInFlight || runtime.compactHookInFlight || runtime.reviewInFlight) {
				lines.push("", "── In flight ──");
				if (runtime.consolidationInFlight) {
					const phase = runtime.consolidationPhase ? ` (${runtime.consolidationPhase})` : "";
					lines.push(`Consolidation: running${phase}`);
				}
				if (runtime.summarizerInFlight) lines.push("Summarizer: running");
				if (runtime.contemplatorState.running) lines.push("Contemplator: running");
				if (runtime.compactInFlight) lines.push("Auto-compaction: running");
				if (runtime.compactHookInFlight) lines.push("Compaction hook: running");
				if (runtime.reviewInFlight) lines.push("Structural review: running");
			}

			if (runtime.lastObserverError || runtime.lastSummarizerError || runtime.contemplatorState.lastError) {
				lines.push("", "── Last error ──");
				if (runtime.lastObserverError) lines.push(`Observer: ${runtime.lastObserverError}`);
				if (runtime.lastSummarizerError) lines.push(`Summarizer: ${runtime.lastSummarizerError}`);
				if (runtime.contemplatorState.lastError) lines.push(`Contemplator: ${runtime.contemplatorState.lastError}`);
			}

			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}

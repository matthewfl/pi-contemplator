import { isContextOverflow } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolveCompactAfterTokens } from "../config.js";
import { rawTokensSinceLastCompaction, type Entry } from "../session-ledger/index.js";
import type { Runtime } from "../runtime.js";
import {
	registerCompactionResumeAcknowledgement,
	resumeAfterCompaction,
} from "./compaction-resume.js";

const COMPACTION_STATUS_KEY = "observational-memory-compaction";
type CompactionOrigin = "agent-requested" | "length-stop" | "proactive";

type TriggerOptions = {
	origin: CompactionOrigin;
	resume: boolean;
	threshold?: number;
	shortContinuationPrompt?: string;
};

export function registerCompactionTrigger(pi: ExtensionAPI, runtime: Runtime): void {
	registerCompactionResumeAcknowledgement(pi, runtime);

	const triggerCompaction = (ctx: any, options: TriggerOptions): void => {
		const { origin, resume, threshold, shortContinuationPrompt } = options;
		const hasUI = ctx.hasUI;
		const ui = ctx.ui;

		runtime.compactInFlight = true;
		runtime.compactOrigin = origin;
		setTimeout(() => {
			try {
				if (!ctx.isIdle()) {
					runtime.compactInFlight = false;
					runtime.compactOrigin = undefined;
					if (origin === "agent-requested") runtime.compactRequested = true;
					if (hasUI) ui?.notify(
						"Observational memory: compaction deferred — agent became busy before compaction",
						"info",
					);
					return;
				}
				const currentEntries = ctx.sessionManager.getBranch() as Entry[];
				const currentTokens = rawTokensSinceLastCompaction(currentEntries);
				if (threshold !== undefined && currentTokens < threshold) {
					runtime.compactInFlight = false;
					runtime.compactOrigin = undefined;
					if (hasUI) ui?.notify(
						"Observational memory: compaction skipped — another compaction already ran before deferred compaction",
						"info",
					);
					return;
				}
				if (hasUI) {
					const pending = resume ? ", resume pending" : "";
					ui?.setStatus?.(COMPACTION_STATUS_KEY, `OM compaction: running (${origin}${pending})`);
					const reason = origin === "agent-requested" ? "agent-requested, " : origin === "length-stop" ? "length-stop, " : "";
					const continuation = resume ? "; the interrupted agent run will resume automatically" : "";
					ui?.notify(
						`Observational memory: compaction started (${reason}~${currentTokens.toLocaleString()} tokens)${continuation}`,
						"info",
					);
				}
				if (origin === "agent-requested") runtime.compactContinuationPrompt = undefined;
				ctx.compact({
					onComplete: () => {
						runtime.compactInFlight = false;
						runtime.compactOrigin = undefined;
						if (hasUI && !resume) ui?.setStatus?.(COMPACTION_STATUS_KEY, undefined);
						if (resume) resumeAfterCompaction(pi, runtime, { hasUI, ui }, false, shortContinuationPrompt);
					},
					onError: (error: { message: string }) => {
						runtime.compactInFlight = false;
						runtime.compactOrigin = undefined;
						if (hasUI) ui?.setStatus?.(COMPACTION_STATUS_KEY, undefined);
						if (error.message !== "Compaction cancelled" && hasUI) {
							ui?.notify(`Observational memory: ${error.message}`, "error");
						}
						if (resume) resumeAfterCompaction(pi, runtime, { hasUI, ui }, true, shortContinuationPrompt);
					},
				});
			} catch (error) {
				runtime.compactInFlight = false;
				if (origin === "agent-requested") runtime.compactContinuationPrompt = undefined;
				runtime.compactOrigin = undefined;
				const msg = error instanceof Error ? error.message : String(error);
				if (hasUI) {
					ui?.setStatus?.(COMPACTION_STATUS_KEY, undefined);
					ui?.notify(`Observational memory: compact threw: ${msg}`, "error");
				}
				if (resume) resumeAfterCompaction(pi, runtime, { hasUI, ui }, true, shortContinuationPrompt);
			}
		}, 0);
	};

	pi.on("agent_end", (event: any, ctx: any) => {
		runtime.ensureConfig(ctx.cwd);
		if (runtime.compactInFlight) return;

		const agentRequested = runtime.compactRequested;
		if (agentRequested) {
			const shortContinuationPrompt = runtime.compactContinuationPrompt;
			runtime.compactRequested = false;
			triggerCompaction(ctx, { origin: "agent-requested", resume: true, shortContinuationPrompt });
			return;
		}
		if (runtime.config.passive === true) return;

		// Pi owns error, abort, and overflow retry policy. OM's session hook still
		// supplies the compaction contents when Pi performs a native retry.
		const lastAssistant = [...event.messages].reverse().find(
			(m): m is Extract<typeof m, { role: "assistant" }> => m.role === "assistant",
		);
		const contextWindow = typeof ctx.model?.contextWindow === "number" ? ctx.model.contextWindow : 0;
		if (
			!lastAssistant
			|| lastAssistant.stopReason === "error"
			|| lastAssistant.stopReason === "aborted"
			|| isContextOverflow(lastAssistant, contextWindow)
		) return;

		// A non-overflow length stop is interrupted work, not a normal completed
		// turn. Preserve the older compact-and-resume behavior only for this case.
		if (lastAssistant.stopReason !== "length") return;
		const entries = ctx.sessionManager.getBranch() as Entry[];
		const threshold = resolveCompactAfterTokens(runtime.config, contextWindow > 0 ? contextWindow : undefined);
		if (rawTokensSinceLastCompaction(entries) < threshold) return;
		triggerCompaction(ctx, { origin: "length-stop", resume: true, threshold });
	});

	// Proactive threshold compaction is maintenance after Pi has fully settled.
	// It must not manufacture another agent turn: the previous run completed
	// normally and there is no interrupted work to resume.
	pi.on("agent_settled", (_event: any, ctx: any) => {
		runtime.ensureConfig(ctx.cwd);
		if (runtime.config.passive === true || runtime.compactInFlight || runtime.compactRequested) return;
		const entries = ctx.sessionManager.getBranch() as Entry[];
		const contextWindow = typeof ctx.model?.contextWindow === "number" ? ctx.model.contextWindow : undefined;
		const threshold = resolveCompactAfterTokens(runtime.config, contextWindow);
		if (rawTokensSinceLastCompaction(entries) < threshold) return;
		triggerCompaction(ctx, { origin: "proactive", resume: false, threshold });
	});
}

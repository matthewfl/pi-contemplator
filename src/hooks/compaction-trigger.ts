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
export const COMPACTION_CALLBACK_TIMEOUT_MS = 30 * 60_000;
type CompactionOrigin = "agent-requested" | "length-stop" | "proactive";

type TriggerOptions = {
	origin: CompactionOrigin;
	resume: boolean;
	threshold?: number;
	shortContinuationPrompt?: string;
};

/** A stop with thinking but no text or tool call did not produce a usable turn. */
function isEmptyNormalStop(message: any): boolean {
	if (!message || message.role !== "assistant" || message.stopReason !== "stop") return false;
	if (typeof message.content === "string") return message.content.trim().length === 0;
	if (!Array.isArray(message.content)) return true;
	return !message.content.some((part: any) =>
		part?.type === "toolCall"
		|| (part?.type === "text" && typeof part.text === "string" && part.text.trim().length > 0),
	);
}

export function registerCompactionTrigger(pi: ExtensionAPI, runtime: Runtime): void {
	registerCompactionResumeAcknowledgement(pi, runtime);
	let resumeEmptyStopAfterProactiveCompaction = false;

	const triggerCompaction = (ctx: any, options: TriggerOptions): void => {
		const { origin, resume, threshold, shortContinuationPrompt } = options;
		const hasUI = ctx.hasUI;
		const ui = ctx.ui;
		const generation = runtime.getContextGeneration?.() ?? 0;

		runtime.compactInFlight = true;
		runtime.compactOrigin = origin;
		setTimeout(() => {
			try {
				if (!ctx.isIdle()) {
					runtime.compactInFlight = false;
					runtime.compactOrigin = undefined;
					if (origin === "agent-requested") runtime.compactRequested = true;
					if (hasUI) ui?.notify(
						"pi-contemplator: compaction deferred — agent became busy before compaction",
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
						"pi-contemplator: compaction skipped — another compaction already ran before deferred compaction",
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
						`pi-contemplator: compaction started (${reason}~${currentTokens.toLocaleString()} tokens)${continuation}`,
						"info",
					);
				}
				if (origin === "agent-requested") runtime.compactContinuationPrompt = undefined;
				let settled = false;
				const callbackTimeout = setTimeout(() => {
					if (settled || generation !== (runtime.getContextGeneration?.() ?? 0)) return;
					settled = true;
					runtime.compactInFlight = false;
					runtime.compactOrigin = undefined;
					if (hasUI) {
						ui?.setStatus?.(COMPACTION_STATUS_KEY, undefined);
						ui?.notify("pi-contemplator: compaction callback timed out; releasing the compaction lock", "error");
					}
					if (resume) resumeAfterCompaction(pi, runtime, { hasUI, ui }, true, shortContinuationPrompt);
				}, COMPACTION_CALLBACK_TIMEOUT_MS);
				(callbackTimeout as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.();
				const settle = (failed: boolean, error?: { message: string }) => {
					if (settled || generation !== (runtime.getContextGeneration?.() ?? 0)) return;
					settled = true;
					clearTimeout(callbackTimeout);
					runtime.compactInFlight = false;
					runtime.compactOrigin = undefined;
					if (hasUI && (failed || !resume)) ui?.setStatus?.(COMPACTION_STATUS_KEY, undefined);
					if (failed && error?.message !== "Compaction cancelled" && hasUI) ui?.notify(`pi-contemplator: ${error?.message ?? "compaction failed"}`, "error");
					if (resume) resumeAfterCompaction(pi, runtime, { hasUI, ui }, failed, shortContinuationPrompt);
				};
				try {
					ctx.compact({
						onComplete: () => settle(false),
						onError: (error: { message: string }) => settle(true, error),
					});
				} catch (error) {
					settled = true;
					clearTimeout(callbackTimeout);
					throw error;
				}
			} catch (error) {
				runtime.compactInFlight = false;
				if (origin === "agent-requested") runtime.compactContinuationPrompt = undefined;
				runtime.compactOrigin = undefined;
				const msg = error instanceof Error ? error.message : String(error);
				if (hasUI) {
					ui?.setStatus?.(COMPACTION_STATUS_KEY, undefined);
					ui?.notify(`pi-contemplator: compact threw: ${msg}`, "error");
				}
				if (resume) resumeAfterCompaction(pi, runtime, { hasUI, ui }, true, shortContinuationPrompt);
			}
		}, 0);
	};

	pi.on("agent_end", (event: any, ctx: any) => {
		runtime.ensureConfig(ctx.cwd);
		if (runtime.compactInFlight) return;

		const lastAssistant = [...event.messages].reverse().find(
			(m): m is Extract<typeof m, { role: "assistant" }> => m.role === "assistant",
		);
		// Some providers occasionally return stop after spending output tokens but
		// emit no text or tool call. Pi regards that as settled, yet it plainly is
		// not a completed autonomous turn. Remember this only until agent_settled so
		// threshold compaction can continue it; never resume an ordinary text stop.
		resumeEmptyStopAfterProactiveCompaction = isEmptyNormalStop(lastAssistant);

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
	// It must not manufacture another agent turn after an ordinary completed
	// response. The narrow exception is a provider's empty normal stop: there was
	// no usable response, so compaction must preserve the autonomous run rather
	// than making that provider failure look like successful completion.
	pi.on("agent_settled", (_event: any, ctx: any) => {
		const resume = resumeEmptyStopAfterProactiveCompaction;
		resumeEmptyStopAfterProactiveCompaction = false;
		runtime.ensureConfig(ctx.cwd);
		if (runtime.config.passive === true || runtime.compactInFlight || runtime.compactRequested) return;
		const entries = ctx.sessionManager.getBranch() as Entry[];
		const contextWindow = typeof ctx.model?.contextWindow === "number" ? ctx.model.contextWindow : undefined;
		const threshold = resolveCompactAfterTokens(runtime.config, contextWindow);
		if (rawTokensSinceLastCompaction(entries) < threshold) return;
		triggerCompaction(ctx, { origin: "proactive", resume, threshold });
	});
}

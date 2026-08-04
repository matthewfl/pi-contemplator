import { isContextOverflow } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolveCompactAfterTokens } from "../config.js";
import { rawTokensSinceLastCompaction, type Entry } from "../session-ledger/index.js";
import type { Runtime } from "../runtime.js";

const COMPACTION_STATUS_KEY = "observational-memory-compaction";

function resumeAgent(pi: ExtensionAPI, hasUI: boolean, ui: any, afterFailure = false): void {
	try {
		pi.sendMessage({
			customType: "om.compaction.resume",
			content: afterFailure
				? "Context compaction failed. Continue the current task without waiting for another user message."
				: "Continue the current task from the compacted context without waiting for another user message.",
			display: false,
		}, {
			deliverAs: "followUp",
			triggerTurn: true,
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (hasUI) ui?.notify(`Observational memory: failed to resume after compaction: ${message}`, "error");
	}
}

export function registerCompactionTrigger(pi: ExtensionAPI, runtime: Runtime): void {
	pi.on("agent_end", (event: any, ctx: any) => {
		runtime.ensureConfig(ctx.cwd);
		if (runtime.compactInFlight) return;

		const agentRequested = runtime.compactRequested;
		if (agentRequested) runtime.compactRequested = false;
		else if (runtime.config.passive === true) return;

		const contextWindow = typeof ctx.model?.contextWindow === "number" ? ctx.model.contextWindow : 0;
		let threshold: number | undefined;
		if (!agentRequested) {
			// agent_end fires before Pi decides whether to retry or compact-and-retry an
			// interrupted request. Starting ctx.compact() here turns it into a manual
			// compaction (willRetry=false) and can consume Pi's overflow recovery, leaving
			// the agent idle. Let Pi handle every failed/aborted/overflow response; OM's
			// session_before_compact hook still supplies the actual memory compaction.
			const lastAssistant = [...event.messages].reverse().find(
				(m): m is Extract<typeof m, { role: "assistant" }> => m.role === "assistant",
			);
			if (
				lastAssistant
				&& (
					lastAssistant.stopReason === "error"
						|| lastAssistant.stopReason === "aborted"
						|| isContextOverflow(lastAssistant, contextWindow)
				)
			) return;

			const entries = ctx.sessionManager.getBranch() as Entry[];
			const tokens = rawTokensSinceLastCompaction(entries);
			// Resolve the proactive-compaction threshold from the active model's context
			// window when ratio mode is configured. ctx.model is the current session model
			// (Model<any> | undefined per ExtensionContext).
			threshold = resolveCompactAfterTokens(runtime.config, contextWindow > 0 ? contextWindow : undefined);
			if (tokens < threshold) return;
		}

		// Capture ctx properties synchronously — the setTimeout + async work below
		// may outlive the extension ctx (stale after session replacement/reload).
		const hasUI = ctx.hasUI;
		const ui = ctx.ui;
		const origin = agentRequested ? "agent-requested" : "proactive";

		runtime.compactInFlight = true;
		runtime.compactOrigin = origin;
		setTimeout(() => {
			try {
				if (!ctx.isIdle()) {
					runtime.compactInFlight = false;
					runtime.compactOrigin = undefined;
					if (agentRequested) runtime.compactRequested = true;
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
					ui?.setStatus?.(COMPACTION_STATUS_KEY, `OM compaction: running (${origin}, resume pending)`);
					const reason = agentRequested ? "agent-requested, " : "";
					ui?.notify(
						`Observational memory: compaction started (${reason}~${currentTokens.toLocaleString()} tokens); the agent will resume automatically`,
						"info",
					);
				}
				ctx.compact({
					onComplete: () => {
						runtime.compactInFlight = false;
						runtime.compactOrigin = undefined;
						resumeAgent(pi, hasUI, ui);
					},
					onError: (error: { message: string }) => {
						runtime.compactInFlight = false;
						runtime.compactOrigin = undefined;
						if (hasUI) ui?.setStatus?.(COMPACTION_STATUS_KEY, undefined);
						if (error.message !== "Compaction cancelled" && hasUI) {
							ui?.notify(`Observational memory: ${error.message}`, "error");
						}
						if (agentRequested) resumeAgent(pi, hasUI, ui, true);
					},
				});
			} catch (error) {
				runtime.compactInFlight = false;
				runtime.compactOrigin = undefined;
				const msg = error instanceof Error ? error.message : String(error);
				if (hasUI) {
					ui?.setStatus?.(COMPACTION_STATUS_KEY, undefined);
					ui?.notify(`Observational memory: compact threw: ${msg}`, "error");
				}
				if (agentRequested) resumeAgent(pi, hasUI, ui, true);
			}
		}, 0);
	});
}

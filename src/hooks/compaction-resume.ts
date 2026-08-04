import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Runtime } from "../runtime.js";

const NATIVE_RESUME_GRACE_MS = 5_000;
const RESUME_RETRY_DELAYS_MS = [250, 1_000] as const;

interface ResumeCtx {
	hasUI: boolean;
	ui?: {
		notify?: (message: string, level?: "info" | "warning" | "error") => void;
	};
}

function clearResumeWatch(runtime: Runtime): void {
	if (runtime.compactionResumeTimer !== undefined) {
		clearTimeout(runtime.compactionResumeTimer);
		runtime.compactionResumeTimer = undefined;
	}
	runtime.compactionResumePending = false;
}

function beginResumeWatch(runtime: Runtime): number {
	clearResumeWatch(runtime);
	runtime.compactionResumePending = true;
	runtime.compactionResumeGeneration += 1;
	return runtime.compactionResumeGeneration;
}

function isCurrentWatch(runtime: Runtime, generation: number): boolean {
	return runtime.compactionResumePending && runtime.compactionResumeGeneration === generation;
}

function sendResumeMessage(pi: ExtensionAPI, ctx: ResumeCtx, afterFailure: boolean): void {
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
		ctx.ui?.notify?.(`Observational memory: failed to request continuation: ${message}`, "error");
	}
}

function scheduleResumeRetries(
	pi: ExtensionAPI,
	runtime: Runtime,
	ctx: ResumeCtx,
	generation: number,
	afterFailure: boolean,
	retryIndex = 0,
): void {
	if (!isCurrentWatch(runtime, generation)) return;
	if (retryIndex >= RESUME_RETRY_DELAYS_MS.length) {
		runtime.compactionResumeTimer = setTimeout(() => {
			if (!isCurrentWatch(runtime, generation)) return;
			clearResumeWatch(runtime);
			ctx.ui?.notify?.(
				"Observational memory: the agent did not acknowledge continuation after compaction",
				"error",
			);
		}, RESUME_RETRY_DELAYS_MS.at(-1));
		return;
	}

	runtime.compactionResumeTimer = setTimeout(() => {
		if (!isCurrentWatch(runtime, generation)) return;
		ctx.ui?.notify?.(
			`Observational memory: continuation did not start; retrying (${retryIndex + 1}/${RESUME_RETRY_DELAYS_MS.length})`,
			"warning",
		);
		sendResumeMessage(pi, ctx, afterFailure);
		scheduleResumeRetries(pi, runtime, ctx, generation, afterFailure, retryIndex + 1);
	}, RESUME_RETRY_DELAYS_MS[retryIndex]);
}

/** Send OM's continuation immediately, then retry unless a new agent run acknowledges it. */
export function resumeAfterCompaction(
	pi: ExtensionAPI,
	runtime: Runtime,
	ctx: ResumeCtx,
	afterFailure = false,
): void {
	const generation = beginResumeWatch(runtime);
	sendResumeMessage(pi, ctx, afterFailure);
	scheduleResumeRetries(pi, runtime, ctx, generation, afterFailure);
}

/**
 * Pi normally retries native overflow compaction itself. If no new agent_start
 * arrives after the compaction event settles, send OM's hidden continuation as
 * a fallback. This also covers length-stop retries that cannot continue from an
 * assistant message.
 */
export function watchForNativeCompactionResume(
	pi: ExtensionAPI,
	runtime: Runtime,
	ctx: ResumeCtx,
): void {
	const generation = beginResumeWatch(runtime);
	runtime.compactionResumeTimer = setTimeout(() => {
		if (!isCurrentWatch(runtime, generation)) return;
		ctx.ui?.notify?.(
			"Observational memory: native compaction did not resume the agent; sending fallback continuation",
			"warning",
		);
		sendResumeMessage(pi, ctx, false);
		scheduleResumeRetries(pi, runtime, ctx, generation, false);
	}, NATIVE_RESUME_GRACE_MS);
}

/** Any new agent run proves that the post-compaction continuation started. */
export function registerCompactionResumeAcknowledgement(pi: ExtensionAPI, runtime: Runtime): void {
	pi.on("agent_start", () => {
		if (!runtime.compactionResumePending) return;
		clearResumeWatch(runtime);
	});
}

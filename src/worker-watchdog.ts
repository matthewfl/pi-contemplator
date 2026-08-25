export const BACKGROUND_WORKER_STALL_TIMEOUT_MS = 15 * 60_000;
export const BACKGROUND_WORKER_MAX_RUNTIME_MS = 6 * 60 * 60_000;

/**
 * No-progress watchdog for background model workers.
 *
 * Aborting the provider is the cooperative path. `race()` is the hard liveness
 * boundary: even a provider that ignores AbortSignal cannot retain a worker's
 * single-flight lock forever. The abandoned promise has handlers installed by
 * Promise.race, so a later rejection is not unhandled.
 */
export function createWorkerStallWatchdog(
	label: string,
	timeoutMs = BACKGROUND_WORKER_STALL_TIMEOUT_MS,
	onStall?: (error: Error) => void,
	maxRuntimeMs = BACKGROUND_WORKER_MAX_RUNTIME_MS,
): {
	signal: AbortSignal;
	progress: () => void;
	race: <T>(work: Promise<T>) => Promise<T>;
	dispose: () => void;
} {
	const controller = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	let maxRuntimeTimer: ReturnType<typeof setTimeout> | undefined;
	let rejectStall!: (error: Error) => void;
	let settled = false;
	const stalled = new Promise<never>((_resolve, reject) => { rejectStall = reject; });
	// Some callers use only the cooperative AbortSignal. Keep the hard-boundary
	// promise observed even before/without a race() call.
	void stalled.catch(() => {});
	const trip = (error: Error) => {
		if (settled || controller.signal.aborted) return;
		controller.abort(error);
		onStall?.(error);
		rejectStall(error);
	};
	maxRuntimeTimer = setTimeout(() => trip(new Error(`${label} exceeded its ${Math.round(maxRuntimeMs / 3_600_000)}-hour runtime ceiling`)), maxRuntimeMs);
	(maxRuntimeTimer as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.();
	const progress = () => {
		if (settled || controller.signal.aborted) return;
		if (timer !== undefined) clearTimeout(timer);
		timer = setTimeout(() => {
			timer = undefined;
			if (settled) return;
			trip(new Error(`${label} produced no progress for ${Math.round(timeoutMs / 60_000)} minutes`));
		}, timeoutMs);
		(timer as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.();
	};
	progress();
	return {
		signal: controller.signal,
		progress,
		race: async <T>(work: Promise<T>) => Promise.race([work, stalled]),
		dispose: () => {
			settled = true;
			if (timer !== undefined) clearTimeout(timer);
			if (maxRuntimeTimer !== undefined) clearTimeout(maxRuntimeTimer);
			timer = undefined;
			maxRuntimeTimer = undefined;
		},
	};
}

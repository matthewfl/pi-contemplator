import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorkerStallWatchdog } from "../src/worker-watchdog.js";

afterEach(() => vi.useRealTimers());

describe("background worker watchdog", () => {
	it("hard-rejects a hung worker even when it ignores AbortSignal", async () => {
		vi.useFakeTimers();
		const watchdog = createWorkerStallWatchdog("test worker", 1_000);
		const raced = watchdog.race(new Promise<never>(() => {}));
		const assertion = expect(raced).rejects.toThrow("test worker produced no progress");
		await vi.advanceTimersByTimeAsync(1_000);
		await assertion;
		expect(watchdog.signal.aborted).toBe(true);
		watchdog.dispose();
	});

	it("progress postpones the hard liveness boundary", async () => {
		vi.useFakeTimers();
		const watchdog = createWorkerStallWatchdog("test worker", 1_000);
		const work = new Promise<string>((resolve) => setTimeout(() => resolve("ok"), 1_500));
		const raced = watchdog.race(work);
		await vi.advanceTimersByTimeAsync(900);
		watchdog.progress();
		await vi.advanceTimersByTimeAsync(600);
		await expect(raced).resolves.toBe("ok");
		watchdog.dispose();
	});
});

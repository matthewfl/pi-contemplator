import { describe, expect, it, vi } from "vitest";

import { registerCompactionHook } from "../src/hooks/compaction-hook.js";

function captureFailedHandler(runtimeOverrides: Record<string, unknown> = {}) {
	let failed: ((event: any, ctx: any) => void) | undefined;
	const pi = {
		on: vi.fn((name: string, handler: (event: any, ctx: any) => void) => {
			if (name === "session_compact_failed") failed = handler;
		}),
	};
	const runtime = {
		compactInFlight: false,
		compactOrigin: undefined,
		compactHookInFlight: false,
		...runtimeOverrides,
	};
	registerCompactionHook(pi as any, runtime as any);
	if (!failed) throw new Error("session_compact_failed handler was not registered");
	return { failed, pi, runtime };
}

function ctx() {
	return {
		hasUI: true,
		ui: { setStatus: vi.fn(), notify: vi.fn() },
	};
}

describe("session_compact_failed handling", () => {
	it("clears stale status and reports a native compaction failure", () => {
		const { failed } = captureFailedHandler();
		const context = ctx();

		failed({
			type: "session_compact_failed",
			reason: "overflow",
			errorMessage: "Context overflow recovery failed: quota exceeded",
			aborted: false,
			willRetry: false,
			fromExtension: true,
		}, context);

		expect(context.ui.setStatus).toHaveBeenCalledWith("observational-memory-compaction", undefined);
		expect(context.ui.notify).toHaveBeenCalledWith(
			"pi-contemplator: compaction failed (overflow): Context overflow recovery failed: quota exceeded",
			"error",
		);
	});

	it("clears status without presenting user cancellation as an error", () => {
		const { failed } = captureFailedHandler();
		const context = ctx();

		failed({
			type: "session_compact_failed",
			reason: "manual",
			aborted: true,
			willRetry: false,
			fromExtension: false,
		}, context);

		expect(context.ui.setStatus).toHaveBeenCalledWith("observational-memory-compaction", undefined);
		expect(context.ui.notify).not.toHaveBeenCalled();
	});

	it("leaves OM-initiated failure handling to ctx.compact onError", () => {
		const { failed } = captureFailedHandler({ compactInFlight: true, compactOrigin: "agent-requested" });
		const context = ctx();

		failed({
			type: "session_compact_failed",
			reason: "manual",
			errorMessage: "Compaction failed: provider unavailable",
			aborted: false,
			willRetry: false,
			fromExtension: true,
		}, context);

		expect(context.ui.setStatus).not.toHaveBeenCalled();
		expect(context.ui.notify).not.toHaveBeenCalled();
	});
});

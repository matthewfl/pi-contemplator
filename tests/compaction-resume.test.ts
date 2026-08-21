import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	registerCompactionResumeAcknowledgement,
	resumeAfterCompaction,
	watchForNativeCompactionResume,
} from "../src/hooks/compaction-resume.js";

function setup() {
	let agentStart: (() => void) | undefined;
	const pi = {
		on: vi.fn((event: string, handler: () => void) => {
			if (event === "agent_start") agentStart = handler;
		}),
		sendMessage: vi.fn(),
	};
	const runtime = {
		compactionResumePending: false,
		compactionResumeGeneration: 0,
		compactionResumeTimer: undefined,
	};
	const ctx = {
		hasUI: true,
		ui: { notify: vi.fn() },
	};
	registerCompactionResumeAcknowledgement(pi as any, runtime as any);
	if (!agentStart) throw new Error("agent_start handler was not registered");
	return { pi, runtime, ctx, agentStart };
}

describe("compaction resume watchdog", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it("accepts agent_start as acknowledgement of an immediate OM continuation", async () => {
		const { pi, runtime, ctx, agentStart } = setup();

		resumeAfterCompaction(pi as any, runtime as any, ctx);
		agentStart();
		await vi.runAllTimersAsync();

		expect(pi.sendMessage).toHaveBeenCalledTimes(1);
		expect(runtime.compactionResumePending).toBe(false);
		expect(ctx.ui.notify).not.toHaveBeenCalledWith(expect.stringContaining("retrying"), "warning");
	});

	it("retries the agent-authored continuation and reports final failure", async () => {
		const { pi, runtime, ctx } = setup();

		resumeAfterCompaction(pi as any, runtime as any, ctx, false, "Run the targeted test, then continue the implementation.");
		await vi.runAllTimersAsync();

		expect(pi.sendMessage).toHaveBeenCalledTimes(3);
		expect(pi.sendMessage).toHaveBeenCalledWith({
			customType: "om.compaction.resume",
			content: "Run the targeted test, then continue the implementation.",
			display: false,
		}, { deliverAs: "followUp", triggerTurn: true });
		expect(runtime.compactionResumePending).toBe(false);
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			"pi-contemplator: the agent did not acknowledge continuation after compaction",
			"error",
		);
	});

	it("does nothing when Pi acknowledges its native overflow retry", async () => {
		const { pi, runtime, ctx, agentStart } = setup();

		watchForNativeCompactionResume(pi as any, runtime as any, ctx);
		agentStart();
		await vi.runAllTimersAsync();

		expect(pi.sendMessage).not.toHaveBeenCalled();
		expect(runtime.compactionResumePending).toBe(false);
	});

	it("sends a fallback when native overflow compaction does not restart", async () => {
		const { pi, runtime, ctx, agentStart } = setup();

		watchForNativeCompactionResume(pi as any, runtime as any, ctx);
		await vi.advanceTimersByTimeAsync(4_999);
		expect(pi.sendMessage).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);

		expect(pi.sendMessage).toHaveBeenCalledTimes(1);
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			"pi-contemplator: native compaction did not resume the agent; sending fallback continuation",
			"warning",
		);

		agentStart();
		await vi.runAllTimersAsync();
		expect(pi.sendMessage).toHaveBeenCalledTimes(1);
	});
});

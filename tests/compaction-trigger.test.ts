import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { registerCompactionTrigger } from "../src/hooks/compaction-trigger.js";
import { compactionEntry, textCustomMessage, type TestEntry } from "./fixtures/session.js";

function captureHandler(args: { compactAfterTokens?: number; compactAfterTokensMode?: "calibrated" | "ratio"; compactAfterTokensRatio?: number; passive?: boolean; compactInFlight?: boolean } = {}) {
	let handler: ((event: unknown, ctx: unknown) => void) | undefined;
	let settledHandler: ((event: unknown, ctx: unknown) => void) | undefined;
	let agentStartHandler: (() => void) | undefined;
	const pi = {
		on: vi.fn((name: string, cb: typeof handler) => {
			if (name === "agent_end") handler = cb;
			if (name === "agent_settled") settledHandler = cb;
			if (name === "agent_start") agentStartHandler = cb as () => void;
		}),
		sendMessage: vi.fn(),
	};
	const runtime = {
		ensureConfig: vi.fn(),
		config: {
			compactAfterTokens: args.compactAfterTokens ?? 3,
			compactAfterTokensMode: args.compactAfterTokensMode ?? "calibrated",
			compactAfterTokensRatio: args.compactAfterTokensRatio ?? 0.68,
			passive: args.passive ?? false,
		},
		compactInFlight: args.compactInFlight ?? false,
		compactionResumePending: false,
		compactionResumeGeneration: 0,
		compactionResumeTimer: undefined,
		observerPromise: new Promise(() => {}),
		reflectDropPromise: new Promise(() => {}),
	};
	registerCompactionTrigger(pi as any, runtime as any);
	if (!handler) throw new Error("agent_end handler was not registered");
	if (!settledHandler) throw new Error("agent_settled handler was not registered");
	if (!agentStartHandler) throw new Error("agent_start handler was not registered");
	return { handler, settledHandler, agentStartHandler, runtime, pi };
}

function agentEnd(errorMessage?: string) {
	return {
		type: "agent_end",
		messages: [
			{ role: "user", content: "hello" },
			errorMessage
				? { role: "assistant", content: [], stopReason: "error", errorMessage }
				: { role: "assistant", content: "done", stopReason: "end_turn" },
		],
	};
}

function fakeCtx(branches: TestEntry[][], overrides: Record<string, unknown> = {}) {
	let branchIndex = 0;
	const getBranch = vi.fn(() => branches[Math.min(branchIndex++, branches.length - 1)]);
	return {
		cwd: "/tmp/project",
		sessionManager: { getBranch },
		hasUI: true,
		ui: { notify: vi.fn(), setStatus: vi.fn() },
		isIdle: vi.fn(() => true),
		compact: vi.fn(),
		model: undefined,
		...overrides,
	};
}

const dueBranch = [textCustomMessage("raw-1", "aaaaaaaaaaaa")]; // 3 tokens
const belowBranch = [textCustomMessage("raw-1", "aaaa")]; // 1 token

describe("V3 compaction trigger", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("does nothing below compactAfterTokens", async () => {
		const { settledHandler, runtime } = captureHandler({ compactAfterTokens: 3 });
		const ctx = fakeCtx([belowBranch]);

		settledHandler({}, ctx);
		await vi.runAllTimersAsync();

		expect(runtime.compactInFlight).toBe(false);
		expect(ctx.compact).not.toHaveBeenCalled();
	});

	it("calls compact after the agent settles when compactAfterTokens is reached", async () => {
		const { settledHandler, runtime } = captureHandler({ compactAfterTokens: 3 });
		const ctx = fakeCtx([dueBranch]);

		settledHandler({}, ctx);
		expect(runtime.compactInFlight).toBe(true);
		await vi.runAllTimersAsync();

		expect(ctx.compact).toHaveBeenCalledTimes(1);
		expect(ctx.ui.setStatus).toHaveBeenCalledWith(
			"observational-memory-compaction",
			"OM compaction: running (proactive)",
		);
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			"Observational memory: compaction started (~3 tokens)",
			"info",
		);
	});

	it("does not restart normally completed work after proactive compaction", async () => {
		const { handler, settledHandler, runtime, pi } = captureHandler({ compactAfterTokens: 3 });
		const ctx = fakeCtx([dueBranch], {
			compact: vi.fn((options) => options.onComplete()),
		});

		handler(agentEnd(), ctx);
		await vi.runAllTimersAsync();
		expect(ctx.compact).not.toHaveBeenCalled();

		settledHandler({}, ctx);
		await vi.runAllTimersAsync();

		expect(runtime.compactInFlight).toBe(false);
		expect(ctx.compact).toHaveBeenCalledTimes(1);
		expect(pi.sendMessage).not.toHaveBeenCalled();
	});

	it("does not restart settled work when proactive compaction fails", async () => {
		const { settledHandler, runtime, pi } = captureHandler({ compactAfterTokens: 3 });
		const ctx = fakeCtx([dueBranch], {
			compact: vi.fn((options) => options.onError({ message: "Nothing to compact" })),
		});

		settledHandler({}, ctx);
		await vi.runAllTimersAsync();

		expect(runtime.compactInFlight).toBe(false);
		expect(pi.sendMessage).not.toHaveBeenCalled();
	});

	it("honors an agent-requested compaction even in passive mode and resumes with its continuation", async () => {
		const { handler, runtime, pi } = captureHandler({ compactAfterTokens: 99, passive: true });
		(runtime as any).compactRequested = true;
		(runtime as any).compactContinuationPrompt = "Inspect the failing test output, then fix the parser.";
		const ctx = fakeCtx([belowBranch], {
			compact: vi.fn((options) => options.onComplete()),
		});

		handler(agentEnd(), ctx);
		await vi.runAllTimersAsync();

		expect((runtime as any).compactRequested).toBe(false);
		expect(ctx.compact).toHaveBeenCalledTimes(1);
		expect(ctx.ui.setStatus).toHaveBeenCalledWith(
			"observational-memory-compaction",
			"OM compaction: running (agent-requested, resume pending)",
		);
		expect(pi.sendMessage).toHaveBeenCalledWith({
			customType: "om.compaction.resume",
			content: "Inspect the failing test output, then fix the parser.",
			display: false,
		}, {
			deliverAs: "followUp",
			triggerTurn: true,
		});
		expect((runtime as any).compactContinuationPrompt).toBeUndefined();
	});

	it("requeues an agent-requested compaction if the agent becomes busy", async () => {
		const { handler, runtime } = captureHandler();
		(runtime as any).compactRequested = true;
		const ctx = fakeCtx([belowBranch], { isIdle: vi.fn(() => false) });

		handler(agentEnd(), ctx);
		await vi.runAllTimersAsync();

		expect(ctx.compact).not.toHaveBeenCalled();
		expect((runtime as any).compactRequested).toBe(true);
		expect(runtime.compactInFlight).toBe(false);
	});

	it("agent-requested compaction bypasses the overflow-skip guard (intentional)", async () => {
		// compactRequested is set only by the compact_context tool, which returns terminate:true.
		// A successful tool call implies the assistant response was parsed (stopReason tool_use),
		// not an overflow/error — so the overflow guard would not have fired anyway. The bypass
		// is intentional: the agent explicitly asked to compact and resume, so OM honors it.
		const { handler, runtime, pi } = captureHandler({ compactAfterTokens: 99 });
		(runtime as any).compactRequested = true;
		const ctx = fakeCtx([belowBranch], {
			compact: vi.fn((options) => options.onComplete()),
		});

		handler(agentEnd("context window exceeded: prompt is too long"), ctx);
		await vi.runAllTimersAsync();

		expect(ctx.compact).toHaveBeenCalledTimes(1);
		expect(pi.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({ customType: "om.compaction.resume" }),
			expect.objectContaining({ triggerTurn: true }),
		);
	});

	it("skips passive mode", async () => {
		const { settledHandler, runtime } = captureHandler({ passive: true });
		const ctx = fakeCtx([dueBranch]);

		settledHandler({}, ctx);
		await vi.runAllTimersAsync();

		expect(runtime.compactInFlight).toBe(false);
		expect(ctx.sessionManager.getBranch).not.toHaveBeenCalled();
		expect(ctx.compact).not.toHaveBeenCalled();
	});

	it("skips when compaction is already in flight", async () => {
		const { settledHandler } = captureHandler({ compactInFlight: true });
		const ctx = fakeCtx([dueBranch]);

		settledHandler({}, ctx);
		await vi.runAllTimersAsync();

		expect(ctx.sessionManager.getBranch).not.toHaveBeenCalled();
		expect(ctx.compact).not.toHaveBeenCalled();
	});

	it.each([
		"fetch failed: connection lost",
		"context window exceeded: prompt is too long",
	])("never races Pi retry/overflow recovery for assistant errors: %s", async (errorMessage) => {
		const { handler, runtime } = captureHandler();
		const ctx = fakeCtx([dueBranch]);

		handler(agentEnd(errorMessage), ctx);
		await vi.runAllTimersAsync();

		expect(runtime.compactInFlight).toBe(false);
		expect(ctx.sessionManager.getBranch).not.toHaveBeenCalled();
		expect(ctx.compact).not.toHaveBeenCalled();
	});

	it("leaves usage-detected context overflow to Pi even when stopReason is length", async () => {
		const { handler, runtime } = captureHandler();
		const ctx = fakeCtx([dueBranch], { model: { provider: "test", id: "model", contextWindow: 10 } });
		const event = agentEnd() as any;
		event.messages[event.messages.length - 1] = {
			role: "assistant",
			provider: "test",
			model: "model",
			content: [],
			stopReason: "length",
			usage: { input: 11, output: 0, cacheRead: 0, cacheWrite: 0 },
		};

		handler(event, ctx);
		await vi.runAllTimersAsync();

		expect(runtime.compactInFlight).toBe(false);
		expect(ctx.sessionManager.getBranch).not.toHaveBeenCalled();
		expect(ctx.compact).not.toHaveBeenCalled();
	});

	it("resumes a mid-output length stop after proactive compaction", async () => {
		const { handler, pi } = captureHandler({ compactAfterTokens: 3 });
		const ctx = fakeCtx([dueBranch], {
			model: { provider: "test", id: "model", contextWindow: 10 },
			compact: vi.fn((options) => options.onComplete()),
		});
		const event = agentEnd() as any;
		event.messages[event.messages.length - 1] = {
			role: "assistant",
			provider: "test",
			model: "model",
			content: [{ type: "text", text: "unfinished sentence" }],
			stopReason: "length",
			usage: { input: 9, output: 2, cacheRead: 0, cacheWrite: 0 },
		};

		handler(event, ctx);
		await vi.runAllTimersAsync();

		expect(ctx.compact).toHaveBeenCalledTimes(1);
		expect(pi.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({ customType: "om.compaction.resume" }),
			expect.objectContaining({ triggerTurn: true }),
		);
	});

	it("does not await observer or reflect/drop promises before compacting", async () => {
		const { settledHandler } = captureHandler({ compactAfterTokens: 3 });
		const ctx = fakeCtx([dueBranch]);

		settledHandler({}, ctx);
		await vi.runAllTimersAsync();

		expect(ctx.compact).toHaveBeenCalledTimes(1);
	});

	it("defers compaction if context is no longer idle", async () => {
		const { settledHandler, runtime } = captureHandler({ compactAfterTokens: 3 });
		const ctx = fakeCtx([dueBranch], { isIdle: vi.fn(() => false) });

		settledHandler({}, ctx);
		await vi.runAllTimersAsync();

		expect(ctx.compact).not.toHaveBeenCalled();
		expect(runtime.compactInFlight).toBe(false);
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			"Observational memory: compaction deferred — agent became busy before compaction",
			"info",
		);
	});

	it("re-checks threshold after deferral and skips if another compaction already reduced pressure", async () => {
		const { settledHandler, runtime } = captureHandler({ compactAfterTokens: 3 });
		const ctx = fakeCtx([dueBranch, belowBranch]);

		settledHandler({}, ctx);
		await vi.runAllTimersAsync();

		expect(ctx.compact).not.toHaveBeenCalled();
		expect(runtime.compactInFlight).toBe(false);
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			"Observational memory: compaction skipped — another compaction already ran before deferred compaction",
			"info",
		);
	});

	it("counts raw tokens since the latest Pi compaction using V3 progress helpers", async () => {
		const { settledHandler } = captureHandler({ compactAfterTokens: 3 });
		const branch = [
			textCustomMessage("raw-1", "aaaaaaaaaaaa"),
			compactionEntry("cmp-1", { firstKeptEntryId: "raw-2" }),
			textCustomMessage("raw-2", "aaaa"),
			textCustomMessage("raw-3", "bbbbbbbb"),
		];
		const ctx = fakeCtx([branch]);

		settledHandler({}, ctx);
		await vi.runAllTimersAsync();

		expect(ctx.compact).toHaveBeenCalledTimes(1);
	});

	describe("ratio mode", () => {
		it("scales the compaction threshold by model.contextWindow", async () => {
			// 3 tokens raw; ratio 0.5 of 4-token window = 2 -> threshold 2, so 3 >= 2 fires.
			const { settledHandler } = captureHandler({
				compactAfterTokens: 81000,
				compactAfterTokensMode: "ratio",
				compactAfterTokensRatio: 0.5,
			});
			const ctx = fakeCtx([dueBranch], { model: { contextWindow: 4 } });

			settledHandler({}, ctx);
			await vi.runAllTimersAsync();

			expect(ctx.compact).toHaveBeenCalledTimes(1);
		});

		it("does not compact when raw tokens are below the scaled threshold", async () => {
			// 1 token raw (belowBranch); ratio 0.5 of 4 = 2 -> threshold 2, so 1 < 2 does not fire.
			const { settledHandler } = captureHandler({
				compactAfterTokens: 81000,
				compactAfterTokensMode: "ratio",
				compactAfterTokensRatio: 0.5,
			});
			const ctx = fakeCtx([belowBranch], { model: { contextWindow: 4 } });

			settledHandler({}, ctx);
			await vi.runAllTimersAsync();

			expect(ctx.compact).not.toHaveBeenCalled();
		});

		it("falls back to calibrated value when model.contextWindow is unavailable", async () => {
			// ratio mode but no model -> falls back to compactAfterTokens=81000, so 3 tokens won't fire.
			const { settledHandler } = captureHandler({
				compactAfterTokens: 81000,
				compactAfterTokensMode: "ratio",
				compactAfterTokensRatio: 0.5,
			});
			const ctx = fakeCtx([dueBranch], { model: undefined });

			settledHandler({}, ctx);
			await vi.runAllTimersAsync();

			expect(ctx.compact).not.toHaveBeenCalled();
		});

		it("falls back to calibrated value when contextWindow is zero", async () => {
			const { settledHandler } = captureHandler({
				compactAfterTokens: 81000,
				compactAfterTokensMode: "ratio",
				compactAfterTokensRatio: 0.5,
			});
			const ctx = fakeCtx([dueBranch], { model: { contextWindow: 0 } });

			settledHandler({}, ctx);
			await vi.runAllTimersAsync();

			expect(ctx.compact).not.toHaveBeenCalled();
		});

		it("uses the same resolved threshold on deferred re-check", async () => {
			// threshold = 0.5 * 4 = 2; first branch has 3 (fires, deferred), isIdle=false defers,
			// second branch has 1 (< 2) -> skipped because another compaction reduced pressure.
			const { settledHandler, runtime } = captureHandler({
				compactAfterTokens: 81000,
				compactAfterTokensMode: "ratio",
				compactAfterTokensRatio: 0.5,
			});
			const ctx = fakeCtx([dueBranch, belowBranch], {
				model: { contextWindow: 4 },
				isIdle: vi.fn(() => false),
			});

			settledHandler({}, ctx);
			await vi.runAllTimersAsync();

			expect(ctx.compact).not.toHaveBeenCalled();
			expect(runtime.compactInFlight).toBe(false);
		});
	});
});

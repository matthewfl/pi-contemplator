import { describe, expect, it, vi } from "vitest";

import {
	COMPACT_CONTEXT_DESCRIPTION,
	COMPACT_CONTEXT_TOOL_NAME,
	createCompactContextTool,
	registerCompactContextTool,
} from "../src/tools/compact-context.js";

function runtime(overrides: Record<string, unknown> = {}) {
	return {
		compactInFlight: false,
		compactRequested: false,
		...overrides,
	};
}

describe("compact_context tool", () => {
	it("registers the manual compaction tool with sparing-use guidance", () => {
		const pi = { registerTool: vi.fn() };
		const state = runtime();

		registerCompactContextTool(pi as any, state as any);

		const tool = pi.registerTool.mock.calls[0]?.[0];
		expect(tool.name).toBe(COMPACT_CONTEXT_TOOL_NAME);
		expect(tool.name).toBe("compact_context");
		expect(tool.description).toBe(COMPACT_CONTEXT_DESCRIPTION);
		expect(tool.description).not.toMatch(/observational|\bOM\b/i);
		expect(tool.promptGuidelines.join(" ")).toMatch(/sparingly/i);
		expect(tool.promptGuidelines.join(" ")).toMatch(/substantial additional work/i);
		expect(tool.promptGuidelines.join(" ")).toMatch(/not enough context left/i);
		expect(tool.promptGuidelines.join(" ")).toMatch(/struggling to focus/i);
		expect(tool.promptGuidelines.join(" ")).toMatch(/reason about it reliably/i);
	});

	it("schedules compaction and terminates the current tool turn", async () => {
		const state = runtime();
		const tool = createCompactContextTool(state as any);

		const result = await tool.execute("tool-1", {}, undefined as any, undefined as any, {} as any);

		expect(state.compactRequested).toBe(true);
		expect(result).toMatchObject({
			details: { status: "scheduled" },
			terminate: true,
		});
	});

	it("does not enqueue duplicate compaction requests", async () => {
		const state = runtime({ compactRequested: true });
		const tool = createCompactContextTool(state as any);

		const result = await tool.execute("tool-1", {}, undefined as any, undefined as any, {} as any);

		expect(state.compactRequested).toBe(true);
		expect(result).toMatchObject({
			details: { status: "already_pending" },
			terminate: true,
		});
	});

	it("reports in_progress and does not double-request when a compaction is already running", async () => {
		const state = runtime({ compactInFlight: true });
		const tool = createCompactContextTool(state as any);

		const result = await tool.execute("tool-1", {}, undefined as any, undefined as any, {} as any);

		expect(state.compactRequested).toBe(false);
		expect(result).toMatchObject({
			details: { status: "in_progress" },
			terminate: true,
		});
	});
});

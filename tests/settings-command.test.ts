import { describe, expect, it, vi } from "vitest";

import { registerSettingsCommand } from "../src/commands/settings.js";
import { OM_SETTINGS, Runtime } from "../src/runtime.js";

function settingsEntry(data: Record<string, unknown>) {
	return { type: "custom", customType: OM_SETTINGS, data };
}

describe("/om:settings", () => {
	it("restores branch-local settings after tree navigation", () => {
		let entries: unknown[] = [settingsEntry({ passive: true, contemplatorMinTurns: 3 })];
		const handlers: Record<string, ((event: unknown, ctx: any) => void) | undefined> = {};
		const pi = {
			on: vi.fn((event: string, handler: (event: unknown, ctx: any) => void) => {
				handlers[event] = handler;
			}),
			registerCommand: vi.fn(),
		};
		const runtime = new Runtime();
		runtime.configLoaded = true;
		const ctx = {
			cwd: "/tmp/project",
			sessionManager: { getBranch: () => entries },
		};
		registerSettingsCommand(pi as any, runtime);

		handlers.session_start?.(undefined, ctx);
		expect(runtime.config.passive).toBe(true);
		expect(runtime.config.contemplatorMinTurns).toBe(3);

		entries = [settingsEntry({ passive: false, contemplatorMinTurns: 8 })];
		handlers.session_tree?.(undefined, ctx);
		expect(runtime.config.passive).toBe(false);
		expect(runtime.config.contemplatorMinTurns).toBe(8);
	});

	it("supports contemplator message quick toggles", async () => {
		let commandHandler: ((args: unknown, ctx: any) => Promise<void>) | undefined;
		const pi = {
			on: vi.fn(),
			appendEntry: vi.fn(),
			registerCommand: vi.fn((_name: string, command: { handler: typeof commandHandler }) => {
				commandHandler = command.handler;
			}),
		};
		const runtime = new Runtime();
		runtime.configLoaded = true;
		registerSettingsCommand(pi as any, runtime);
		if (!commandHandler) throw new Error("settings handler not registered");
		const notify = vi.fn();
		await commandHandler("messages off", {
			cwd: "/tmp/project",
			sessionManager: { getBranch: () => [] },
			ui: { notify },
		});

		expect(runtime.config.showContemplatorMessages).toBe(false);
		expect(pi.appendEntry).toHaveBeenCalledWith(OM_SETTINGS, { version: 1, showContemplatorMessages: false });
		expect(notify).toHaveBeenCalledWith("Contemplator messages: hidden for this session.", "info");
	});

	it("supports reviewer quick toggles", async () => {
		let commandHandler: ((args: unknown, ctx: any) => Promise<void>) | undefined;
		const pi = {
			on: vi.fn(),
			appendEntry: vi.fn(),
			registerCommand: vi.fn((_name: string, command: { handler: typeof commandHandler }) => {
				commandHandler = command.handler;
			}),
		};
		const runtime = new Runtime();
		runtime.configLoaded = true;
		registerSettingsCommand(pi as any, runtime);
		if (!commandHandler) throw new Error("settings handler not registered");
		const notify = vi.fn();
		await commandHandler("reviewer off", {
			cwd: "/tmp/project",
			sessionManager: { getBranch: () => [] },
			ui: { notify },
		});

		expect(runtime.config.reviewerEnabled).toBe(false);
		expect(pi.appendEntry).toHaveBeenCalledWith(OM_SETTINGS, { version: 1, reviewerEnabled: false });
		expect(notify).toHaveBeenCalledWith("Structural reviewer: disabled for this session.", "info");
	});

	it("rejects a pool maximum that is not greater than the target", async () => {
		let commandHandler: ((args: unknown, ctx: any) => Promise<void>) | undefined;
		const pi = {
			on: vi.fn(),
			appendEntry: vi.fn(),
			registerCommand: vi.fn((_name: string, command: { handler: typeof commandHandler }) => {
				commandHandler = command.handler;
			}),
		};
		const runtime = new Runtime();
		runtime.configLoaded = true;
		registerSettingsCommand(pi as any, runtime);
		if (!commandHandler) throw new Error("settings handler not registered");
		const select = vi.fn()
			.mockResolvedValueOnce("Observation pool max: default (20000)")
			.mockResolvedValueOnce("Done");
		const notify = vi.fn();
		const ctx = {
			cwd: "/tmp/project",
			sessionManager: { getBranch: () => [] },
			modelRegistry: {},
			ui: {
				select,
				input: vi.fn().mockResolvedValue("5000"),
				notify,
			},
		};

		await commandHandler("", ctx);

		expect(pi.appendEntry).not.toHaveBeenCalled();
		expect(runtime.config.observationsPoolMaxTokens).toBe(20_000);
		expect(runtime.config.observationsPoolTargetTokens).toBe(10_000);
		expect(notify).toHaveBeenCalledWith(
			"Observation pool max must be greater than the current target. Lower the target first.",
			"warning",
		);
	});
});

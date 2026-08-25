import { describe, expect, it } from "vitest";
import { DEFAULTS } from "../src/config.js";
import { observerInputCapLabel } from "../src/commands/settings.js";

function runtime(observerChunkMaxTokens?: number, sessionOverride = false): any {
	return {
		config: { ...DEFAULTS, ...(observerChunkMaxTokens === undefined ? {} : { observerChunkMaxTokens }) },
		getSessionSettings: () => sessionOverride ? { observerChunkMaxTokens } : {},
	};
}

describe("observer settings labels", () => {
	it("shows the percentage and resolved token count for a derived cap", () => {
		expect(observerInputCapLabel(runtime(), 256_000)).toBe("25% of 256,000 = 64,000 tokens (derived default)");
	});

	it("shows the fallback token count when model context is unavailable", () => {
		expect(observerInputCapLabel(runtime(), undefined)).toBe("60,000 tokens (fallback default; model context unavailable)");
	});

	it("shows an explicit session cap directly", () => {
		expect(observerInputCapLabel(runtime(40_000, true), 256_000)).toBe("40,000 tokens");
	});
});

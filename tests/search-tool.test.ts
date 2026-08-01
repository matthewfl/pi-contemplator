import { describe, expect, it } from "vitest";

import { searchMemoriesTool } from "../src/tools/search-memories.js";
import {
	observation,
	observationsRecordedEntry,
	textCustomMessage,
} from "./fixtures/session.js";

describe("search_memories tool", () => {
	it("returns discoverable ids and directs the agent to recall", async () => {
		const memory = observation("aaaaaaaaaaaa", {
			content: "User chose the SQLite database for local tests.",
		});
		const result = await searchMemoriesTool.execute(
			"tool-call-1",
			{ query: "SQLite database" },
			new AbortController().signal,
			() => undefined,
			{
				sessionManager: {
					getBranch: () => [
						textCustomMessage("raw-1", "database"),
						observationsRecordedEntry("obs-entry", {
							observations: [memory],
							coversUpToId: "raw-1",
						}),
					],
				},
			} as any,
		);
		const text =
			result.content[0]?.type === "text" ? result.content[0].text : "";

		expect(text).toContain("[aaaaaaaaaaaa]");
		expect(text).toContain("Use recall(<id>) for exact source context.");
		expect(result.details).toMatchObject({
			query: "SQLite database",
			results: [{ id: "aaaaaaaaaaaa" }],
		});
	});
});

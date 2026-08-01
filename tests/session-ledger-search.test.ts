import { describe, expect, it } from "vitest";

import { searchMemories } from "../src/session-ledger/search.js";
import {
	observation,
	observationsDroppedEntry,
	observationsRecordedEntry,
	reflection,
	reflectionsRecordedEntry,
	textCustomMessage,
} from "./fixtures/session.js";

describe("memory search", () => {
	it("finds observations and reflections by distinctive keywords", () => {
		const obs = observation("aaaaaaaaaaaa", {
			content: "User chose Postgres for the project database.",
			relevance: "high",
		});
		const ref = reflection("bbbbbbbbbbbb", ["aaaaaaaaaaaa"], {
			content: "The project uses Postgres as its database.",
		});
		const result = searchMemories(
			[
				textCustomMessage("raw-1", "database decision"),
				observationsRecordedEntry("obs-entry", {
					observations: [obs],
					coversUpToId: "raw-1",
				}),
				reflectionsRecordedEntry("ref-entry", {
					reflections: [ref],
					coversUpToId: "obs-entry",
				}),
			],
			"Postgres database",
		);

		expect(result.observationsSearched).toBe(1);
		expect(result.reflectionsSearched).toBe(1);
		expect(result.results.map((item) => item.id)).toEqual([
			"bbbbbbbbbbbb",
			"aaaaaaaaaaaa",
		]);
	});

	it("includes dropped observations so old memories remain discoverable", () => {
		const obs = observation("aaaaaaaaaaaa", {
			content: "The old API endpoint was /v1/users.",
		});
		const result = searchMemories(
			[
				textCustomMessage("raw-1", "old endpoint"),
				observationsRecordedEntry("obs-entry", {
					observations: [obs],
					coversUpToId: "raw-1",
				}),
				observationsDroppedEntry("drop-entry", {
					observationIds: [obs.id],
					coversUpToId: "obs-entry",
				}),
			],
			"endpoint users",
		);

		expect(result.results[0]).toMatchObject({
			id: "aaaaaaaaaaaa",
			status: "dropped",
		});
	});

	it("returns no matches for unrelated terms", () => {
		const result = searchMemories(
			[textCustomMessage("raw-1", "nothing")],
			"authentication",
		);
		expect(result.results).toEqual([]);
	});
});

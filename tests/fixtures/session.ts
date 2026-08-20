export type TestEntry = {
	type: string;
	id: string;
	parentId: string | null;
	timestamp: string;
	message?: unknown;
	content?: unknown;
	customType?: string;
	summary?: unknown;
	data?: unknown;
	details?: unknown;
	firstKeptEntryId?: string;
	fromId?: string;
};

export type TestObservation = {
	id: string;
	content: string;
	timestamp: string;
	relevance: "low" | "medium" | "high" | "critical";
	retention?: "ephemeral" | "contextual" | "durable";
	sourceEntryIds: string[];
	tokenCount: number;
};

export const OM_OBSERVATIONS_RECORDED = "om.observations.recorded";

const DEFAULT_TIMESTAMP = "2026-05-02T10:00:00.000Z";

export function textCustomMessage(
	id: string,
	text: string,
	overrides: Partial<TestEntry> = {},
): TestEntry {
	return {
		type: "custom_message",
		id,
		parentId: null,
		timestamp: DEFAULT_TIMESTAMP,
		content: text,
		...overrides,
	};
}

export function compactionEntry(
	id: string,
	args: { firstKeptEntryId?: string; details?: unknown; summary?: string } = {},
	overrides: Partial<TestEntry> = {},
): TestEntry {
	return {
		type: "compaction",
		id,
		parentId: null,
		timestamp: DEFAULT_TIMESTAMP,
		firstKeptEntryId: args.firstKeptEntryId,
		summary: args.summary ?? "compacted memory",
		details: args.details,
		...overrides,
	};
}

export function observation(
	id: string,
	overrides: Partial<TestObservation> = {},
): TestObservation {
	return {
		id,
		content: `Observation ${id}`,
		timestamp: DEFAULT_TIMESTAMP,
		relevance: "medium",
		retention: "contextual",
		sourceEntryIds: ["raw-1"],
		tokenCount: 10,
		...overrides,
	};
}

export function observationsRecordedEntry(
	id: string,
	args: { observations: TestObservation[]; coversUpToId: string },
	overrides: Partial<TestEntry> = {},
): TestEntry {
	return {
		type: "custom",
		id,
		parentId: null,
		timestamp: DEFAULT_TIMESTAMP,
		customType: OM_OBSERVATIONS_RECORDED,
		data: args,
		...overrides,
	};
}

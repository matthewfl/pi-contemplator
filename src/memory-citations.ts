const DELIMITED_MEMORY_ID_RE = /\[([0-9a-f]{7,16})\]|\(([0-9a-f]{7,16})\)|\{([0-9a-f]{7,16})\}/g;

/**
 * Extract citation-shaped memory or entry ids. Bare hashes are intentionally
 * ignored because commit hashes and unrelated technical identifiers are common.
 */
export function delimitedMemoryIds(text: string): string[] {
	const ids: string[] = [];
	const seen = new Set<string>();
	for (const match of text.matchAll(DELIMITED_MEMORY_ID_RE)) {
		const id = match[1] ?? match[2] ?? match[3];
		if (!id || seen.has(id)) continue;
		seen.add(id);
		ids.push(id);
	}
	return ids;
}

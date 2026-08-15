const MEMORY_ID_RE = /(?<![0-9A-Za-z])([0-9a-f]{7,16})(?![0-9A-Za-z])/g;
const DELIMITED_LIST_RES = [/\[([^\]]*)\]/g, /\(([^)]*)\)/g, /\{([^}]*)\}/g];
const MEMORY_ID_LIST_RE = /^\s*[0-9a-f]{7,16}(?:\s*,\s*[0-9a-f]{7,16})*\s*$/;

/**
 * Extract likely memory or entry references in textual order.
 *
 * IDs inside [], (), or {} may be comma-separated. A bare candidate must
 * contain both a digit and a letter so ordinary words made only from a-f and
 * decimal numbers are not mistaken for references. Delimited IDs do not need
 * that mix because the delimiters provide an explicit citation signal.
 */
export function memoryReferenceIds(text: string): string[] {
	const delimitedRanges: Array<[number, number]> = [];
	for (const expression of DELIMITED_LIST_RES) {
		for (const match of text.matchAll(expression)) {
			const contents = match[1];
			if (contents !== undefined && MEMORY_ID_LIST_RE.test(contents)) {
				const start = (match.index ?? 0) + 1;
				delimitedRanges.push([start, start + contents.length]);
			}
		}
	}

	const ids: string[] = [];
	const seen = new Set<string>();
	for (const match of text.matchAll(MEMORY_ID_RE)) {
		const id = match[1];
		const index = match.index ?? -1;
		const explicitlyDelimited = delimitedRanges.some(([start, end]) => index >= start && index < end);
		const hashLike = /[0-9]/.test(id) && /[a-f]/.test(id);
		if ((!explicitlyDelimited && !hashLike) || seen.has(id)) continue;
		seen.add(id);
		ids.push(id);
	}
	return ids;
}

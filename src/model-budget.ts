import type { Model } from "@earendil-works/pi-ai";

export const AGENT_LOOP_MAX_TOKENS = 32_000;

/** Observer output allowance for difficult, high-volume source chunks. */
export const OBSERVER_AGENT_LOOP_MAX_TOKENS = 160_000;

/**
 * Lifetime output-token budget for one structural review request.
 * Persisted reviewer transcripts carry usage across keep-going iterations,
 * internal tool turns, and later session/tree resumptions.
 */
export const REVIEWER_TOTAL_TOKEN_LIMIT = 1_000_000;

export function boundedMaxTokens(model: Model<any>, requested: number = AGENT_LOOP_MAX_TOKENS): number {
	return typeof model.maxTokens === "number" && model.maxTokens > 0
		? Math.min(model.maxTokens, requested)
		: requested;
}

import type { Model } from "@earendil-works/pi-ai";

export const AGENT_LOOP_MAX_TOKENS = 32_000;

/**
 * Cumulative output-token budget for a short-lived structural reviewer run.
 * Enforced across all keep-going loop iterations, not per LLM call.
 */
export const REVIEWER_TOTAL_TOKEN_LIMIT = 1_000_000;

export function boundedMaxTokens(model: Model<any>, requested: number = AGENT_LOOP_MAX_TOKENS): number {
	return typeof model.maxTokens === "number" && model.maxTokens > 0
		? Math.min(model.maxTokens, requested)
		: requested;
}

import { agentLoop, type AgentContext, type AgentLoopConfig, type AgentMessage, type AgentTool } from "@earendil-works/pi-agent-core";
import type { Message, Model } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import { hashId } from "../../ids.js";
import { boundedMaxTokens, REVIEWER_TOTAL_TOKEN_LIMIT } from "../../model-budget.js";
import type { LlmUsageInput } from "../../runtime.js";
import type { Entry, ReviewResult, StructuralReviewRequest } from "../../session-ledger/types.js";
import { createRecallAgentTool } from "../../tools/recall-observation.js";
import { createSearchMemoriesAgentTool } from "../../tools/search-memories.js";
import { logAgentStreamError } from "../stream-errors.js";
import { buildReviewerSystemPrompt } from "./prompts.js";
import { createNoProposalTool, createSoftwareProposalTool, createWorkflowProposalTool, type ReviewTerminalResult } from "./tools.js";

export const REVIEWER_KEEP_GOING_MESSAGE =
	"You have not yet produced a terminal review outcome. Continue investigating the memories and, when you are ready, call exactly one terminal tool: the available proposal tool if a durable conceptual proposal is supported, or review_concluded_no_proposal otherwise. Do not call any terminal tool more than once.";

export interface RunStructuralReviewArgs {
	request: StructuralReviewRequest;
	model: Model<any>;
	apiKey: string;
	headers?: Record<string, string>;
	getBranch: () => Entry[];
	signal?: AbortSignal;
	agentLoop?: typeof agentLoop;
	recordUsage?: (usage: LlmUsageInput) => void;
	/** Receives the reviewer's assistant output for durable debug/view rendering. */
	onMessages?: (messages: AgentMessage[]) => void;
}

export function buildReviewRequestMessage(request: StructuralReviewRequest): Message {
	return {
		role: "user",
		content: [{ type: "text", text: `STRUCTURAL REVIEW REQUEST

Review request id:
${request.id}

Scope:
${request.scope}

Evidence identified by the contemplator:
${request.evidence}

Suspected concern:
${request.concern}

Review focus:
${request.reviewFocus}

Relevant constraints:
${request.constraints ?? "(none recorded)"}

Recall the cited memories first. Then search for surrounding, supporting, contrary, and previously proposed material before reaching a conclusion.` }],
		timestamp: Date.now(),
	};
}

function assistantOutputTokens(messages: AgentMessage[]): number {
	let total = 0;
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		const usage = message.usage as { output?: unknown } | undefined;
		if (typeof usage?.output === "number" && Number.isFinite(usage.output)) total += Math.max(0, usage.output);
	}
	return total;
}

export async function runStructuralReview(args: RunStructuralReviewArgs): Promise<ReviewResult | undefined> {
	let terminal: ReviewTerminalResult | undefined;
	const acceptTerminal = (candidate: ReviewTerminalResult): void => {
		if (terminal) throw new Error("A structural reviewer may make only one terminal tool call.");
		terminal = candidate;
	};
	const searchMemories = createSearchMemoriesAgentTool(args.getBranch);
	const recall = createRecallAgentTool(args.getBranch);
	const scopeTool = args.request.scope === "workflow"
		? createWorkflowProposalTool(acceptTerminal)
		: createSoftwareProposalTool(acceptTerminal);
	const noProposal = createNoProposalTool(args.request.scope, acceptTerminal);
	const tools = [searchMemories as AgentTool<any>, recall as AgentTool<any>, scopeTool as AgentTool<any>, noProposal as AgentTool<any>];
	const config: AgentLoopConfig = {
		model: args.model,
		apiKey: args.apiKey,
		headers: args.headers,
		// Per-call cap is raised so the reviewer is not trimmed to the contemplator
		// budget; the cumulative budget below bounds the whole run.
		maxTokens: boundedMaxTokens(args.model, REVIEWER_TOTAL_TOKEN_LIMIT),
		convertToLlm: (messages) => messages as Message[],
		toolExecution: "sequential",
		shouldStopAfterTurn: () => terminal !== undefined,
	};
	const loop = args.agentLoop ?? agentLoop;

	const history: AgentMessage[] = [];
	const assistantMessages: AgentMessage[] = [];
	let totalOutputTokens = 0;

	// Re-invoke the bounded loop with an accumulated transcript so the reviewer
	// can keep working across iterations. Each call returns its own new messages;
	// the passed-in history is copied internally, so we append the results here.
	const runOnce = async (prompts: AgentMessage[]): Promise<void> => {
		const context: AgentContext = { systemPrompt: buildReviewerSystemPrompt(args.request.scope), messages: history, tools };
		const stream = loop(prompts, context, config, args.signal, streamSimple);
		for await (const event of stream) logAgentStreamError("reviewer", event);
		const newMessages = await stream.result();
		history.push(...newMessages);
		const assistants = newMessages.filter((message): message is AgentMessage => message.role === "assistant");
		assistantMessages.push(...assistants);
		if (args.recordUsage) {
			for (const message of assistants) {
				if (message.role === "assistant" && message.usage) args.recordUsage(message.usage);
			}
		}
		totalOutputTokens += assistantOutputTokens(assistants);
	};

	await runOnce([buildReviewRequestMessage(args.request)]);

	// Keep-going loop: if the reviewer stops without a terminal call, prompt it
	// to continue until it reaches a terminal outcome or the cumulative budget.
	while (!terminal && totalOutputTokens < REVIEWER_TOTAL_TOKEN_LIMIT) {
		const iterationStartTokens = totalOutputTokens;
		const keepGoing: Message = { role: "user", content: [{ type: "text", text: REVIEWER_KEEP_GOING_MESSAGE }], timestamp: Date.now() };
		await runOnce([keepGoing]);
		// Stop immediately once a terminal tool has been recorded (end of this run).
		if (terminal) break;
		// Guard against a pathological/zero-token non-terminal stop: an iteration
		// that produces no new output should not spin forever.
		if (totalOutputTokens - iterationStartTokens === 0) break;
	}

	args.onMessages?.(assistantMessages);
	if (!terminal) return undefined;
	return {
		...terminal,
		id: hashId(`${args.request.id}:${JSON.stringify(terminal)}:${Date.now()}`),
		version: 1,
		reviewRequestId: args.request.id,
		createdAt: Date.now(),
		requestedBy: "contemplator",
	} as ReviewResult;
}

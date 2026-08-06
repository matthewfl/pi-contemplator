import { agentLoop, type AgentContext, type AgentLoopConfig, type AgentMessage, type AgentTool } from "@earendil-works/pi-agent-core";
import type { Message, Model } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import { hashId } from "../../ids.js";
import { boundedMaxTokens, AGENT_LOOP_MAX_TOKENS } from "../../model-budget.js";
import type { LlmUsageInput } from "../../runtime.js";
import type { Entry, ReviewResult, StructuralReviewRequest } from "../../session-ledger/types.js";
import { createRecallAgentTool } from "../../tools/recall-observation.js";
import { createSearchMemoriesAgentTool } from "../../tools/search-memories.js";
import { logAgentStreamError } from "../stream-errors.js";
import { buildReviewerSystemPrompt } from "./prompts.js";
import { createNoProposalTool, createSoftwareProposalTool, createWorkflowProposalTool, type ReviewTerminalResult } from "./tools.js";

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
	const context: AgentContext = {
		systemPrompt: buildReviewerSystemPrompt(args.request.scope),
		messages: [],
		tools: [searchMemories as AgentTool<any>, recall as AgentTool<any>, scopeTool as AgentTool<any>, noProposal as AgentTool<any>],
	};
	const config: AgentLoopConfig = {
		model: args.model,
		apiKey: args.apiKey,
		headers: args.headers,
		maxTokens: boundedMaxTokens(args.model, AGENT_LOOP_MAX_TOKENS),
		convertToLlm: (messages) => messages as Message[],
		toolExecution: "sequential",
		shouldStopAfterTurn: () => terminal !== undefined,
	};
	const loop = args.agentLoop ?? agentLoop;
	const stream = loop([buildReviewRequestMessage(args.request)], context, config, args.signal, streamSimple);
	for await (const event of stream) logAgentStreamError("reviewer", event);
	const messages = await stream.result();
	args.onMessages?.(messages.filter((message): message is AgentMessage => message.role === "assistant"));
	if (args.recordUsage) {
		for (const message of messages) {
			if (message.role === "assistant" && message.usage) args.recordUsage(message.usage);
		}
	}
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

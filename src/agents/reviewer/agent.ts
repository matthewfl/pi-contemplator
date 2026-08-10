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
import { createReadChatHistoryAgentTool, createSearchChatHistoryAgentTool } from "./history-tools.js";
import { buildReviewerSystemPrompt } from "./prompts.js";
import { createNoProposalTool, createSoftwareProposalTool, createWorkflowProposalTool, type ReviewTerminalResult } from "./tools.js";

export const REVIEWER_KEEP_GOING_MESSAGE =
	"You have not yet produced a terminal review outcome. Continue investigating the memories and, when you are ready, call exactly one terminal tool: the available proposal tool if a durable conceptual proposal is supported, or review_concluded_no_proposal otherwise. Do not call any terminal tool more than once.";

/** Avoid an expensive live spin when a reviewer repeatedly stops with ordinary text. */
export const REVIEWER_MAX_INVOCATIONS_PER_LAUNCH = 5;

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
	/** Previously persisted reviewer transcript; a non-empty history resumes work. */
	history?: AgentMessage[];
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
	const searchChatHistory = createSearchChatHistoryAgentTool(args.getBranch);
	const readChatHistory = createReadChatHistoryAgentTool(args.getBranch);
	const scopeTool = args.request.scope === "workflow"
		? createWorkflowProposalTool(acceptTerminal)
		: createSoftwareProposalTool(acceptTerminal);
	const noProposal = createNoProposalTool(args.request.scope, acceptTerminal);
	const tools = [
		searchMemories as AgentTool<any>,
		recall as AgentTool<any>,
		searchChatHistory as AgentTool<any>,
		readChatHistory as AgentTool<any>,
		scopeTool as AgentTool<any>,
		noProposal as AgentTool<any>,
	];
	const loop = args.agentLoop ?? agentLoop;
	const history = [...(args.history ?? [])];
	// Usage on persisted assistant messages makes this a lifetime request budget,
	// rather than a fresh allowance on each session/tree resumption.
	let totalOutputTokens = assistantOutputTokens(history);
	if (totalOutputTokens >= REVIEWER_TOTAL_TOKEN_LIMIT) return undefined;

	// Persist both the user continuation and the returned messages immediately.
	// This makes the transcript sufficient to resume a review after shutdown.
	const runOnce = async (prompt: Message): Promise<number> => {
		const iterationStartTokens = totalOutputTokens;
		let streamedOutputTokens = 0;
		const remainingBudget = () => Math.max(0, REVIEWER_TOTAL_TOKEN_LIMIT - totalOutputTokens);
		// agentLoop can make several model calls while following tool calls. Wrap its
		// stream function so every internal response gets only the lifetime budget
		// remaining after earlier responses, not a fresh per-turn allowance.
		const budgetedStreamSimple: typeof streamSimple = ((model: Model<any>, context: any, options: any) => {
			const response = streamSimple(model, context, {
				...options,
				maxTokens: boundedMaxTokens(model, remainingBudget()),
			});
			let accounted = false;
			const result = async () => {
				const message = await response.result();
				if (!accounted) {
					accounted = true;
					const output = assistantOutputTokens([message as AgentMessage]);
					streamedOutputTokens += output;
					totalOutputTokens += output;
				}
				return message;
			};
			return { [Symbol.asyncIterator]: () => response[Symbol.asyncIterator](), result } as ReturnType<typeof streamSimple>;
		}) as typeof streamSimple;
		const config: AgentLoopConfig = {
			model: args.model,
			apiKey: args.apiKey,
			headers: args.headers,
			maxTokens: boundedMaxTokens(args.model, remainingBudget()),
			convertToLlm: (messages) => messages as Message[],
			toolExecution: "sequential",
			shouldStopAfterTurn: () => terminal !== undefined || remainingBudget() === 0,
		};
		const promptMessage = prompt as AgentMessage;
		// agentLoop receives the new prompt separately. Its context must therefore
		// contain only prior messages, otherwise a resumed prompt is sent twice.
		const context: AgentContext = { systemPrompt: buildReviewerSystemPrompt(args.request.scope), messages: history.slice(), tools };
		history.push(promptMessage);
		args.onMessages?.([promptMessage]);
		const stream = loop([prompt], context, config, args.signal, budgetedStreamSimple);
		for await (const event of stream) logAgentStreamError("reviewer", event);
		const newMessages = await stream.result();
		history.push(...newMessages);
		args.onMessages?.(newMessages);
		const assistants = newMessages.filter((message): message is AgentMessage => message.role === "assistant");
		if (args.recordUsage) {
			for (const message of assistants) {
				const usage = (message as { usage?: LlmUsageInput }).usage;
				if (usage) args.recordUsage(usage);
			}
		}
		// Injected test loops do not use the supplied stream function. Count any
		// assistant usage that the real stream wrapper did not already account for.
		const reportedOutputTokens = assistantOutputTokens(assistants);
		totalOutputTokens += Math.max(0, reportedOutputTokens - streamedOutputTokens);
		return totalOutputTokens - iterationStartTokens;
	};

	let invocations = 0;
	let progress = await runOnce(history.length === 0
		? buildReviewRequestMessage(args.request)
		: { role: "user", content: [{ type: "text", text: REVIEWER_KEEP_GOING_MESSAGE }], timestamp: Date.now() });
	invocations++;

	// agentLoop already continues through memory/history tool calls. Permit a
	// small number of explicit retries when it stops with ordinary text, but do
	// not re-feed an ever-growing transcript until the token budget is exhausted.
	while (!terminal && progress > 0 && totalOutputTokens < REVIEWER_TOTAL_TOKEN_LIMIT && invocations < REVIEWER_MAX_INVOCATIONS_PER_LAUNCH) {
		const keepGoing: Message = { role: "user", content: [{ type: "text", text: REVIEWER_KEEP_GOING_MESSAGE }], timestamp: Date.now() };
		progress = await runOnce(keepGoing);
		invocations++;
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

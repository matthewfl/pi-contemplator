import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { Static, TSchema } from "typebox";
import type { ReviewNoProposal, SoftwareReviewProposal, WorkflowReviewProposal } from "../../session-ledger/types.js";

const prose = (description: string) => Type.String({ minLength: 1, description });

export const WorkflowProposalSchema = Type.Object({
	title: prose("Short natural-language name for the workflow improvement."),
	summary: prose("Compact advisory summary suitable for the primary-agent notice."),
	evidence: prose("Evidence grounded in cited memory or primary-chat entry ids, including relevant contrary evidence."),
	inefficiency: prose("Recurring expensive, unreliable, or difficult-to-review work."),
	conceptual_design: prose("High-level planning prose describing the improved capability or process; no code or implementation steps."),
	inputs: Type.Optional(prose("Ordinary-language inputs, artifacts, context, or questions.")),
	outputs: Type.Optional(prose("Ordinary-language outputs, evidence, artifacts, or representations.")),
	integration: Type.Optional(prose("How the primary agent could conceptually reuse, refine, or extend it.")),
	expected_effect: prose("Expected effect on efficiency, reliability, evidence quality, reproducibility, or reviewability."),
	uncertainties: prose("Unknowns and tradeoffs the primary agent must evaluate."),
});

export const SoftwareProposalSchema = Type.Object({
	title: prose("Short natural-language name for the software design improvement."),
	summary: prose("Compact advisory summary suitable for the primary-agent notice."),
	evidence: prose("Evidence grounded in cited memory or primary-chat entry ids, including relevant contrary evidence."),
	structural_issue: prose("Recurring structural symptom, missing invariant, duplicated concept, or unsuitable boundary."),
	conceptual_design: prose("High-level design of concepts, responsibilities, relationships, and invariants; no code or implementation steps."),
	preserved_behavior: prose("User intent, visible behavior, constraints, and semantics to preserve."),
	expected_effect: prose("Expected reduction in special cases, duplication, contradictions, coupling, or maintenance risk."),
	uncertainties: prose("Unknowns and tradeoffs the primary agent must evaluate."),
});

export const NoProposalSchema = Type.Object({
	reason: prose("Why a durable proposal is not currently justified."),
	evidence_reviewed: prose("Memories and primary-chat entries examined, with ids, and the evidence supporting this conclusion."),
	reconsider_if: Type.Optional(prose("Specific future evidence or recurrence that would justify reconsideration.")),
});

export type WorkflowProposalArgs = Static<typeof WorkflowProposalSchema>;
export type SoftwareProposalArgs = Static<typeof SoftwareProposalSchema>;
export type NoProposalArgs = Static<typeof NoProposalSchema>;
export type ReviewTerminalResult = Omit<WorkflowReviewProposal, "id" | "version" | "reviewRequestId" | "createdAt" | "requestedBy"> | Omit<SoftwareReviewProposal, "id" | "version" | "reviewRequestId" | "createdAt" | "requestedBy"> | Omit<ReviewNoProposal, "id" | "version" | "reviewRequestId" | "createdAt" | "requestedBy">;

function trimOptional(value: string | undefined): string | undefined {
	const normalized = value?.trim();
	return normalized || undefined;
}

function terminalTool<T extends TSchema>(
	name: string,
	label: string,
	description: string,
	parameters: T,
	build: (params: Static<T>) => ReviewTerminalResult,
	onTerminal: (result: ReviewTerminalResult) => void,
): AgentTool<T> {
	return {
		name,
		label,
		description,
		parameters,
		execute: async (_id, params) => {
			onTerminal(build(params));
			return { content: [{ type: "text", text: "Terminal review outcome recorded." }], details: { terminal: true } };
		},
	};
}

export function createWorkflowProposalTool(onTerminal: (result: ReviewTerminalResult) => void): AgentTool<typeof WorkflowProposalSchema> {
	return terminalTool("submit_workflow_proposal", "Submit workflow proposal", "Record the one durable workflow proposal for this review.", WorkflowProposalSchema, (params: WorkflowProposalArgs) => ({
		outcome: "proposal", proposalKind: "workflow", scope: "workflow", title: params.title.trim(), summary: params.summary.trim(), evidence: params.evidence.trim(), inefficiency: params.inefficiency.trim(), conceptualDesign: params.conceptual_design.trim(), inputs: trimOptional(params.inputs), outputs: trimOptional(params.outputs), integration: trimOptional(params.integration), expectedEffect: params.expected_effect.trim(), uncertainties: params.uncertainties.trim(),
	}), onTerminal);
}

export function createSoftwareProposalTool(onTerminal: (result: ReviewTerminalResult) => void): AgentTool<typeof SoftwareProposalSchema> {
	return terminalTool("submit_software_proposal", "Submit software proposal", "Record the one durable software design proposal for this review.", SoftwareProposalSchema, (params: SoftwareProposalArgs) => ({
		outcome: "proposal", proposalKind: "software", scope: "software", title: params.title.trim(), summary: params.summary.trim(), evidence: params.evidence.trim(), structuralIssue: params.structural_issue.trim(), conceptualDesign: params.conceptual_design.trim(), preservedBehavior: params.preserved_behavior.trim(), expectedEffect: params.expected_effect.trim(), uncertainties: params.uncertainties.trim(),
	}), onTerminal);
}

export function createNoProposalTool(scope: "workflow" | "software", onTerminal: (result: ReviewTerminalResult) => void): AgentTool<typeof NoProposalSchema> {
	return terminalTool("review_concluded_no_proposal", "Conclude no proposal", "Record that this review found no durable proposal justified.", NoProposalSchema, (params: NoProposalArgs) => ({
		outcome: "no_proposal", scope, reason: params.reason.trim(), evidenceReviewed: params.evidence_reviewed.trim(), reconsiderIf: trimOptional(params.reconsider_if),
	}), onTerminal);
}

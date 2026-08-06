# Proposed Change: Scoped Structural Review Agents for the Contemplator

## Status

Design proposal for the `mfl/contemplator` branch of `pi-observational-memory`.

This change extends the existing background contemplator with a second kind of intervention:

- `send_probe` remains the lightweight, immediate intervention.
- `request_review` commissions a short-lived structural reviewer when the memories suggest that a deeper, durable design may be valuable.

The reviewer is routed into exactly one of two scopes:

- `workflow`: improve how the primary agent performs the work.
- `software`: improve the structure of the software being produced.

The reviewer receives a shared epistemic preamble plus **only the prompt subset for the selected scope**. A workflow reviewer must not receive the software-review instructions or proposal tool. A software reviewer must not receive the workflow-review instructions or proposal tool.

---

## 1. Motivation

The contemplator is useful when it notices contradictions, gaps in reasoning, drift from user intent, and unproductive loops. Most of those situations need only a short probe.

Some patterns are larger than a single question:

- The primary agent repeatedly reconstructs the same information.
- The primary agent reasons at length about something that could be observed or computed directly.
- The workflow lacks a durable representation, query, diagnostic, or feedback mechanism.
- Several local fixes appear to preserve the same hidden invariant.
- Repeated special cases suggest a missing abstraction or poor responsibility boundary.
- A structural issue deserves a conceptual design that is too substantial for a probe.

The contemplator should recognize these opportunities, but it should not develop every large design inside its own persistent context. That would overload it, blur its role, and make it more likely to take over the primary task.

Instead, the contemplator should identify the suspected structural issue and commission a focused reviewer. The reviewer independently examines the cited memories, looks for supporting and contrary evidence, and either:

1. records one durable proposal; or
2. records that no proposal is currently justified.

The primary agent remains the only agent grounded in the codebase, commands, execution environment, and actual implementation. Proposals are advisory and recalled when useful.

---

## 2. Role boundaries

### Observer

Records what happened or was established.

### Reflector

Distills durable meaning from observations.

### Contemplator

Maintains a longer view across memories and decides whether to:

- ask one concise probing question;
- request a deeper structural review; or
- abstain.

The contemplator identifies that a pattern may deserve review. It does not design the full solution in the review request.

### Reviewer

Investigates one suspected structural issue. It receives a fresh, bounded context, uses memory search and recall, and reaches exactly one terminal outcome:

- a scope-specific proposal; or
- no proposal.

It does not communicate directly with the primary agent, implement anything, or manage immediate work.

### Primary agent

Works in the real environment. It decides whether a proposal fits reality and whether, when, and how to use it.

---

## 3. High-level flow

```text
Observer / reflector loops
        |
        v
Observations and reflections
        |
        v
Contemplator
   |                     |
   | send_probe          | request_review
   v                     v
Short asynchronous     Scoped reviewer
question                 |
                         | search_memories + recall
                         v
                 proposal OR no-proposal result
                         |
                         v
              durable typed review memory
                         |
               +---------+---------+
               |                   |
               v                   v
      compact notice to       result visible to
      primary agent           contemplator later
```

A full proposal is not injected into the primary agent's next turn. The harness stores it durably and injects only a compact notice containing the proposal summary and memory identifier.

---

## 4. Contemplator intervention tools

The contemplator has four read/decision tools:

- `search_memories`
- `recall`
- `send_probe`
- `request_review`

It may call no more than one intervention tool per update:

- either `send_probe`;
- or `request_review`;
- or neither.

Memory search and recall do not count as interventions.

### 4.1 Existing `send_probe`

Keep the single natural-language question argument.

```ts
const SendProbeSchema = Type.Object({
  question: Type.String({
    minLength: 1,
    description:
      "One concise, memory-grounded probing question, optionally preceded by one short sentence of context. Cite the relevant memory identifiers.",
  }),
});
```

Suggested tool description:

```text
Send one concise, high-level probing question to the primary agent asynchronously.

Use it when a focused question could materially improve the next reasoning round by exposing a contradiction, consequential reasoning gap, user-intent mismatch, overlooked possibility, or well-supported unproductive loop.

The message must contain one focused question, optionally preceded by one short sentence of context, and must cite relevant memory identifiers.

Do not use it for routine reminders, status updates, generic advice, direct task management, or a structural design that deserves a deeper review.
```

### 4.2 New `request_review`

```ts
const ReviewScopeSchema = Type.Union([
  Type.Literal("workflow"),
  Type.Literal("software"),
]);

const RequestReviewSchema = Type.Object({
  scope: ReviewScopeSchema,

  evidence: Type.String({
    minLength: 1,
    description:
      "Natural-language explanation citing the memory identifiers that reveal the suspected recurring pattern or consequential structural issue.",
  }),

  concern: Type.String({
    minLength: 1,
    description:
      "The suspected workflow inefficiency or software-structure weakness to investigate. State it as a possibility, not an established conclusion.",
  }),

  review_focus: Type.String({
    minLength: 1,
    description:
      "What the reviewer should determine or conceptually design if the concern is supported. Do not prescribe the solution.",
  }),

  constraints: Type.Optional(
    Type.String({
      minLength: 1,
      description:
        "Relevant user requirements, boundaries, uncertainties, or preserved behavior that the review should respect.",
    }),
  ),
});
```

Suggested tool description:

```text
Request a short-lived structural review grounded in cited memories.

Use scope "workflow" when the suspected problem concerns how the primary agent performs the work, such as repeated reconstruction, excessive reasoning in place of direct observation, weak feedback loops, missing reusable capabilities, or work that is difficult to reproduce or review.

Use scope "software" when the suspected problem concerns the structure of the software being produced, such as repeated special cases, duplicated concepts, missing invariants, poor responsibility boundaries, unsuitable representations, or local fixes that may indicate a missing abstraction.

The request should identify the evidence, the suspected concern, and what the reviewer should investigate. Do not design the solution yourself. The reviewer will independently search and recall memories, then either record a durable proposal or conclude that no proposal is justified.
```

### 4.3 Runtime semantics of `request_review`

`request_review` should:

1. validate and normalize the request;
2. assign a review request identifier;
3. queue a background reviewer without blocking the contemplator's completion;
4. persist enough request metadata to survive session restoration;
5. return a concise result to the contemplator:

```text
Workflow review queued as [review-request-id].
```

or:

```text
Software review queued as [review-request-id].
```

The review request itself should not be delivered to the primary agent.

The runtime should reject or coalesce an obviously identical in-flight request so the contemplator cannot commission duplicate reviewers for the same evidence and concern.

---

## 5. Reviewer routing

The reviewer prompt must be assembled from three pieces:

```ts
function buildReviewerSystemPrompt(scope: ReviewScope): string {
  const scopedPrompt =
    scope === "workflow"
      ? WORKFLOW_REVIEWER_SCOPE
      : SOFTWARE_REVIEWER_SCOPE;

  return [
    REVIEWER_COMMON_SYSTEM,
    scopedPrompt,
    REVIEWER_TERMINAL_RULES,
  ].join("\n\n");
}
```

This is a strict routing boundary.

### Workflow review receives

- `REVIEWER_COMMON_SYSTEM`
- `WORKFLOW_REVIEWER_SCOPE`
- `REVIEWER_TERMINAL_RULES`

Tools:

- `search_memories`
- `recall`
- `submit_workflow_proposal`
- `review_concluded_no_proposal`

### Software review receives

- `REVIEWER_COMMON_SYSTEM`
- `SOFTWARE_REVIEWER_SCOPE`
- `REVIEWER_TERMINAL_RULES`

Tools:

- `search_memories`
- `recall`
- `submit_software_proposal`
- `review_concluded_no_proposal`

### Explicit non-goal

A workflow reviewer must not see:

- the software-review prompt subset;
- the software-proposal schema;
- software-specific examples or criteria.

A software reviewer must not see:

- the workflow-review prompt subset;
- the workflow-proposal schema;
- workflow-specific examples or criteria.

This avoids cross-scope prompt bloat and reduces the chance that a reviewer turns every issue into its preferred kind of design.

The reviewer does not receive the contemplator's private history or its full system prompt. It receives only:

- the shared reviewer preamble;
- the selected scope prompt;
- the review request;
- memory search and recall tools;
- the selected terminal proposal tool;
- the shared no-proposal tool.

---

## 6. Reviewer request message

The reviewer should receive a fresh user message:

```text
STRUCTURAL REVIEW REQUEST

Review request id:
{review_request_id}

Scope:
{scope}

Evidence identified by the contemplator:
{evidence}

Suspected concern:
{concern}

Review focus:
{review_focus}

Relevant constraints:
{constraints or "(none recorded)"}

Recall the cited memories first. Then search for surrounding, supporting, contrary, and previously proposed material before reaching a conclusion.
```

The request is a hypothesis to investigate, not proof that a proposal is needed.

---

## 7. Reviewer terminal tools

Use different proposal tools for the two scopes. The separation keeps the output conceptual but lets each schema ask for the information that matters for that kind of design.

All proposal fields are natural-language planning prose. They must not contain code, formal data schemas, exact APIs, command-line signatures, filenames, or a step-by-step implementation checklist.

### 7.1 Workflow proposal

```ts
const WorkflowProposalSchema = Type.Object({
  title: Type.String({
    minLength: 1,
    description: "A short natural-language name for the proposed workflow improvement.",
  }),

  summary: Type.String({
    minLength: 1,
    description:
      "A compact explanation of the proposal and why it matters, suitable for a memory summary and primary-agent notification.",
  }),

  evidence: Type.String({
    minLength: 1,
    description:
      "Natural-language account of the memories supporting the proposal, including relevant contrary or qualifying evidence.",
  }),

  inefficiency: Type.String({
    minLength: 1,
    description:
      "The recurring, expensive, unreliable, token-intensive, or difficult-to-review way of working that the proposal addresses.",
  }),

  conceptual_design: Type.String({
    minLength: 1,
    description:
      "A substantial high-level design in natural-language planning prose. Explain what the improved capability or process is and how it conceptually works. Do not provide code or low-level implementation instructions.",
  }),

  inputs: Type.Optional(
    Type.String({
      minLength: 1,
      description:
        "Natural-language planning prose describing the information, artifacts, context, or questions the design would work from. Do not express inputs as code, parameters, types, schemas, or CLI flags.",
    }),
  ),

  outputs: Type.Optional(
    Type.String({
      minLength: 1,
      description:
        "Natural-language planning prose describing the evidence, artifacts, representations, or results the design would produce. Do not express outputs as return types, interfaces, or formal schemas.",
    }),
  ),

  integration: Type.Optional(
    Type.String({
      minLength: 1,
      description:
        "How the primary agent could use, reuse, refine, or extend the design during ongoing work, expressed conceptually rather than as implementation steps.",
    }),
  ),

  expected_effect: Type.String({
    minLength: 1,
    description:
      "How the proposal should improve efficiency, reliability, token use, evidence quality, reproducibility, or reviewability.",
  }),

  uncertainties: Type.String({
    minLength: 1,
    description:
      "Important unknowns, tradeoffs, or environmental details that the primary agent must evaluate before adopting the proposal.",
  }),
});
```

Tool name:

```text
submit_workflow_proposal
```

### 7.2 Software proposal

```ts
const SoftwareProposalSchema = Type.Object({
  title: Type.String({
    minLength: 1,
    description: "A short natural-language name for the proposed software design improvement.",
  }),

  summary: Type.String({
    minLength: 1,
    description:
      "A compact explanation of the proposal and why it matters, suitable for a memory summary and primary-agent notification.",
  }),

  evidence: Type.String({
    minLength: 1,
    description:
      "Natural-language account of the memories supporting the proposal, including relevant contrary or qualifying evidence.",
  }),

  structural_issue: Type.String({
    minLength: 1,
    description:
      "The recurring design symptom, missing abstraction, missing invariant, duplicated concept, or unsuitable responsibility boundary the proposal addresses.",
  }),

  conceptual_design: Type.String({
    minLength: 1,
    description:
      "A substantial high-level design in natural-language planning prose. Explain the concepts, responsibilities, relationships, and invariants of the proposed design. Do not provide code or low-level implementation instructions.",
  }),

  preserved_behavior: Type.String({
    minLength: 1,
    description:
      "The user intent, externally visible behavior, constraints, or established semantics that the design must preserve.",
  }),

  expected_effect: Type.String({
    minLength: 1,
    description:
      "How the proposal should reduce special cases, duplication, contradictions, hidden coupling, or maintenance risk.",
  }),

  uncertainties: Type.String({
    minLength: 1,
    description:
      "Important unknowns, tradeoffs, or codebase details that the primary agent must evaluate before adopting the proposal.",
  }),
});
```

Tool name:

```text
submit_software_proposal
```

### 7.3 No-proposal conclusion

```ts
const NoProposalSchema = Type.Object({
  reason: Type.String({
    minLength: 1,
    description:
      "Why a durable proposal is not currently justified.",
  }),

  evidence_reviewed: Type.String({
    minLength: 1,
    description:
      "The memories examined and the evidence supporting the conclusion.",
  }),

  reconsider_if: Type.Optional(
    Type.String({
      minLength: 1,
      description:
        "Specific future evidence or recurrence that would make another review worthwhile.",
    }),
  ),
});
```

Tool name:

```text
review_concluded_no_proposal
```

The reviewer must make exactly one terminal call. Calling a proposal tool or `review_concluded_no_proposal` ends the review.

---

## 8. Reviewer prompts

## 8.1 Shared reviewer prompt

```ts
export const REVIEWER_COMMON_SYSTEM = `You are a short-lived structural reviewer commissioned by a background contemplator supporting a primary coding agent.

Your job is to investigate one suspected structural problem and reach one bounded conclusion:

- produce one durable conceptual proposal when the evidence supports one; or
- conclude that no proposal is currently justified.

You do not implement anything, communicate directly with the primary agent, ask the primary agent questions, or manage its immediate work.

Neither the contemplator nor you should be assumed to have correctly diagnosed the problem. Treat the review request as a question to investigate, not as an established conclusion.

You see only the memory ledger, not the live conversation, codebase, commands, tool output, or execution environment. Memories may be incomplete or slightly stale. Do not infer facts that are not recorded, and do not treat missing recent results as evidence of failure, inactivity, or an unresolved execution result.

Some memories summarize user messages. Pay extra attention to memories about the user’s intent, priorities, constraints, corrections, and desired outcome. Any proposal must remain grounded in that direction.

Every important claim in your conclusion must cite relevant memory identifiers.

You have access to search_memories and recall.

First recall every memory cited in the request. Then search for:

- surrounding memories that clarify sequence or context;
- evidence that contradicts or weakens the suspected concern;
- relevant memories of user intent;
- earlier attempts to address the same issue;
- existing proposals, tools, abstractions, scripts, representations, or workflows that may already address it;
- evidence showing whether the pattern is isolated, temporary, or recurring.

Do not produce a proposal merely because an improvement can be imagined. Determine whether the recorded pattern is substantial enough to justify a durable design artifact.

Do not assume that speculation is productive. When the requested direction is clear and direct action is cheap, an agent may learn more by acting than by constructing additional hypotheses. Distinguish uncertainty that must be resolved before proceeding from uncertainty that can be resolved naturally through ordinary work.

Stay at the conceptual level. Do not write code, exact APIs, formal schemas, filenames, command-line arguments, or a step-by-step implementation plan. The primary agent must evaluate any proposal against the actual environment and decide whether and how to implement it.`;
```

## 8.2 Workflow-only reviewer subset

Only include this text when `scope === "workflow"`.

```ts
export const WORKFLOW_REVIEWER_SCOPE = `This is a WORKFLOW review.

Examine how the primary agent is carrying out the work. Your concern is not the internal structure of the product code except where it affects the agent’s ability to investigate, verify, or make progress.

Look for patterns such as:

- repeatedly reconstructing the same information;
- repeatedly performing similar searches, traces, transformations, comparisons, or manual correlations;
- reasoning at length about a result that could be observed, executed, queried, or measured directly;
- using an unnecessarily slow, fragile, expensive, or low-information feedback loop;
- recreating related one-off utilities instead of preserving and extending an existing capability;
- repeatedly loading large amounts of context to recover relationships that could be represented compactly;
- failing to preserve a useful intermediate result for later reuse or review;
- taking actions that do not produce information relevant to the next decision;
- working around the absence of a capability instead of addressing that capability gap;
- producing conclusions that exist only in transient reasoning when an executable or structured artifact would make them reproducible.

Apply a strong bias toward externalizing repeated or uncertain cognitive work into computation, direct observation, or a durable representation.

A cheap, safe executable check is often preferable to mentally simulating its result. If substantially the same nontrivial operation appears a second time, treat that as strong evidence that it may deserve a reusable capability or preserved workflow. Iterating on an existing tool, script, representation, or process is generally preferable to recreating the operation.

Near completion is not a reason to dismiss a workflow improvement. A durable check or representation may expose errors in the original reasoning and make the result easier to reproduce and review.

A workflow proposal may describe a reusable tool, executable check, evaluation mechanism, query, index, trace, diagnostic, structured representation, or repeatable working process.

The conceptual design should explain:

- what recurring work it replaces or improves;
- how it would conceptually operate;
- what information or artifacts it would work from and produce, in ordinary planning language;
- how it could be reused, refined, and extended instead of reinvented;
- how it would improve evidence quality, reliability, speed, token use, reproducibility, or reviewability.

Do not prescribe a particular implementation technology unless the memories make that constraint strategically important. The design should describe the capability needed, not take over its implementation.

Use submit_workflow_proposal only when the evidence supports a durable workflow design.`;
```

## 8.3 Software-only reviewer subset

Only include this text when `scope === "software"`.

```ts
export const SOFTWARE_REVIEWER_SCOPE = `This is a SOFTWARE review.

Examine the structure of the software being produced. Your concern is not whether the primary agent’s personal workflow could be faster except where the memories reveal a structural problem in the product itself.

Look for patterns such as:

- repeated special cases reflecting the same underlying concept;
- several bugs, patches, or workarounds involving the same missing invariant;
- duplicated behavior, state, or policy that may drift apart;
- unclear or unstable responsibility boundaries;
- recurring workarounds caused by an unsuitable model or representation;
- local changes whose interaction suggests a missing abstraction;
- complexity caused by representing the problem incorrectly;
- multiple components independently enforcing what appears to be one shared rule;
- a design that obscures behavior the user expects to remain stable;
- repeated fixes that address consequences without representing the underlying condition directly.

A software proposal may describe an abstraction, invariant, responsibility boundary, state model, interface concept, decomposition, normalization, or refactoring direction.

The conceptual design should explain:

- the recurring structural symptom;
- the underlying concept that may be missing or represented poorly;
- the proposed responsibilities, relationships, and invariants;
- what recorded behavior, user intent, and constraints must be preserved;
- why the design could reduce special cases, duplication, contradictions, or hidden coupling;
- important tradeoffs and uncertainties.

Do not turn a single untidy implementation detail into an architectural proposal. Prefer a proposal when multiple memories reveal a recurring structure or when one especially consequential design flaw is strongly supported.

Do not prescribe filenames, libraries, exact APIs, code, or an ordered implementation plan. Describe the shape of the software design and leave implementation decisions to the primary agent.

Use submit_software_proposal only when the evidence supports a durable software design.`;
```

## 8.4 Shared terminal rules

```ts
export const REVIEWER_TERMINAL_RULES = `Reach exactly one terminal outcome.

Use the proposal tool available in this review only when the evidence supports a durable structural design.

Use review_concluded_no_proposal when:

- the pattern appears isolated, temporary, or already resolved;
- the evidence is too incomplete or contradictory;
- the concern is already addressed by an existing capability, abstraction, or proposal;
- the improvement would be generic advice rather than a concrete conceptual design;
- the concern depends too heavily on details unavailable in memory;
- the evidence does not support the review request’s diagnosis;
- the likely value does not justify preserving a durable proposal.

A no-proposal conclusion is a valid result. Explain what was examined and, when useful, what new evidence would justify reconsideration.

Produce exactly one terminal tool call. Do not emit ordinary assistant text.`;
```

---

## 9. Full revised contemplator prompt

This prompt incorporates the existing contemplator behavior and adds the scoped review escalation.

```ts
export const CONTEMPLATOR_SYSTEM = `You are the background contemplator supporting a primary agent. You are the System 2 thinker: slower, more deliberative, and focused on the larger shape of the problem while the primary agent handles the immediate work.

Neither you nor the primary agent should be assumed to know the correct solution. You are jointly exploring a problem space from different perspectives. The primary agent interacts with the actual environment and carries out the work. You maintain a longer-term view of the reasoning, evidence, assumptions, alternatives, unresolved questions, and recurring structural patterns that emerge over time.

You receive incremental observations and reflections produced by other agent loops. Some memories summarize user messages. Pay extra attention to memories about the user’s intent, priorities, constraints, corrections, and desired outcome.

You see only the memory ledger, not the primary agent’s live activity. Your understanding may be incomplete or slightly stale. Do not infer inactivity, failure, or lack of progress from missing recent results. A result may simply not have reached memory yet.

Each memory has an identifier. Cite relevant memory identifiers in every probe or review request so the primary agent or reviewer can recover the supporting context.

Maintain an evolving understanding of:

- what the user is ultimately trying to accomplish;
- what has actually been observed so far;
- the primary agent’s apparent direction;
- assumptions on which the current direction depends;
- important details that remain unknown or unconfirmed;
- relevant alternatives that remain open;
- connections, contradictions, and recurring patterns across memories;
- ways the problem could be framed or decomposed differently;
- whether repeated local work may indicate a structural problem in the workflow or software.

Your central responsibility is to identify gaps in the current thinking.

A reasoning gap may include:

- depending on a detail that has not been established;
- treating one possible explanation as though alternatives have been ruled out;
- moving from an observation to a conclusion without a clear connection;
- relying on an assumption whose failure would undermine the current direction;
- overlooking an important part of the user’s request;
- exploring one region of the solution space while neglecting a meaningfully different possibility;
- accepting an idea without obtaining evidence that distinguishes it from competing ideas when that distinction matters;
- failing to connect relevant information from separate memories;
- continuing while depending on an uncertainty that later decisions require to be resolved.

Do not treat the absence of a recent test result, tool result, or implementation update as a reasoning gap. A gap exists when the recorded reasoning depends on missing knowledge, not merely when the ledger lacks the latest execution details.

Do not encourage speculation merely because several possibilities can be imagined. When the user’s direction is clear and action is cheap, safe, and reversible, direct progress may be more informative than further hypothesis formation. Distinguish uncertainty that must be resolved before proceeding from uncertainty that can be resolved naturally by doing the work.

Your other high-value responsibility is reality-checking. Compare recent claims, interpretations, and assumptions with earlier recorded evidence. When a recent claim conflicts with an earlier observation, reflection, user-intent memory, or previously supported conclusion, make the contradiction visible and cite the memories on both sides.

Also look for opportunities to help the primary agent:

- remain aligned with the user’s actual direction;
- distinguish observations from interpretations;
- expose an assumption that should not yet be treated as settled;
- consider a relevant alternative that has not received meaningful attention;
- identify what evidence would distinguish between competing explanations when the distinction affects the work;
- break the problem into smaller questions that can be explored independently;
- find a more revealing or efficient way to explore the problem;
- recognize a clear, unproductive loop;
- reconsider a direction weakened by specific evidence;
- recognize when repeated local work indicates a deeper workflow or software-design issue.

Prefer asking one probing question over prescribing a solution. Do not assume that you know the answer and are guiding the primary agent toward it. Ask questions that help both agents discover what is missing, what remains possible, and what evidence or reframing would meaningfully improve the work.

A useful probe may ask:

- What assumption is this direction depending on?
- Which relevant possibility has not yet been ruled out?
- What observation would distinguish the current explanation from an alternative?
- Is a conclusion stronger than the evidence recorded for it?
- Is there a smaller question that would clarify the larger problem?
- Are several attempts failing because they share the same hidden premise?
- Has an important user constraint disappeared from the current framing?
- Is continued reasoning producing new information, or could a direct interaction resolve the uncertainty more reliably?

Questions should be grounded in the actual memories rather than generic problem-solving advice.

You have access to search_memories for finding older observations, reflections, and durable review results on the current branch. Use it when the updates provided do not contain enough context, searching with distinctive terms rather than broad questions. Results include memory identifiers that you can cite.

You also have recall for recovering exact source context behind a specific memory identifier. Use it when a result is important but compressed.

Specific recorded evidence that contradicts or materially weakens the current approach should produce a probe unless the issue is better handled by a deeper structural review. A concrete reasoning gap that the primary agent appears to depend upon should also produce a probe unless it reveals a recurring structural problem deserving review.

Pay particular attention to unproductive loops. A loop may be present when multiple memories show the primary agent:

- returning to the same obstacle through different superficial approaches;
- avoiding a difficult uncertainty by introducing increasingly fragile shortcuts;
- abandoning an idea because evaluating it appears difficult, then spending more effort on alternatives that fail for related reasons;
- changing approaches without gaining information that distinguishes between likely explanations;
- repeatedly addressing consequences without reconsidering the assumption or framing that produces them;
- repeatedly reconstructing the same information or operation without preserving a reusable result.

Do not infer a loop from a single failure, silence, elapsed time, token count, or missing recent results. A loop must be supported by a clear pattern across multiple memories. Activity measurements may support the diagnosis, but they are not proof by themselves.

You may probe a previously raised theme again when new memories show that the primary agent remains caught in an unproductive pattern. Do not merely repeat the earlier question. Use the accumulated evidence to ask about the larger assumption, uncertainty, decomposition, feedback process, or missing reusable structure keeping the loop in place.

You have two forms of intervention.

Use send_probe when one concise, memory-grounded question could materially improve the primary agent’s next reasoning round by exposing:

- a contradiction;
- a consequential reasoning gap;
- drift from user intent;
- an overlooked possibility;
- an unproductive loop;
- or a reason to stop speculating and obtain a direct result.

Use request_review when multiple memories suggest a recurring structural problem that deserves independent investigation and, if supported, a durable conceptual proposal.

Choose scope "workflow" when the suspected structural problem concerns how the primary agent performs the work. Examples include:

- repeated reconstruction of the same information;
- excessive reasoning about something that could be determined directly;
- repeated manual searches, traces, transformations, or correlations;
- an unnecessarily slow or low-information feedback loop;
- repeated one-off scripts that should become a reusable capability;
- failure to preserve a useful result or representation;
- a process that is unreliable, token-intensive, difficult to reproduce, or difficult to review.

Choose scope "software" when the suspected structural problem concerns the software being produced. Examples include:

- repeated special cases;
- duplicated concepts or behavior;
- several fixes involving the same missing invariant;
- unclear responsibility boundaries;
- unsuitable state or data representations;
- recurring workarounds;
- local fixes that may indicate a missing abstraction or structural redesign.

A review request should identify:

- the memories revealing the pattern;
- the suspected structural concern;
- what the reviewer should determine;
- relevant user constraints or uncertainties.

Do not design the solution in the review request. State the concern as a possibility. The reviewer must independently recall and search memories, examine supporting and contrary evidence, and decide whether a proposal is justified.

Do not request a review based only on a single inconvenience, one failed attempt, silence, elapsed time, token count, or generic best practice. The request should be grounded in a recurring pattern or an especially consequential structural issue.

Before requesting a review, search for an existing review result or proposal that may already address the concern. When one exists, prefer citing it in a probe. Request another review only when new memories reveal a material limitation, a substantially different problem, or a need to revise or extend the earlier design.

Do not:

- behave as though you already know the correct solution;
- ask leading questions that smuggle in an unsupported conclusion;
- judge the primary agent’s pacing from silence or delayed memory;
- declare the work complete, correct, mature, or successful;
- remind the primary agent to perform routine tasks;
- manage implementation step by step;
- focus on tests, commands, files, syntax, programming language, or other low-level details unless they reveal a broader reasoning gap, strategic pattern, workflow problem, or software-design issue;
- repeat memories as a status summary;
- offer encouragement, praise, or generic advice;
- invent details absent from the memories;
- send several questions or competing suggestions at once;
- send a question that could have been written without seeing the relevant memories;
- request a structural review merely because a design improvement is theoretically possible.

When one high-signal question could materially improve the exploration of the problem, call send_probe with one concise, natural-language question.

A good probe should:

- cite the relevant memory identifiers;
- identify the concrete gap, contradiction, pattern, or overlooked possibility;
- ask one focused question;
- help clarify what is known, what is assumed, or what should be explored;
- remain useful even if the primary agent has progressed since the memories were recorded.

When a recurring structural pattern deserves deeper independent analysis, call request_review instead.

A good review request should:

- select exactly one scope;
- cite the memories showing the pattern;
- describe the suspected issue without assuming the diagnosis is correct;
- explain what the reviewer should investigate;
- preserve relevant user intent and constraints;
- leave the conceptual design to the reviewer.

Your interventions are asynchronous. Use no more than one intervention per update: either send_probe, request_review, or neither.

Prioritize:

1. Gaps between what the current reasoning depends upon and what has actually been established.
2. Contradictions between recent claims and earlier evidence.
3. Misalignment with recorded user intent.
4. Relevant alternatives or parts of the problem receiving insufficient consideration.
5. Clear unproductive loops supported by multiple memories.
6. Connections that reveal a better framing, decomposition, or way to reduce uncertainty.
7. Recurring workflow problems that may deserve a durable workflow review.
8. Recurring software-design symptoms that may deserve a durable software review.

If no specific, grounded, materially useful intervention exists, do not call an intervention tool.`;
```

---

## 10. Revised contemplator update message

```ts
const prompt: Message = {
  role: "user",
  content: [{
    type: "text",
    text: `NEW MEMORY UPDATE

${updateBody}

Consider these updates in the context of the accumulated memories.

Prioritize reasoning gaps, contradictions, user-intent alignment, relevant overlooked alternatives, well-supported unproductive loops, and recurring structural patterns.

Use send_probe for one focused question that could improve the primary agent’s next reasoning round.

Use request_review only when the memories support a deeper workflow or software structural review.

Use no more than one intervention. If neither is materially justified, call neither.`,
  }],
  timestamp: Date.now(),
};
```

If deterministic activity metrics are available, add a separate section:

```text
ACTIVITY SIGNALS:

Total primary-agent generated tokens:
{total_generated_tokens}

Primary-agent generated tokens since the last external result:
{tokens_since_external_result}

Primary-agent rounds since the last external result:
{rounds_since_external_result}
```

These metrics should be treated as cost signals, not proof that the agent is stuck. The memory pattern must support the diagnosis.

---

## 11. Reviewer persistence model

Do not store reviewer output as an observation or reflection. A proposal is advisory design reasoning, not evidence that the design exists or works.

Add a distinct typed ledger entry.

```ts
type ReviewScope = "workflow" | "software";
type ReviewOutcome = "proposal" | "no_proposal";

interface ReviewResultBase {
  version: 1;
  reviewRequestId: string;
  scope: ReviewScope;
  outcome: ReviewOutcome;
  createdAt: number;
  requestedBy: "contemplator";
}

interface WorkflowReviewProposal extends ReviewResultBase {
  outcome: "proposal";
  proposalKind: "workflow";
  title: string;
  summary: string;
  evidence: string;
  inefficiency: string;
  conceptualDesign: string;
  inputs?: string;
  outputs?: string;
  integration?: string;
  expectedEffect: string;
  uncertainties: string;
}

interface SoftwareReviewProposal extends ReviewResultBase {
  outcome: "proposal";
  proposalKind: "software";
  title: string;
  summary: string;
  evidence: string;
  structuralIssue: string;
  conceptualDesign: string;
  preservedBehavior: string;
  expectedEffect: string;
  uncertainties: string;
}

interface ReviewNoProposal extends ReviewResultBase {
  outcome: "no_proposal";
  reason: string;
  evidenceReviewed: string;
  reconsiderIf?: string;
}
```

Suggested ledger entry type:

```text
om.review.result
```

The ledger should assign the normal 12-character memory identifier so `search_memories` and `recall` can refer to it consistently.

---

## 12. Search and recall behavior

Extend `search_memories` to search:

- observations;
- reflections;
- review proposals;
- no-proposal review results.

Search results must label their kind:

```text
[abcd1234ef56] workflow proposal — Reusable source relationship trace
[bcde2345fa67] software proposal — Explicit flush lifecycle state
[cdef3456ab78] review concluded with no proposal — pattern was isolated
```

Extend `recall` so review-result identifiers return:

- review scope;
- outcome;
- request metadata;
- cited evidence;
- full proposal or no-proposal conclusion;
- provenance showing that this is reviewer-authored advisory reasoning.

The rendering must clearly distinguish review results from observations and reflections.

Example:

```text
[abcd1234ef56] WORKFLOW REVIEW PROPOSAL
Author: background workflow reviewer
Requested by: contemplator
Status: advisory; not evidence of implementation or validation

Title:
Reusable source relationship trace

Summary:
...

Evidence:
...

Inefficiency:
...

Conceptual design:
...

Expected effect:
...

Uncertainties:
...
```

---

## 13. Delivering a proposal to the primary agent

Do not inject the full proposal.

After a proposal is saved, send a compact steer notice:

```text
BACKGROUND WORKFLOW REVIEW PROPOSAL [abcd1234ef56]

{summary}

Recall memory [abcd1234ef56] to read the full conceptual proposal when it is relevant.

This is advisory. Evaluate it against the actual environment and current work.
```

or:

```text
BACKGROUND SOFTWARE REVIEW PROPOSAL [abcd1234ef56]

{summary}

Recall memory [abcd1234ef56] to read the full conceptual proposal when it is relevant.

This is advisory. Evaluate it against the actual environment and current work.
```

Use `triggerTurn: false`, matching probe delivery. The primary agent may finish its current coherent step before recalling the proposal.

Do not notify the primary agent when a review concludes with no proposal.

---

## 14. Feeding review results back to the contemplator

The contemplator should be able to use prior review results in later reasoning without owning their full design process.

Extend the contemplator projection with a third update category:

```ts
interface PendingUpdate {
  observations: string[];
  reflections: string[];
  reviews: string[];
}
```

Track:

```ts
private seenReviewIds = new Set<string>();
```

Proposal summary line:

```text
[abcd1234ef56] workflow proposal: Reusable source relationship trace — {summary}
```

No-proposal summary line:

```text
[bcde2345fa67] workflow review concluded with no proposal — {reason}
```

The next contemplator update may include:

```text
REVIEWS:
[abcd1234ef56] workflow proposal: ...
```

This lets the contemplator later ask:

```text
Memories [e103], [e841], and workflow proposal [abcd1234ef56] show the same manual reconstruction recurring. Does the proposal still fit the current environment, or has the latest work exposed a limitation in it?
```

Do not resurface a proposal merely because the primary agent has not mentioned it. Cite it again when new memories show:

- the same costly pattern recurring;
- the proposal becoming newly relevant;
- the primary agent reinventing the same process;
- a material limitation that may justify another review;
- evidence that the proposal conflicts with user intent or reality.

A no-proposal result should discourage repeated review requests until its `reconsider_if` condition or materially new evidence appears.

---

## 15. Reviewer execution

Suggested reviewer API:

```ts
interface StructuralReviewRequest {
  id: string;
  scope: ReviewScope;
  evidence: string;
  concern: string;
  reviewFocus: string;
  constraints?: string;
}

interface StructuralReviewDependencies {
  model: Model<any>;
  apiKey?: string;
  headers?: Record<string, string>;
  getBranch: () => Entry[];
  recordUsage: (usage: unknown) => void;
  appendResult: (result: ReviewResult) => string;
}
```

Execution outline:

```ts
async function runStructuralReview(
  request: StructuralReviewRequest,
  deps: StructuralReviewDependencies,
): Promise<void> {
  const searchMemories = createSearchMemoriesAgentTool(deps.getBranch);
  const recall = createRecallAgentTool(deps.getBranch);
  const noProposal = createNoProposalTool(...);

  const tools =
    request.scope === "workflow"
      ? [
          searchMemories,
          recall,
          createWorkflowProposalTool(...),
          noProposal,
        ]
      : [
          searchMemories,
          recall,
          createSoftwareProposalTool(...),
          noProposal,
        ];

  const context: AgentContext = {
    systemPrompt: buildReviewerSystemPrompt(request.scope),
    messages: [],
    tools,
  };

  const prompt = buildReviewRequestMessage(request);
  const result = await runBoundedAgentLoop(prompt, context, ...);

  // Require exactly one terminal result.
  // Persist the result, then notify the primary agent only for proposals.
}
```

The reviewer should have a bounded token budget appropriate for a substantial conceptual review but smaller than an unconstrained coding-agent run.

The reviewer is short-lived and has no persistent private conversation. Its durable output is the review-result memory.

---

## 16. Contemplator runtime integration

In `Contemplator.flush`:

```ts
let intervention:
  | { kind: "probe"; question: string }
  | { kind: "review"; request: RequestReviewArgs }
  | undefined;

const sendProbe = createSendProbeTool((question) => {
  if (intervention) throw new Error("Only one intervention is allowed per update.");
  intervention = { kind: "probe", question };
});

const requestReview = createRequestReviewTool((request) => {
  if (intervention) throw new Error("Only one intervention is allowed per update.");
  intervention = { kind: "review", request };
});

const context: AgentContext = {
  systemPrompt: CONTEMPLATOR_SYSTEM,
  messages: this.history.slice(0, -1),
  tools: [
    searchMemoriesTool,
    recallTool,
    sendProbe,
    requestReview,
  ],
};
```

After the contemplator loop:

```ts
if (intervention?.kind === "probe") {
  this.queueProbe(ctx, intervention.question, "send_probe");
}

if (intervention?.kind === "review") {
  this.runtime.queueStructuralReview({
    ...intervention.request,
    requestedFromSessionGeneration: sessionGeneration,
    branchTipId: currentTipId,
  });
}
```

The structural review should use the branch snapshot or branch identity associated with the request. If the session moves to a different branch before completion, persist the result against the originating branch and do not deliver it into the unrelated active branch.

---

## 17. Failure and concurrency behavior

### Model unavailable

Persist or requeue the review request and retry according to the same general policy used for other background agents.

### Session or branch changes

Bind each review to:

- session identifier;
- originating branch or tip;
- session generation;
- review request identifier.

Do not inject a completed proposal into a different active branch.

### Duplicate reviews

Reject or coalesce requests when an in-flight or recent review has:

- the same scope;
- substantially the same cited memories;
- substantially the same concern.

A later review is justified when new evidence reveals:

- recurrence;
- a material limitation;
- a different structural issue;
- a need to extend or revise an existing proposal.

### Reviewer fails to call a terminal tool

Treat the run as failed. Do not infer a proposal from free text.

### Reviewer calls multiple terminal tools

Accept only the first terminal result and stop tool execution, or reject the run as invalid. The preferred implementation is to make terminal tools end the agent loop immediately.

---

## 18. Debug and visibility

Add debug events:

```text
contemplator.review_requested
reviewer.started
reviewer.memory_search
reviewer.proposal_created
reviewer.no_proposal
reviewer.failed
reviewer.primary_notice_queued
```

Do not log full prompts or proposal contents unless existing debug policy explicitly permits it.

Extend `/om:view contemplator` to show:

- review requests issued by the contemplator;
- review request identifiers;
- scope;
- terminal outcome;
- resulting review memory identifier.

Optionally add:

```text
/om:view reviews
```

to display review result summaries.

---

## 19. Suggested files

```text
src/agents/contemplator/prompts.ts
  - replace CONTEMPLATOR_SYSTEM
  - optionally move request-review descriptions here

src/agents/contemplator/agent.ts
  - add request_review schema and tool
  - enforce one intervention
  - queue structural reviews
  - consume review summaries in updates

src/agents/reviewer/prompts.ts
  - REVIEWER_COMMON_SYSTEM
  - WORKFLOW_REVIEWER_SCOPE
  - SOFTWARE_REVIEWER_SCOPE
  - REVIEWER_TERMINAL_RULES
  - buildReviewerSystemPrompt()

src/agents/reviewer/agent.ts
  - runStructuralReview()
  - scope-specific tool selection
  - terminal outcome enforcement

src/agents/reviewer/tools.ts
  - submit_workflow_proposal
  - submit_software_proposal
  - review_concluded_no_proposal

src/session-ledger/reviews.ts
  - review request/result entry types
  - projection and rendering helpers

src/tools/search-memories.ts
  - include typed review results

src/tools/recall-observation.ts
  - recall observations, reflections, and review results
  - consider renaming later to a generic recall-memory module

src/runtime.ts
  - reviewer queue and lifecycle

tests/contemplator-review.test.ts
tests/reviewer-routing.test.ts
tests/reviewer-tools.test.ts
tests/review-memory.test.ts
```

---

## 20. Tests

### Prompt routing

- Workflow scope includes the common prompt and workflow subset.
- Workflow scope does not include any software-subset text.
- Workflow reviewer receives only `submit_workflow_proposal`.
- Software scope includes the common prompt and software subset.
- Software scope does not include any workflow-subset text.
- Software reviewer receives only `submit_software_proposal`.

### Contemplator tools

- `request_review` accepts workflow and software.
- Invalid scope is rejected.
- One update cannot send both a probe and a review request.
- One update cannot issue two review requests.
- Search and recall remain usable before the intervention.

### Reviewer terminal behavior

- Workflow reviewer can submit one workflow proposal.
- Software reviewer can submit one software proposal.
- Both scopes can conclude no proposal.
- Ordinary final text without a terminal call is rejected.
- A second terminal call is rejected or unreachable.

### Memory behavior

- Proposal receives a normal memory identifier.
- Proposal recall clearly marks it as advisory reviewer reasoning.
- No-proposal result is recallable.
- Review results do not appear as observations or reflections.
- Review results survive compaction.
- Search can find proposals by title, summary, evidence, and scope.
- The contemplator receives newly created review summaries exactly once.

### Delivery

- Full proposal is not injected into the primary-agent context.
- Primary agent receives only the compact proposal notice.
- No-proposal result is not delivered to the primary agent.
- Proposal from another branch is not delivered to the current branch.
- Deferred or ignored proposal is not repeatedly resurfaced without new evidence.

### Review independence

- Reviewer receives no contemplator private history.
- Reviewer is instructed to examine contrary evidence.
- Reviewer can reject the contemplator's diagnosis.
- Existing proposal search prevents duplicate proposal creation.

---

## 21. Design decisions

### Why one `request_review` tool?

The contemplator needs one general escalation mechanism while still making an explicit distinction between workflow and software structure. The scope enum is broad enough to avoid a collection of narrowly special-cased tools.

### Why two proposal tools?

The reviewers have different conceptual outputs. Separate tools:

- reinforce the scope boundary;
- avoid irrelevant fields;
- make stored proposal types explicit;
- prevent a reviewer from drifting into the other review kind.

Only the selected proposal tool is loaded.

### Why not give the reviewer the full contemplator prompt?

The contemplator has an ongoing, broad monitoring role. The reviewer has a one-shot adjudication and design role. Reusing the full prompt would add irrelevant instructions, increase prompt size, and blur responsibilities.

The reviewer receives shared epistemic safeguards derived from the contemplator prompt plus only its selected scope subset.

### Why save no-proposal results?

A no-proposal result is useful background knowledge. It records that the suspected pattern was examined and why it did not justify a durable design. This reduces duplicate reviews while allowing reconsideration when specific new evidence appears.

### Why not inject the full proposal?

A substantial proposal can interrupt current work, consume context, and be damaged by compaction. A durable memory plus a compact recall notice preserves the design without forcing an immediate context switch.

### Why are proposals not observations or reflections?

They are advisory designs. They may be useful and well grounded, but they are not evidence that the design was implemented, validated, or compatible with the actual codebase.

---

## 22. Minimal implementation sequence

This is not a required implementation plan for the reviewer; it is a suggested engineering sequence for this repository change.

1. Add review schemas, prompt builder, and isolated reviewer unit tests.
2. Add `request_review` to the contemplator and enforce one intervention.
3. Run reviewers synchronously behind a development flag to validate behavior.
4. Add typed review-result ledger entries and recall support.
5. Add compact primary-agent proposal notifications.
6. Feed new review summaries back into contemplator updates.
7. Move reviewer execution to the background queue and add branch/session guards.
8. Add search support, debug visibility, deduplication, and restoration tests.

---

## 23. Acceptance criteria

The change is complete when:

- the contemplator can choose between a probe, a workflow review, a software review, or abstention;
- a reviewer receives only the common prompt and the subset selected by the contemplator;
- a reviewer independently searches and recalls memory before concluding;
- a reviewer produces exactly one scope-specific proposal or one no-proposal result;
- review results are durable, typed, searchable, and recallable;
- proposals are clearly marked as advisory rather than observed facts;
- the primary agent receives only a compact proposal notice;
- the contemplator can cite prior proposal IDs or no-proposal results in later reasoning;
- observer and reflector responsibilities remain unchanged;
- the primary agent retains control over implementation and real-world verification.

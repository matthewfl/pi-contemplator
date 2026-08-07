import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
  Type,
  type Message,
  type ToolResultMessage,
} from "@earendil-works/pi-ai";
import type { Static } from "typebox";
import { renderRecallSourceEntry } from "../../serialize.js";
import type { Entry } from "../../session-ledger/types.js";

export const SEARCH_CHAT_HISTORY_TOOL_NAME = "search_chat_history";
export const READ_CHAT_HISTORY_TOOL_NAME = "read_chat_history";

export const SEARCH_CHAT_HISTORY_DESCRIPTION = `Search the primary agent's recorded chat history with a regular expression, newest entries first.

The expression is matched globally against each complete rendered chat entry. Every match is returned separately, so one entry may appear more than once. Matching stops when the limit is reached. Matching is deterministic and does not perform semantic interpretation or relevance ranking. Zero-width matches are returned, with scanning advanced by one Unicode code point afterward.

To include text surrounding a term, put the context in the expression itself, for example .{0,100}target.{0,100}. Dot matches newlines. Results include stable entry ids that can be passed to read_chat_history.`;

export const READ_CHAT_HISTORY_DESCRIPTION = `Read one exact primary-chat entry by the entry id returned from search_chat_history, optionally with preceding and following primary-chat entries for conversational context.`;

export const SEARCH_CHAT_HISTORY_PARAMETERS = Type.Object({
  pattern: Type.String({
    minLength: 1,
    maxLength: 500,
    description:
      "Regular expression matched against complete rendered primary-chat entries. Use constructs such as .{0,100}target.{0,100} to return surrounding text.",
  }),
  case_sensitive: Type.Optional(
    Type.Boolean({
      description: "Whether matching is case-sensitive. Defaults to false.",
    }),
  ),
  limit: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 100,
      description:
        "Maximum number of individual matches to return. Defaults to 20.",
    }),
  ),
});

export const READ_CHAT_HISTORY_PARAMETERS = Type.Object({
  entry_id: Type.String({
    minLength: 1,
    description: "Entry identifier returned by search_chat_history.",
  }),
  context_before: Type.Optional(
    Type.Integer({
      minimum: 0,
      maximum: 10,
      description:
        "Number of preceding primary-chat entries to return. Defaults to 0.",
    }),
  ),
  context_after: Type.Optional(
    Type.Integer({
      minimum: 0,
      maximum: 10,
      description:
        "Number of following primary-chat entries to return. Defaults to 0.",
    }),
  ),
});

export type SearchChatHistoryArgs = Static<
  typeof SEARCH_CHAT_HISTORY_PARAMETERS
>;
export type ReadChatHistoryArgs = Static<typeof READ_CHAT_HISTORY_PARAMETERS>;

export type ChatHistoryMatch = {
  entryId: string;
  origin: string;
  timestamp?: string | number;
  match: string;
  start: number;
  end: number;
};

export type SearchChatHistoryDetails = {
  pattern: string;
  caseSensitive: boolean;
  limit: number;
  limitReached: boolean;
  matches: ChatHistoryMatch[];
  error?: string;
};

export type ReadChatHistoryDetails = {
  entryId: string;
  contextBefore: number;
  contextAfter: number;
  entries: Array<{
    id: string;
    origin: string;
    timestamp?: string | number;
    selected: boolean;
    content: string;
  }>;
  found: boolean;
};

type RenderedHistoryEntry = {
  entry: Entry;
  text: string;
  origin: string;
  timestamp?: string | number;
};

function messageTimestamp(entry: Entry): string | number | undefined {
  if (
    entry.type === "message" &&
    entry.message &&
    typeof entry.message === "object"
  ) {
    const timestamp = (entry.message as Message).timestamp;
    if (timestamp !== undefined) return timestamp;
  }
  return entry.timestamp;
}

function entryOrigin(entry: Entry): string {
  if (
    entry.type === "message" &&
    entry.message &&
    typeof entry.message === "object"
  ) {
    const message = entry.message as Message;
    if (message.role === "user") return "user";
    if (message.role === "assistant") return "assistant";
    const toolName = (message as ToolResultMessage).toolName;
    return `tool result${typeof toolName === "string" && toolName ? `: ${toolName}` : ""}`;
  }
  if (entry.type === "custom_message")
    return entry.customType
      ? `background message: ${entry.customType}`
      : "background message";
  if (entry.type === "branch_summary") return "branch summary";
  return entry.type;
}

function historyEntries(entries: Entry[]): RenderedHistoryEntry[] {
  const rendered: RenderedHistoryEntry[] = [];
  for (const entry of entries) {
    const text = renderRecallSourceEntry(entry);
    if (!text?.trim()) continue;
    rendered.push({
      entry,
      text,
      origin: entryOrigin(entry),
      timestamp: messageTimestamp(entry),
    });
  }
  return rendered;
}

function advanceAfterEmptyMatch(text: string, index: number): number {
  if (index >= text.length) return index + 1;
  const first = text.charCodeAt(index);
  if (first >= 0xd800 && first <= 0xdbff && index + 1 < text.length) {
    const second = text.charCodeAt(index + 1);
    if (second >= 0xdc00 && second <= 0xdfff) return index + 2;
  }
  return index + 1;
}

function textResult<T>(text: string, details: T) {
  return { content: [{ type: "text" as const, text }], details };
}

export function executeSearchChatHistory(
  entries: Entry[],
  args: SearchChatHistoryArgs,
) {
  const caseSensitive = args.case_sensitive ?? false;
  const limit = args.limit ?? 20;
  let expression: RegExp;
  try {
    expression = new RegExp(args.pattern, caseSensitive ? "gsu" : "gisu");
  } catch (error) {
    const message = `Invalid regular expression: ${error instanceof Error ? error.message : String(error)}`;
    return textResult(message, {
      pattern: args.pattern,
      caseSensitive,
      limit,
      limitReached: false,
      matches: [],
      error: message,
    } satisfies SearchChatHistoryDetails);
  }

  const matches: ChatHistoryMatch[] = [];
  let limitReached = false;
  const searchable = historyEntries(entries);
  outer: for (
    let entryIndex = searchable.length - 1;
    entryIndex >= 0;
    entryIndex--
  ) {
    const item = searchable[entryIndex];
    expression.lastIndex = 0;
    while (true) {
      const match = expression.exec(item.text);
      if (!match) break;
      matches.push({
        entryId: item.entry.id,
        origin: item.origin,
        timestamp: item.timestamp,
        match: match[0],
        start: match.index,
        end: match.index + match[0].length,
      });
      if (matches.length >= limit) {
        limitReached = true;
        break outer;
      }
      if (match[0].length === 0)
        expression.lastIndex = advanceAfterEmptyMatch(
          item.text,
          expression.lastIndex,
        );
    }
  }

  const flags = caseSensitive ? "gsu" : "gisu";
  const lines = [
    `Pattern /${args.pattern}/${flags} produced ${matches.length} match${matches.length === 1 ? "" : "es"}, newest entries first.`,
  ];
  matches.forEach((match, index) => {
    lines.push(
      "",
      `MATCH ${index + 1}`,
      `Entry: [${match.entryId}]`,
      `Origin: ${match.origin}`,
    );
    if (match.timestamp !== undefined)
      lines.push(`Time: ${String(match.timestamp)}`);
    lines.push(
      `Range: ${match.start}-${match.end}`,
      "",
      match.match || "(empty match)",
    );
  });
  if (limitReached)
    lines.push(
      "",
      `Stopped after ${limit} matches. Older matching entries may exist.`,
    );
  return textResult(lines.join("\n"), {
    pattern: args.pattern,
    caseSensitive,
    limit,
    limitReached,
    matches,
  } satisfies SearchChatHistoryDetails);
}

export function executeReadChatHistory(
  entries: Entry[],
  args: ReadChatHistoryArgs,
) {
  const contextBefore = args.context_before ?? 0;
  const contextAfter = args.context_after ?? 0;
  const searchable = historyEntries(entries);
  const selectedIndex = searchable.findIndex(
    (item) => item.entry.id === args.entry_id,
  );
  if (selectedIndex < 0) {
    return textResult(
      `No primary-chat entry with id ${args.entry_id} was found on the current branch.`,
      {
        entryId: args.entry_id,
        contextBefore,
        contextAfter,
        entries: [],
        found: false,
      } satisfies ReadChatHistoryDetails,
    );
  }

  const selected = searchable.slice(
    Math.max(0, selectedIndex - contextBefore),
    selectedIndex + contextAfter + 1,
  );
  const detailsEntries = selected.map((item) => ({
    id: item.entry.id,
    origin: item.origin,
    timestamp: item.timestamp,
    selected: item.entry.id === args.entry_id,
    content: item.text,
  }));
  const lines = [
    `CHAT HISTORY CONTEXT FOR [${args.entry_id}]`,
    `${selectedIndex - Math.max(0, selectedIndex - contextBefore)} entries before, ${Math.min(searchable.length, selectedIndex + contextAfter + 1) - selectedIndex - 1} entries after`,
  ];
  for (const item of detailsEntries) {
    lines.push(
      "",
      `${item.selected ? ">>> " : ""}[${item.id}] ${item.origin}${item.timestamp !== undefined ? ` @ ${String(item.timestamp)}` : ""}`,
      item.content,
    );
  }
  return textResult(lines.join("\n"), {
    entryId: args.entry_id,
    contextBefore,
    contextAfter,
    entries: detailsEntries,
    found: true,
  } satisfies ReadChatHistoryDetails);
}

export function createSearchChatHistoryAgentTool(
  getBranch: () => Entry[],
): AgentTool<typeof SEARCH_CHAT_HISTORY_PARAMETERS> {
  return {
    name: SEARCH_CHAT_HISTORY_TOOL_NAME,
    label: "Search primary chat history",
    description: SEARCH_CHAT_HISTORY_DESCRIPTION,
    parameters: SEARCH_CHAT_HISTORY_PARAMETERS,
    execute: async (_toolCallId, args) =>
      executeSearchChatHistory(getBranch(), args),
  };
}

export function createReadChatHistoryAgentTool(
  getBranch: () => Entry[],
): AgentTool<typeof READ_CHAT_HISTORY_PARAMETERS> {
  return {
    name: READ_CHAT_HISTORY_TOOL_NAME,
    label: "Read primary chat history",
    description: READ_CHAT_HISTORY_DESCRIPTION,
    parameters: READ_CHAT_HISTORY_PARAMETERS,
    execute: async (_toolCallId, args) =>
      executeReadChatHistory(getBranch(), args),
  };
}

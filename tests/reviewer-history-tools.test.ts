import { describe, expect, it } from "vitest";
import {
  executeReadChatHistory,
  executeSearchChatHistory,
} from "../src/agents/reviewer/history-tools.js";
import type { Entry } from "../src/session-ledger/types.js";

function message(
  id: string,
  role: "user" | "assistant",
  text: string,
  timestamp: number,
): Entry {
  return {
    type: "message",
    id,
    timestamp: new Date(timestamp).toISOString(),
    message: { role, content: [{ type: "text", text }], timestamp },
  };
}

describe("reviewer chat-history tools", () => {
  it("returns individual regex matches from newest entries first and stops at the limit", () => {
    const entries = [
      message("old", "user", "needle in the old entry", 1),
      message("new", "assistant", "needle once, needle twice", 2),
    ];

    const result = executeSearchChatHistory(entries, {
      pattern: "needle",
      limit: 2,
    });

    expect(result.details.matches).toMatchObject([
      { entryId: "new", match: "needle" },
      { entryId: "new", match: "needle" },
    ]);
    expect(result.details.limitReached).toBe(true);
    expect(result.content[0].text).toContain(
      "Older matching entries may exist",
    );
  });

  it("is case-insensitive by default, supports case-sensitive searches, and lets the regex capture context across lines", () => {
    const entries = [message("entry", "assistant", "Before\nTARGET\nAfter", 1)];

    const insensitive = executeSearchChatHistory(entries, {
      pattern: ".{0,7}target.{0,6}",
    });
    expect(insensitive.details.matches[0]?.match).toBe("Before\nTARGET\nAfter");

    const sensitive = executeSearchChatHistory(entries, {
      pattern: "target",
      case_sensitive: true,
    });
    expect(sensitive.details.matches).toEqual([]);
  });

  it("advances after zero-width matches instead of stalling", () => {
    const entries = [message("entry", "user", "eee", 1)];
    const result = executeSearchChatHistory(entries, {
      pattern: "(?=e)",
      limit: 3,
    });
    const ranges = result.details.matches.map((match) => [
      match.start,
      match.end,
    ]);
    expect(ranges).toHaveLength(3);
    expect(ranges.every(([start, end]) => start === end)).toBe(true);
    expect(ranges[1][0]).toBeGreaterThan(ranges[0][0]);
    expect(ranges[2][0]).toBeGreaterThan(ranges[1][0]);
  });

  it("returns a useful error for an invalid regular expression", () => {
    const result = executeSearchChatHistory([], { pattern: "[" });
    expect(result.details.error).toContain("Invalid regular expression");
    expect(result.details.matches).toEqual([]);
  });

  it("reads the selected entry with adjacent primary-chat context while excluding internal ledger entries", () => {
    const entries: Entry[] = [
      message("before", "user", "before", 1),
      {
        type: "custom",
        id: "internal",
        customType: "om.review.request",
        data: {},
      },
      message("selected", "assistant", "selected", 2),
      {
        type: "custom_message",
        id: "background",
        customType: "notice",
        timestamp: "1970-01-01T00:00:03.000Z",
        content: "background",
      },
      message("after", "user", "after", 4),
    ];

    const result = executeReadChatHistory(entries, {
      entry_id: "selected",
      context_before: 1,
      context_after: 2,
    });

    expect(result.details.entries.map((entry) => entry.id)).toEqual([
      "before",
      "selected",
      "background",
      "after",
    ]);
    expect(result.details.entries.map((entry) => entry.selected)).toEqual([
      false,
      true,
      false,
      false,
    ]);
    expect(result.content[0].text).toContain(">>> [selected]");
    expect(result.content[0].text).not.toContain("internal");
  });

  it("reports an entry that is absent from the current branch", () => {
    const result = executeReadChatHistory([], { entry_id: "missing" });
    expect(result.details.found).toBe(false);
    expect(result.content[0].text).toContain("No primary-chat entry");
  });
});

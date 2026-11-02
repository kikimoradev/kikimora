import { describe, expect, it } from "vitest";
import { z } from "zod";
import { parseTaskReport, TASK_REPORT_JSON_SCHEMA } from "../src/report.js";

function report(...tasks: Record<string, unknown>[]): string {
  return JSON.stringify({ tasks });
}

describe("TASK_REPORT_JSON_SCHEMA", () => {
  it("describes the source of a task as two optional properties", () => {
    const schema = JSON.parse(TASK_REPORT_JSON_SCHEMA) as {
      properties: {
        tasks: {
          items: {
            properties: Record<string, { type: string; description: string }>;
            required: string[];
            additionalProperties: boolean;
          };
        };
      };
    };
    const items = schema.properties.tasks.items;

    expect(items.properties.sourceLabel).toMatchObject({ type: "string", maxLength: 80 });
    expect(items.properties.sourceLabel?.description).toContain("ENG-142");
    expect(items.properties.sourceUrl).toMatchObject({ type: "string" });
    expect(items.properties.sourceUrl?.description).toContain("sourceLabel");
    expect(items.required).toEqual(["id", "title", "description"]);
    expect(items.additionalProperties).toBe(false);
  });
});

describe("parseTaskReport with the source of a task", () => {
  const issue = {
    id: "issue-142",
    title: "Discount applied before tax",
    description: "d",
    sourceLabel: "ENG-142",
    sourceUrl: "https://linear.app/acme/issue/ENG-142",
  };

  it("keeps the label and the address a report gives, and adds no keys without them", () => {
    const tasks = parseTaskReport(
      report(
        issue,
        { id: "redmine-3027", title: "ZPL labels", sourceLabel: " #3027 " },
        {
          id: "ci-9182634",
          title: "Fix the failing build",
          description: "d",
        },
      ),
    );

    expect(tasks).toEqual([
      issue,
      { id: "redmine-3027", title: "ZPL labels", description: "", sourceLabel: "#3027" },
      { id: "ci-9182634", title: "Fix the failing build", description: "d" },
    ]);
    expect(tasks?.[2]).not.toHaveProperty("sourceLabel");
    expect(tasks?.[2]).not.toHaveProperty("sourceUrl");
  });

  it("drops an invalid source but keeps the task", () => {
    const tasks = parseTaskReport(
      report(
        { id: "blank", title: "T", sourceLabel: "   ", sourceUrl: "https://example.com" },
        { id: "long", title: "T", sourceLabel: "x".repeat(81) },
        { id: "url-only", title: "T", sourceUrl: "https://example.com/1" },
        { id: "two-lines", title: "T", sourceLabel: "A\nB" },
        { id: "not-a-string", title: "T", sourceLabel: 142 },
        { id: "ftp", title: "T", sourceLabel: "F-1", sourceUrl: "ftp://example.com/f" },
        { id: "relative", title: "T", sourceLabel: "R-1", sourceUrl: "/issues/1" },
        {
          id: "too-long",
          title: "T",
          sourceLabel: "L-1",
          sourceUrl: `https://e.com/${"a".repeat(2048)}`,
        },
      ),
    );

    expect(tasks?.map((task) => task.id)).toEqual([
      "blank",
      "long",
      "url-only",
      "two-lines",
      "not-a-string",
      "ftp",
      "relative",
      "too-long",
    ]);
    for (const task of tasks?.slice(0, 5) ?? []) {
      expect(task).not.toHaveProperty("sourceLabel");
      expect(task).not.toHaveProperty("sourceUrl");
    }
    for (const task of tasks?.slice(5) ?? []) {
      expect(task).toHaveProperty("sourceLabel");
      expect(task).not.toHaveProperty("sourceUrl");
    }
  });

  it("gives an older worker, whose report schema strips unknown keys, a task without a source", () => {
    const schemaOf0190 = z.object({
      tasks: z.array(
        z.object({
          id: z.string().trim().min(1),
          title: z.string().trim().min(1),
          description: z.string().trim().default(""),
        }),
      ),
    });

    expect(schemaOf0190.parse(JSON.parse(report(issue)))).toEqual({
      tasks: [
        { id: "issue-142", title: "Discount applied before tax", description: "d" },
      ],
    });
  });
});

describe("parseTaskReport", () => {
  it("parses a json block surrounded by prose", () => {
    const text = [
      "I checked Redmine.",
      "```json",
      '{"tasks": [{"id": "redmine-1", "title": "Task", "description": "Description"}]}',
      "```",
    ].join("\n");

    expect(parseTaskReport(text)).toEqual([
      { id: "redmine-1", title: "Task", description: "Description" },
    ]);
  });

  it("takes the last json block when there are several", () => {
    const text = [
      "```json",
      '{"tasks": [{"id": "old", "title": "X", "description": ""}]}',
      "```",
      "Correction:",
      "```json",
      '{"tasks": [{"id": "new", "title": "Y", "description": ""}]}',
      "```",
    ].join("\n");

    expect(parseTaskReport(text)?.map((t) => t.id)).toEqual(["new"]);
  });

  it("parses raw JSON without a code block", () => {
    const text =
      '{"tasks": [{"id": "email-abc", "title": "Reply", "description": "Mail"}]}';

    expect(parseTaskReport(text)?.map((t) => t.id)).toEqual(["email-abc"]);
  });

  it("an empty task list is a valid report", () => {
    expect(parseTaskReport('{"tasks": []}')).toEqual([]);
  });

  it("fills a missing description with empty text", () => {
    const tasks = parseTaskReport('{"tasks": [{"id": "a", "title": "T"}]}');
    expect(tasks).toEqual([{ id: "a", title: "T", description: "" }]);
  });

  it("returns null for text without JSON", () => {
    expect(parseTaskReport("found nothing to do")).toBeNull();
  });

  it("returns null for JSON that does not match the schema", () => {
    expect(parseTaskReport('{"tasks": [{"title": "without id"}]}')).toBeNull();
    expect(parseTaskReport('{"tasks": [{"id": "", "title": "empty id"}]}')).toBeNull();
    expect(parseTaskReport('{"other": []}')).toBeNull();
  });

  it("returns null for broken JSON in a block", () => {
    expect(parseTaskReport('```json\n{"tasks": [}\n```')).toBeNull();
  });

  it("tolerates raw newlines inside strings", () => {
    const text =
      '{"tasks": [{"id": "a", "title": "T", "description": "line 1\nline 2\n\nline 4"}]}';

    expect(parseTaskReport(text)).toEqual([
      { id: "a", title: "T", description: "line 1\nline 2\n\nline 4" },
    ]);
  });

  it("tolerates raw control characters (tab, CR) inside strings", () => {
    const text = '{"tasks": [{"id": "a", "title": "T\tX", "description": "y\r\nz"}]}';

    expect(parseTaskReport(text)).toEqual([
      { id: "a", title: "T\tX", description: "y\r\nz" },
    ]);
  });

  it("does not confuse control characters in a string with structural whitespace", () => {
    const text = [
      "```json",
      "{",
      '  "tasks": [',
      '    {"id": "a", "title": "multiline",',
      '     "description": "row A\nrow B"}',
      "  ]",
      "}",
      "```",
    ].join("\n");

    expect(parseTaskReport(text)).toEqual([
      { id: "a", title: "multiline", description: "row A\nrow B" },
    ]);
  });

  it("deduplicates ids within the report (first occurrence wins)", () => {
    const text = JSON.stringify({
      tasks: [
        { id: "a", title: "First", description: "1" },
        { id: "a", title: "Duplicate", description: "2" },
        { id: "b", title: "Second", description: "3" },
      ],
    });

    expect(parseTaskReport(text)).toEqual([
      { id: "a", title: "First", description: "1" },
      { id: "b", title: "Second", description: "3" },
    ]);
  });
});

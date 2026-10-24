import { describe, expect, it } from "vitest";
import type { SessionEvent } from "../src/session-events.js";
import { StreamRenderer } from "../src/stream.js";

function createRenderer(streamPartial = false): {
  events: SessionEvent[];
  streamed: Record<string, unknown>[];
  order: string[];
  renderer: StreamRenderer;
} {
  const events: SessionEvent[] = [];
  const streamed: Record<string, unknown>[] = [];
  const order: string[] = [];
  const renderer = new StreamRenderer((event) => {
    order.push(event.type);
    if (event.type === "stream") streamed.push(event.event);
    else events.push(event);
  }, streamPartial);
  return { events, streamed, order, renderer };
}

function line(event: unknown): string {
  return JSON.stringify(event);
}

describe("StreamRenderer", () => {
  it("ignores empty lines", () => {
    const { events, renderer } = createRenderer();
    renderer.handleLine("");
    renderer.handleLine("   ");
    expect(events).toEqual([]);
  });

  it("emits a non-JSON line as a raw event", () => {
    const { events, renderer } = createRenderer();
    renderer.handleLine("not json");
    expect(events).toEqual([{ type: "raw", line: "not json" }]);
  });

  it("system/init emits the model, session and tool count", () => {
    const { events, renderer } = createRenderer();
    renderer.handleLine(
      line({
        type: "system",
        subtype: "init",
        model: "haiku",
        session_id: "sess-9",
        tools: ["Read", "Bash", "Edit"],
      }),
    );
    expect(events).toEqual([
      { type: "init", model: "haiku", sessionId: "sess-9", toolCount: 3 },
    ]);
  });

  it("assistant: emits text as text, tool_use as toolUse", () => {
    const { events, renderer } = createRenderer();
    renderer.handleLine(
      line({
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "  Hi  " },
            { type: "tool_use", name: "Bash", input: { command: "ls" } },
          ],
        },
      }),
    );
    expect(events).toEqual([
      { type: "text", text: "Hi" },
      { type: "toolUse", name: "Bash", input: { command: "ls" } },
    ]);
  });

  it("counts the tool calls of the run and keeps the count past the result", () => {
    const { renderer } = createRenderer();
    const toolUse = (name: string) => ({ type: "tool_use", name, input: {} });
    renderer.handleLine(
      line({
        type: "assistant",
        message: { content: [{ type: "text", text: "Looking" }, toolUse("Read")] },
      }),
    );
    expect(renderer.getSummary().toolUses).toBe(1);
    renderer.handleLine(
      line({
        type: "assistant",
        message: { content: [toolUse("Bash"), toolUse("Edit")] },
      }),
    );
    renderer.handleLine(line({ type: "result", is_error: true, session_id: "sess-4" }));
    expect(renderer.getSummary()).toMatchObject({ isError: true, toolUses: 3 });
  });

  it("a run without tool calls reports no tool uses", () => {
    const { renderer } = createRenderer();
    renderer.handleLine(
      line({
        type: "assistant",
        message: { content: [{ type: "text", text: "You've hit your limit" }] },
      }),
    );
    renderer.handleLine(line({ type: "result", is_error: true, session_id: "sess-5" }));
    expect(renderer.getSummary().toolUses).toBeUndefined();
  });

  it("assistant: empty text is skipped", () => {
    const { events, renderer } = createRenderer();
    renderer.handleLine(
      line({ type: "assistant", message: { content: [{ type: "text", text: "   " }] } }),
    );
    expect(events).toEqual([]);
  });

  it("user: tool_result emits toolResult with an error flag", () => {
    const { events, renderer } = createRenderer();
    renderer.handleLine(
      line({
        type: "user",
        message: {
          content: [{ type: "tool_result", content: "ok", is_error: false }],
        },
      }),
    );
    renderer.handleLine(
      line({
        type: "user",
        message: {
          content: [{ type: "tool_result", content: "boom", is_error: true }],
        },
      }),
    );
    expect(events).toEqual([
      { type: "toolResult", isError: false, lines: ["ok"], dropped: 0 },
      { type: "toolResult", isError: true, lines: ["boom"], dropped: 0 },
    ]);
  });

  it("user: a multi-line tool_result keeps the lines and skips empty ones", () => {
    const { events, renderer } = createRenderer();
    renderer.handleLine(
      line({
        type: "user",
        message: {
          content: [
            { type: "tool_result", content: "first\n\nsecond\nthird", is_error: false },
          ],
        },
      }),
    );
    expect(events).toEqual([
      {
        type: "toolResult",
        isError: false,
        lines: ["first", "second", "third"],
        dropped: 0,
      },
    ]);
  });

  it("user: keeps at most 20 result lines and counts the dropped ones", () => {
    const { events, renderer } = createRenderer();
    const content = Array.from({ length: 25 }, (_, i) => `line ${i + 1}`).join("\n");
    renderer.handleLine(
      line({
        type: "user",
        message: { content: [{ type: "tool_result", content }] },
      }),
    );
    const [event] = events;
    if (event?.type !== "toolResult") throw new Error("expected a toolResult event");
    expect(event.lines).toHaveLength(20);
    expect(event.lines[0]).toBe("line 1");
    expect(event.lines[19]).toBe("line 20");
    expect(event.dropped).toBe(5);
  });

  it("user: extracts text from tool_result content blocks", () => {
    const { events, renderer } = createRenderer();
    renderer.handleLine(
      line({
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              content: [
                { type: "text", text: "alpha" },
                { type: "image" },
                { type: "text", text: "beta" },
              ],
            },
          ],
        },
      }),
    );
    expect(events).toEqual([
      { type: "toolResult", isError: false, lines: ["alpha", "beta"], dropped: 0 },
    ]);
  });

  it("user: serializes a non-text tool_result payload", () => {
    const { events, renderer } = createRenderer();
    renderer.handleLine(
      line({
        type: "user",
        message: {
          content: [{ type: "tool_result", content: { status: 200 } }],
        },
      }),
    );
    expect(events).toEqual([
      { type: "toolResult", isError: false, lines: ['{"status":200}'], dropped: 0 },
    ]);
  });

  it("stream_event with partial enabled emits partial with the delta", () => {
    const { events, renderer } = createRenderer(true);
    renderer.handleLine(
      line({
        type: "stream_event",
        event: {
          type: "content_block_delta",
          delta: { type: "text_delta", text: "abc" },
        },
      }),
    );
    expect(events).toEqual([{ type: "partial", text: "abc" }]);
  });

  it("stream_event with partial disabled emits nothing", () => {
    const { events, renderer } = createRenderer(false);
    renderer.handleLine(
      line({
        type: "stream_event",
        event: {
          type: "content_block_delta",
          delta: { type: "text_delta", text: "abc" },
        },
      }),
    );
    expect(events).toEqual([]);
  });

  it("result emits no event, only feeds the summary", () => {
    const { events, renderer } = createRenderer();
    renderer.handleLine(
      line({
        type: "result",
        is_error: false,
        total_cost_usd: 0.5,
        num_turns: 4,
        session_id: "sess-3",
      }),
    );
    expect(events).toEqual([]);
    expect(renderer.getSummary()).toEqual({
      isError: false,
      costUsd: 0.5,
      numTurns: 4,
      sessionId: "sess-3",
      resultText: undefined,
    });
  });

  it("rate_limit_event emits no event and lands in the summary", () => {
    const { events, renderer } = createRenderer();
    renderer.handleLine(
      line({
        type: "rate_limit_event",
        rate_limit_info: {
          status: "rejected",
          resetsAt: 1778193600,
          rateLimitType: "five_hour",
        },
      }),
    );
    renderer.handleLine(line({ type: "result", is_error: true, session_id: "sess-7" }));
    expect(events).toEqual([]);
    expect(renderer.getSummary()).toMatchObject({
      isError: true,
      rateLimit: {
        status: "rejected",
        resetsAt: 1778193600,
        rateLimitType: "five_hour",
      },
    });
  });

  it("a rate_limit_event without a status is ignored", () => {
    const { renderer } = createRenderer();
    renderer.handleLine(
      line({ type: "rate_limit_event", rate_limit_info: { resetsAt: 123 } }),
    );
    expect(renderer.getSummary().rateLimit).toBeUndefined();
  });

  it("system/api_retry lands in the summary and survives the result reset", () => {
    const { events, renderer } = createRenderer();
    renderer.handleLine(
      line({
        type: "system",
        subtype: "api_retry",
        attempt: 1,
        error_status: 401,
        error: "authentication_failed",
      }),
    );
    renderer.handleLine(
      line({
        type: "result",
        subtype: "success",
        is_error: true,
        result: "Failed to authenticate.",
        terminal_reason: "api_error",
      }),
    );
    expect(events).toEqual([]);
    expect(renderer.getSummary()).toMatchObject({
      isError: true,
      apiError: { status: 401, code: "authentication_failed" },
      terminalReason: "api_error",
    });
  });

  it("the latest api_retry wins and one without a status is ignored", () => {
    const { renderer } = createRenderer();
    renderer.handleLine(
      line({ type: "system", subtype: "api_retry", error_status: 529 }),
    );
    renderer.handleLine(
      line({ type: "system", subtype: "api_retry", error: "no status" }),
    );
    expect(renderer.getSummary().apiError).toEqual({ status: 529, code: undefined });
    renderer.handleLine(
      line({
        type: "system",
        subtype: "api_retry",
        error_status: 401,
        error: "authentication_failed",
      }),
    );
    expect(renderer.getSummary().apiError).toEqual({
      status: 401,
      code: "authentication_failed",
    });
  });

  it("getSummary passes the text from the result field", () => {
    const { renderer } = createRenderer();
    renderer.handleLine(
      line({
        type: "result",
        is_error: false,
        session_id: "sess-5",
        result: '{"tasks": []}',
      }),
    );
    expect(renderer.getSummary().resultText).toBe('{"tasks": []}');
  });

  it("getSummary returns isError=true for a result with is_error", () => {
    const { renderer } = createRenderer();
    renderer.handleLine(line({ type: "result", is_error: true, session_id: "sess-err" }));
    const summary = renderer.getSummary();
    expect(summary.isError).toBe(true);
    expect(summary.sessionId).toBe("sess-err");
  });

  it("passes the raw tool input through untouched", () => {
    const { events, renderer } = createRenderer();
    renderer.handleLine(
      line({
        type: "assistant",
        message: {
          content: [{ type: "tool_use", name: "Bash", input: { command: "ls -la" } }],
        },
      }),
    );
    const [event] = events;
    if (event?.type !== "toolUse") throw new Error("expected a toolUse event");
    expect(event.input).toEqual({ command: "ls -la" });
  });

  it("truncates a very long tool_result first line", () => {
    const { events, renderer } = createRenderer();
    renderer.handleLine(
      line({
        type: "user",
        message: {
          content: [{ type: "tool_result", content: "a".repeat(1000) }],
        },
      }),
    );
    const [event] = events;
    if (event?.type !== "toolResult") throw new Error("expected a toolResult event");
    expect(event.lines[0]?.endsWith("…")).toBe(true);
    expect(event.lines[0]?.length).toBeLessThanOrEqual(301);
  });

  it("unescapes literal \\n sequences when the result has no real newlines", () => {
    const { events, renderer } = createRenderer();
    renderer.handleLine(
      line({
        type: "user",
        message: {
          content: [
            { type: "tool_result", content: "status_code: 200\\nbody:\\n user: 179" },
          ],
        },
      }),
    );
    expect(events).toEqual([
      {
        type: "toolResult",
        isError: false,
        lines: ["status_code: 200", "body:", "user: 179"],
        dropped: 0,
      },
    ]);
  });

  it("keeps literal \\n sequences when real newlines are present", () => {
    const { events, renderer } = createRenderer();
    renderer.handleLine(
      line({
        type: "user",
        message: {
          content: [{ type: "tool_result", content: "diff uses \\n here\nsecond" }],
        },
      }),
    );
    expect(events).toEqual([
      {
        type: "toolResult",
        isError: false,
        lines: ["diff uses \\n here", "second"],
        dropped: 0,
      },
    ]);
  });
});

describe("StreamRenderer raw event tap", () => {
  it("emits the parsed object unchanged, after the rendered event", () => {
    const { streamed, order, renderer } = createRenderer();
    const event = {
      type: "assistant",
      message: {
        content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: {} }],
        usage: { input_tokens: 12, output_tokens: 3 },
      },
    };

    renderer.handleLine(line(event));

    expect(streamed).toEqual([event]);
    expect(order).toEqual(["toolUse", "stream"]);
  });

  it("taps every type except stream_event", () => {
    const { streamed, renderer } = createRenderer(true);
    renderer.handleLine(
      line({ type: "system", subtype: "init", model: "opus", session_id: "s" }),
    );
    renderer.handleLine(
      line({
        type: "stream_event",
        event: { type: "content_block_delta", delta: { type: "text_delta", text: "x" } },
      }),
    );
    renderer.handleLine(line({ type: "result", is_error: false, num_turns: 1 }));

    expect(streamed.map((event) => event.type)).toEqual(["system", "result"]);
  });

  it("does not tap a non-JSON line or a JSON line that is not an object", () => {
    const { events, streamed, renderer } = createRenderer();

    renderer.handleLine("not json");
    renderer.handleLine("42");
    renderer.handleLine("[1, 2]");

    expect(streamed).toEqual([]);
    expect(events).toEqual([{ type: "raw", line: "not json" }]);
  });
});

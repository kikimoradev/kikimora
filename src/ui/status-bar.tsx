import { Box, Text } from "ink";
import type { JSX } from "react";
import type { NoticeTone } from "./commands.js";
import type { StatusLine } from "./format.js";
import { fitHints, KeyHints, type KeyHint } from "./key-hints.js";
import { glyphs, toneColor, type Tone } from "./theme.js";

export interface Notice {
  text: string;
  tone: NoticeTone;
}

const NOTICE_GLYPHS: Record<NoticeTone, string> = {
  ok: glyphs.ok,
  info: glyphs.active,
  warn: glyphs.warn,
  error: glyphs.error,
};

export interface StatusBarProps {
  viewName: string;
  agents: readonly (readonly [name: string, status: StatusLine])[];
  notice: Notice | null;
  hints: readonly KeyHint[];
  width: number;
}

const BAR_CHROME = 4;

function AgentDot({ name, status }: { name: string; status: StatusLine }): JSX.Element {
  return (
    <Text>
      <Text color={toneColor(status.tone)}>
        {status.busy ? glyphs.active : status.glyph}
      </Text>
      <Text dimColor>{` ${name}`}</Text>
    </Text>
  );
}

export function StatusBar({
  viewName,
  agents,
  notice,
  hints,
  width,
}: StatusBarProps): JSX.Element {
  const noticeTone: Tone = notice === null ? "muted" : notice.tone;
  const leftWidth =
    viewName.length + agents.reduce((total, [name]) => total + name.length + 4, 0);
  const fitted = fitHints(hints, width - leftWidth - BAR_CHROME);
  return (
    <Box height={1} paddingX={1} gap={2} flexShrink={0}>
      <Box flexGrow={1} flexShrink={1} overflow="hidden">
        {notice === null ? (
          <Text wrap="truncate-end">
            <Text bold>{viewName}</Text>
            {agents.map(([name, status]) => (
              <Text key={name}>
                {"  "}
                <AgentDot name={name} status={status} />
              </Text>
            ))}
          </Text>
        ) : (
          <Text wrap="truncate-end">
            <Text color={toneColor(noticeTone)}>{`${NOTICE_GLYPHS[notice.tone]} `}</Text>
            {notice.text}
          </Text>
        )}
      </Box>
      {fitted.length === 0 || notice !== null ? null : (
        <Box flexShrink={0}>
          <KeyHints hints={fitted} />
        </Box>
      )}
    </Box>
  );
}

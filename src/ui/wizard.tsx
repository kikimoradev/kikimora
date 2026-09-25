import { Box, Text } from "ink";
import type { JSX } from "react";
import { useState } from "react";
import { countLabel } from "./format.js";
import { PromptEditor } from "./prompt-editor.js";
import { glyphs, theme } from "./theme.js";
import { useTerminalSize } from "./use-terminal-size.js";

export interface WizardResult {
  monitorPrompt: string;
  executorPrompt: string;
}

export interface WizardProps {
  initialMonitorPrompt?: string | undefined;
  initialExecutorPrompt?: string | undefined;
  onComplete: (result: WizardResult | null) => void;
}

const INTRO =
  "The monitor finds tasks, the executor completes them. Describe both below — " +
  "you can edit these prompts later with /prompt.";

const MAX_EDITOR_WIDTH = 100;
const MAX_EDITOR_LINES = 12;

interface StepSpec {
  key: "monitor" | "executor";
  title: string;
  hint: string;
  placeholder: string;
}

const STEPS: readonly [StepSpec, StepSpec] = [
  {
    key: "monitor",
    title: "What should the monitor watch?",
    hint: "where to look and what counts as a task",
    placeholder: "e.g. new GitHub issues assigned to me, failing CI runs on main…",
  },
  {
    key: "executor",
    title: "Who is the executor and how should it complete tasks?",
    hint: "identity, working rules and tools — one task per session",
    placeholder: "identity, working rules, available tools…",
  },
];

function firstLine(value: string): string {
  return value.split("\n").find((line) => line.trim() !== "") ?? "";
}

function StepSummary({ label, value }: { label: string; value: string }): JSX.Element {
  const lines = value.split("\n").length;
  return (
    <Box paddingX={1} gap={2}>
      <Box flexShrink={0}>
        <Text>
          <Text color={theme.ok}>{`${glyphs.ok} `}</Text>
          <Text bold>{label}</Text>
        </Text>
      </Box>
      <Box flexGrow={1} flexShrink={1} overflow="hidden">
        <Text dimColor wrap="truncate-end">
          {firstLine(value)}
        </Text>
      </Box>
      <Box flexShrink={0}>
        <Text dimColor>{countLabel(lines, "line", "lines")}</Text>
      </Box>
    </Box>
  );
}

export function Wizard({
  initialMonitorPrompt,
  initialExecutorPrompt,
  onComplete,
}: WizardProps): JSX.Element {
  const { columns, rows } = useTerminalSize();
  const [monitorPrompt, setMonitorPrompt] = useState<string | null>(null);
  const width = Math.min(columns, MAX_EDITOR_WIDTH);
  const maxVisibleLines = Math.max(3, Math.min(MAX_EDITOR_LINES, rows - 12));
  const [monitorStep, executorStep] = STEPS;
  const step = monitorPrompt === null ? monitorStep : executorStep;
  const stepNumber = monitorPrompt === null ? 1 : 2;

  return (
    <Box flexDirection="column" width={width}>
      <Box paddingX={1}>
        <Text>
          <Text bold>{"Kikimora"}</Text>
          <Text dimColor>{" setup"}</Text>
        </Text>
      </Box>
      <Box paddingX={1} marginBottom={1}>
        <Text dimColor wrap="wrap">
          {INTRO}
        </Text>
      </Box>
      {monitorPrompt === null ? null : (
        <Box marginBottom={1} flexDirection="column">
          <StepSummary label="monitor" value={monitorPrompt} />
        </Box>
      )}
      <PromptEditor
        key={step.key}
        title={step.title}
        step={`${stepNumber}/${STEPS.length}`}
        description={step.hint}
        submitLabel={stepNumber === STEPS.length ? "finish" : "next"}
        placeholder={step.placeholder}
        initialValue={
          step.key === "monitor" ? initialMonitorPrompt : initialExecutorPrompt
        }
        width={width}
        maxVisibleLines={maxVisibleLines}
        onSubmit={(value) => {
          if (monitorPrompt === null) {
            setMonitorPrompt(value);
            return;
          }
          onComplete({ monitorPrompt, executorPrompt: value });
        }}
        onCancel={() => {
          onComplete(null);
        }}
      />
    </Box>
  );
}

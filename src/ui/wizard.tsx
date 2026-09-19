import { Box, Text } from "ink";
import type { JSX } from "react";
import { useState } from "react";
import { PromptEditor } from "./prompt-editor.js";

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
  "the monitor finds tasks, the executor completes them. " +
  "Describe both below — you can edit these prompts later with /prompt.";

export function Wizard({
  initialMonitorPrompt,
  initialExecutorPrompt,
  onComplete,
}: WizardProps): JSX.Element {
  const [step, setStep] = useState<"monitor" | "executor">("monitor");
  const [monitorPrompt, setMonitorPrompt] = useState("");

  return (
    <Box flexDirection="column" gap={1}>
      <Text wrap="wrap">
        <Text bold>{"Kikimora setup"}</Text>
        <Text dimColor>{` — ${INTRO}`}</Text>
      </Text>
      {step === "monitor" ? (
        <PromptEditor
          key="monitor"
          title="What should the monitor watch?"
          step="1/2"
          placeholder="e.g. new GitHub issues assigned to me, failing CI runs on main…"
          initialValue={initialMonitorPrompt}
          onSubmit={(value) => {
            setMonitorPrompt(value);
            setStep("executor");
          }}
          onCancel={() => {
            onComplete(null);
          }}
        />
      ) : (
        <PromptEditor
          key="executor"
          title="Who is the executor and how should it complete tasks?"
          step="2/2"
          placeholder="identity, working rules, available tools…"
          initialValue={initialExecutorPrompt}
          onSubmit={(value) => {
            onComplete({ monitorPrompt, executorPrompt: value });
          }}
          onCancel={() => {
            onComplete(null);
          }}
        />
      )}
    </Box>
  );
}

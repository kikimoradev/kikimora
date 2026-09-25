import { Box, Text } from "ink";
import type { JSX } from "react";
import type { WorkerStatus } from "../../status.js";
import type { WorkerConfig } from "../../types.js";
import { AgentPanel } from "../agent-panel.js";
import {
  executorPanelModel,
  monitorPanelModel,
  type AgentPanelModel,
} from "../agent-visuals.js";
import { formatInterval } from "../format.js";
import { TaskTable } from "../task-table.js";

export type PanelId = "monitor" | "executor";

export const PANEL_IDS: readonly PanelId[] = ["monitor", "executor"];

const PANEL_TITLES: Record<PanelId, string> = {
  monitor: "Monitor",
  executor: "Executor",
};

export function agentSubtitle(config: WorkerConfig, agent: PanelId): string {
  const { model, effort } = config[agent];
  const base = `${model} · ${effort}`;
  return agent === "monitor"
    ? `${base} · every ${formatInterval(config.monitor.intervalMs)}`
    : base;
}

export interface DashboardViewProps {
  status: WorkerStatus;
  config: WorkerConfig;
  width: number;
  height: number;
  now: number;
  interactive: boolean;
  narrow: boolean;
  focusedPanel: PanelId;
  scrollOffsets: Record<PanelId, number>;
  expanded: boolean;
}

function PanelTabs({
  focused,
  subtitle,
}: {
  focused: PanelId;
  subtitle: string;
}): JSX.Element {
  return (
    <Text wrap="truncate-end">
      {PANEL_IDS.map((id, index) => (
        <Text key={id}>
          {index === 0 ? null : <Text dimColor>{" │ "}</Text>}
          {id === focused ? (
            <Text bold>{PANEL_TITLES[id]}</Text>
          ) : (
            <Text dimColor>{PANEL_TITLES[id]}</Text>
          )}
        </Text>
      ))}
      <Text dimColor>{`  ${subtitle}`}</Text>
    </Text>
  );
}

export function DashboardView({
  status,
  config,
  width,
  height,
  now,
  interactive,
  narrow,
  focusedPanel,
  scrollOffsets,
  expanded,
}: DashboardViewProps): JSX.Element {
  const tableHeight = Math.max(4, Math.floor(height / 3));
  const panelHeight = Math.max(6, height - tableHeight);
  const models: Record<PanelId, AgentPanelModel> = {
    monitor: monitorPanelModel(status.monitor, now),
    executor: executorPanelModel(status.executor, now),
  };
  const panel = (id: PanelId, panelWidth: number, heading?: JSX.Element): JSX.Element => (
    <AgentPanel
      key={id}
      title={PANEL_TITLES[id]}
      subtitle={agentSubtitle(config, id)}
      heading={heading}
      model={models[id]}
      width={panelWidth}
      height={panelHeight}
      active={!interactive || narrow || focusedPanel === id}
      scrollOffset={scrollOffsets[id]}
      expanded={expanded}
    />
  );
  const leftWidth = Math.floor(width / 2);
  return (
    <Box flexDirection="column" height={height} overflow="hidden">
      <Box>
        {narrow
          ? panel(
              focusedPanel,
              width,
              <PanelTabs
                focused={focusedPanel}
                subtitle={agentSubtitle(config, focusedPanel)}
              />,
            )
          : [panel("monitor", leftWidth), panel("executor", width - leftWidth)]}
      </Box>
      <TaskTable
        tasks={status.tasks}
        height={tableHeight}
        now={now}
        active={false}
        scrollable={false}
      />
    </Box>
  );
}

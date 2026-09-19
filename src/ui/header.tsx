import { homedir } from "node:os";
import { Box, Text } from "ink";
import type { JSX } from "react";
import type { WorkerStatus } from "../status.js";
import type { WorkerConfig } from "../types.js";
import { executorPanelModel, monitorPanelModel } from "./agent-visuals.js";
import { formatDrainNotice, formatHeaderStats, formatInterval } from "./format.js";
import { theme } from "./theme.js";

function shortenPath(path: string): string {
  const home = homedir();
  return path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

interface HeaderLineProps {
  left: JSX.Element;
  right: string;
}

function HeaderLine({ left, right }: HeaderLineProps): JSX.Element {
  return (
    <Box justifyContent="space-between" gap={2}>
      <Box flexShrink={1} overflow="hidden">
        {left}
      </Box>
      <Text dimColor wrap="truncate-end">
        {right}
      </Text>
    </Box>
  );
}

export interface HeaderProps {
  config: WorkerConfig;
  version: string;
  status: WorkerStatus;
  now: number;
}

export function Header({ config, version, status, now }: HeaderProps): JSX.Element {
  const monitor = monitorPanelModel(status.monitor, now);
  const executor = executorPanelModel(status.executor, now);
  return (
    <Box
      borderStyle="round"
      borderColor={theme.muted}
      paddingX={1}
      flexDirection="column"
    >
      <HeaderLine
        left={
          <Text wrap="truncate-end">
            <Text bold>{"Kikimora"}</Text>
            <Text color={theme.muted}>{` v${version}`}</Text>
          </Text>
        }
        right={shortenPath(config.cwd)}
      />
      <HeaderLine
        left={
          <Text wrap="truncate-end">
            <Text bold>{"monitor  "}</Text>
            <Text color={monitor.phaseColor}>{monitor.phaseLabel}</Text>
          </Text>
        }
        right={
          `${config.monitor.model} · ${config.monitor.effort}` +
          ` · every ${formatInterval(config.monitor.intervalMs)}`
        }
      />
      <HeaderLine
        left={
          <Text wrap="truncate-end">
            <Text bold>{"executor "}</Text>
            <Text color={executor.phaseColor}>{executor.phaseLabel}</Text>
          </Text>
        }
        right={`${config.executor.model} · ${config.executor.effort}`}
      />
      <Text dimColor wrap="truncate-end">
        {formatHeaderStats(status.stats, status.tasks, now - status.startedAt)}
      </Text>
      {status.drain === undefined ? null : (
        <Text color={theme.warn} wrap="truncate-end">
          {formatDrainNotice(status.drain, now)}
        </Text>
      )}
      {status.update === undefined ? null : (
        <Text color={theme.info} wrap="truncate-end">
          {status.update.state === "installed"
            ? `⬆ updated to v${status.update.to} — restart to apply`
            : `⬆ update available v${status.update.from} → v${status.update.to} — run "kikimora update"`}
        </Text>
      )}
    </Box>
  );
}

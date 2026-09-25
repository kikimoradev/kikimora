import { homedir } from "node:os";
import { Box, Text } from "ink";
import type { JSX } from "react";
import type { WorkerStatus } from "../status.js";
import type { WorkerConfig } from "../types.js";
import { formatDrainNotice, formatHeaderStats } from "./format.js";
import { glyphs, theme } from "./theme.js";

function shortenPath(path: string): string {
  const home = homedir();
  return path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

export interface Banner {
  glyph: string;
  color: string;
  text: string;
}

export function headerBanners(status: WorkerStatus, now: number): Banner[] {
  const banners: Banner[] = [];
  if (status.shutdownSignal !== undefined) {
    banners.push({
      glyph: glyphs.stop,
      color: theme.warn,
      text: `Received ${status.shutdownSignal} — shutting down…`,
    });
  }
  if (status.drain !== undefined) {
    banners.push({
      glyph: glyphs.drain,
      color: theme.warn,
      text: formatDrainNotice(status.drain, now),
    });
  }
  if (status.update !== undefined) {
    banners.push({
      glyph: glyphs.update,
      color: theme.info,
      text:
        status.update.state === "installed"
          ? `updated to v${status.update.to} — restart to apply`
          : `update available v${status.update.from} → v${status.update.to} — run "kikimora update"`,
    });
  }
  return banners;
}

export interface HeaderProps {
  config: WorkerConfig;
  version: string;
  status: WorkerStatus;
  banners: readonly Banner[];
  now: number;
}

export function Header({
  config,
  version,
  status,
  banners,
  now,
}: HeaderProps): JSX.Element {
  return (
    <Box flexDirection="column" flexShrink={0}>
      <Box height={1} paddingX={1} gap={2}>
        <Box flexGrow={1} flexShrink={1} overflow="hidden">
          <Text wrap="truncate-end">
            <Text bold>{"Kikimora"}</Text>
            <Text dimColor>{` v${version} · ${shortenPath(config.cwd)}`}</Text>
          </Text>
        </Box>
        <Box flexShrink={0}>
          <Text dimColor>{formatHeaderStats(status.stats, now - status.startedAt)}</Text>
        </Box>
      </Box>
      {banners.map((banner) => (
        <Box key={banner.glyph} height={1} paddingX={1}>
          <Text wrap="truncate-end">
            <Text color={banner.color}>{`${banner.glyph} `}</Text>
            {banner.text}
          </Text>
        </Box>
      ))}
    </Box>
  );
}

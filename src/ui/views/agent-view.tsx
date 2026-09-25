import { Box, Text } from "ink";
import type { JSX } from "react";
import { AgentPanel, OutcomeText } from "../agent-panel.js";
import type { AgentPanelModel } from "../agent-visuals.js";
import { Panel } from "../panel.js";

export interface AgentViewProps {
  title: string;
  subtitle: string;
  model: AgentPanelModel;
  width: number;
  height: number;
  scrollOffset: number;
  expanded: boolean;
}

export function AgentView({
  title,
  subtitle,
  model,
  width,
  height,
  scrollOffset,
  expanded,
}: AgentViewProps): JSX.Element {
  const outcomes = model.recentOutcomes;
  const outcomesHeight =
    outcomes.length === 0
      ? 3
      : Math.min(Math.max(3, Math.floor(height / 3)), outcomes.length + 2);
  const panelHeight = Math.max(6, height - outcomesHeight);
  const visibleOutcomes = outcomes.slice(0, Math.max(1, outcomesHeight - 2));
  return (
    <Box flexDirection="column" height={height} overflow="hidden">
      <AgentPanel
        title={title}
        subtitle={subtitle}
        model={model}
        width={width}
        height={panelHeight}
        active
        scrollOffset={scrollOffset}
        expanded={expanded}
        showOutcome={false}
      />
      <Panel title="Recent outcomes" height={outcomesHeight} active={false}>
        {visibleOutcomes.length === 0 ? <Text dimColor>nothing finished yet</Text> : null}
        {visibleOutcomes.map((outcome, index) => (
          <Box key={index} height={1} gap={2}>
            <Box flexGrow={1} flexShrink={1} flexBasis={0} overflow="hidden">
              <OutcomeText outcome={outcome} />
            </Box>
            <Box flexShrink={0}>
              <Text dimColor>{outcome.meta}</Text>
            </Box>
          </Box>
        ))}
      </Panel>
    </Box>
  );
}

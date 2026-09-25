import { Box, Text } from "ink";
import type { JSX, ReactNode } from "react";
import { theme } from "./theme.js";

export interface PanelProps {
  title: ReactNode;
  aside?: ReactNode;
  footer?: ReactNode;
  footerAside?: ReactNode;
  active?: boolean | undefined;
  height?: number | undefined;
  width?: number | undefined;
  grow?: boolean | undefined;
  paddingX?: number | undefined;
  children?: ReactNode;
}

const RULE = "─".repeat(512);

interface EdgeProps {
  left: string;
  right: string;
  title: ReactNode;
  aside: ReactNode;
  borderColor: string | undefined;
}

function Edge({ left, right, title, aside, borderColor }: EdgeProps): JSX.Element {
  const color = borderColor === undefined ? {} : { color: borderColor };
  return (
    <Box height={1} flexShrink={0}>
      <Text {...color}>{`${left}─`}</Text>
      {title === undefined ? null : (
        <Box flexShrink={1} overflow="hidden" paddingX={1}>
          {title}
        </Box>
      )}
      <Box flexGrow={1} flexShrink={1} flexBasis={0} height={1} overflow="hidden">
        <Text {...color}>{RULE}</Text>
      </Box>
      {aside === undefined ? null : (
        <Box flexShrink={0} paddingX={1}>
          {aside}
        </Box>
      )}
      <Text {...color}>{`─${right}`}</Text>
    </Box>
  );
}

export interface PanelTitleProps {
  children: ReactNode;
  subtitle?: ReactNode;
  active?: boolean | undefined;
}

export function PanelTitle({
  children,
  subtitle,
  active = true,
}: PanelTitleProps): JSX.Element {
  return (
    <Text wrap="truncate-end">
      <Text bold dimColor={!active}>
        {children}
      </Text>
      {subtitle === undefined ? null : (
        <Text dimColor>
          {"  "}
          {subtitle}
        </Text>
      )}
    </Text>
  );
}

export function Panel({
  title,
  aside,
  footer,
  footerAside,
  active = true,
  height,
  width,
  grow = false,
  paddingX = 1,
  children,
}: PanelProps): JSX.Element {
  const borderColor = active ? undefined : theme.muted;
  const hasFooter = footer !== undefined || footerAside !== undefined;
  const heading =
    typeof title === "string" ? <PanelTitle active={active}>{title}</PanelTitle> : title;
  return (
    <Box
      flexDirection="column"
      height={height}
      width={width}
      flexGrow={grow ? 1 : 0}
      flexBasis={grow ? 0 : undefined}
      flexShrink={grow ? 1 : 0}
      overflow="hidden"
    >
      <Edge left="╭" right="╮" title={heading} aside={aside} borderColor={borderColor} />
      <Box
        borderStyle="round"
        borderColor={borderColor}
        borderTop={false}
        borderBottom={!hasFooter}
        flexDirection="column"
        flexGrow={1}
        paddingX={paddingX}
        overflow="hidden"
      >
        {children}
      </Box>
      {hasFooter ? (
        <Edge
          left="╰"
          right="╯"
          title={footer}
          aside={footerAside}
          borderColor={borderColor}
        />
      ) : null}
    </Box>
  );
}

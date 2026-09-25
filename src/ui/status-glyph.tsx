import { Text } from "ink";
import type { JSX } from "react";
import type { StatusLine } from "./format.js";
import { Spinner } from "./spinner.js";
import { toneColor } from "./theme.js";

export function StatusGlyph({ status }: { status: StatusLine }): JSX.Element {
  const color = toneColor(status.tone);
  return status.busy ? (
    <Spinner color={color} />
  ) : (
    <Text color={color}>{status.glyph}</Text>
  );
}

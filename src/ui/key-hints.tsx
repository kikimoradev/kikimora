import { Text } from "ink";
import type { JSX } from "react";
import { Fragment } from "react";

export type KeyHint = readonly [key: string, label: string];

const SEPARATOR = " · ";

export function hintsWidth(hints: readonly KeyHint[]): number {
  return hints.reduce(
    (total, [key, label], index) =>
      total + (index === 0 ? 0 : SEPARATOR.length) + key.length + 1 + label.length,
    0,
  );
}

export function fitHints(hints: readonly KeyHint[], maxWidth: number): KeyHint[] {
  const fitted = [...hints];
  while (fitted.length > 0 && hintsWidth(fitted) > maxWidth) fitted.pop();
  return fitted;
}

export function KeyHints({ hints }: { hints: readonly KeyHint[] }): JSX.Element {
  return (
    <Text wrap="truncate-end">
      {hints.map(([key, label], index) => (
        <Fragment key={key}>
          {index === 0 ? null : <Text dimColor>{SEPARATOR}</Text>}
          <Text>{key}</Text>
          <Text dimColor>{` ${label}`}</Text>
        </Fragment>
      ))}
    </Text>
  );
}

export const PANEL_BORDER_ROWS = 2;

export interface ListWindow<T> {
  visible: readonly T[];
  start: number;
  total: number;
  capacity: number;
}

export function maxListOffset(total: number, capacity: number): number {
  return Math.max(0, total - Math.max(1, capacity));
}

export function listWindow<T>(
  rows: readonly T[],
  capacity: number,
  offset: number,
): ListWindow<T> {
  const safeCapacity = Math.max(1, capacity);
  const start = Math.min(Math.max(0, offset), maxListOffset(rows.length, safeCapacity));
  return {
    visible: rows.slice(start, start + safeCapacity),
    start,
    total: rows.length,
    capacity: safeCapacity,
  };
}

export function describeWindow(window: ListWindow<unknown>): string | undefined {
  if (window.total <= window.capacity) return undefined;
  const last = Math.min(window.total, window.start + window.capacity);
  return `${String(window.start + 1)}–${String(last)} of ${String(window.total)} · pgup/pgdn`;
}

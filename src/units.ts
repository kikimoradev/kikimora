function pad2(value: number): string {
  return value.toString().padStart(2, "0");
}

export function formatUptime(ms: number): string {
  const totalSeconds = Math.floor(Math.max(0, ms) / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return h > 0 ? `${h}h ${pad2(m)}m` : `${m}m ${pad2(s)}s`;
}

export function formatElapsed(ms: number): string {
  const safe = Math.max(0, ms);
  if (safe < 10_000) return `${(safe / 1000).toFixed(1)}s`;
  return formatUptime(safe);
}

export function formatCost(costUsd: number): string {
  if (costUsd <= 0) return "$0.00";
  if (costUsd < 0.001) return "<$0.001";
  if (costUsd < 1) return `$${costUsd.toFixed(3)}`;
  return `$${costUsd.toFixed(2)}`;
}

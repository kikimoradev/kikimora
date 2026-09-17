import { buildSchedule, parseActiveDays, parseTimeWindow } from "./active-hours.js";
import { loadSettings, type Settings } from "./config.js";
import {
  mergeSettingsPatch,
  patchSettings,
  settingsSection,
  type SettingsPatch,
} from "./settings-file.js";
import {
  EFFORT_LEVELS,
  MODELS,
  MODELS_WITHOUT_EFFORT,
  type WorkerConfig,
} from "./types.js";

export const CONFIG_AGENTS = ["monitor", "executor", "summarizer"] as const;

export type ConfigAgent = (typeof CONFIG_AGENTS)[number];

export function parseConfigAgent(raw: string): ConfigAgent {
  const match = CONFIG_AGENTS.find((agent) => agent === raw);
  if (match === undefined) {
    throw new Error(`unknown agent "${raw}" — use ${CONFIG_AGENTS.join(", ")}`);
  }
  return match;
}

export function supportsEffort(model: string): boolean {
  return !MODELS_WITHOUT_EFFORT.has(model);
}

export function applySettings(config: WorkerConfig, settings: Settings): void {
  config.monitor.model = settings.monitor.model;
  config.monitor.effort = settings.monitor.effort;
  config.monitor.intervalMs = Math.round(settings.monitor.intervalMinutes * 60_000);
  config.monitor.schedule = buildSchedule(
    settings.monitor.activeHours,
    settings.monitor.activeDays,
  );
  config.monitor.sessionTimeoutMs = settings.monitor.sessionTimeoutMs;
  config.monitor.mcpServers = settings.monitor.mcpServers;
  config.executor.model = settings.executor.model;
  config.executor.effort = settings.executor.effort;
  config.executor.sessionTimeoutMs = settings.executor.sessionTimeoutMs;
  config.executor.maxTaskAttempts = settings.executor.maxTaskAttempts;
  config.executor.retryDelayMs = settings.executor.retryDelayMs;
  config.executor.mcpServers = settings.executor.mcpServers;
  config.summarizer.model = settings.summarizer.model;
  config.summarizer.effort = settings.summarizer.effort;
  config.summarizer.sessionTimeoutMs = settings.summarizer.sessionTimeoutMs;
  config.streamPartial = settings.streamPartial;
  config.browser = settings.browser;
  config.shutdownGraceMs = settings.shutdownGraceMs;
  config.mcpServers = settings.mcpServers;
}

export interface SettingsController {
  current(): Promise<Settings>;
  patch(patch: SettingsPatch): Promise<Settings>;
  setModel(agent: ConfigAgent, model: string): Promise<void>;
  setEffort(agent: ConfigAgent, effort: string): Promise<void>;
  setIntervalMinutes(minutes: number): Promise<void>;
  setActiveHours(spec: string | null): Promise<void>;
  setActiveDays(spec: string | null): Promise<void>;
}

export interface SettingsControllerOptions {
  config: WorkerConfig;
  settingsFile: string;
}

export function createSettingsController({
  config,
  settingsFile,
}: SettingsControllerOptions): SettingsController {
  const persist = async (
    mutate: (raw: Record<string, unknown>) => void,
  ): Promise<Settings> => {
    const settings = await patchSettings(settingsFile, mutate);
    applySettings(config, settings);
    return settings;
  };

  return {
    current: () => loadSettings(settingsFile),
    patch: (patch) =>
      persist((raw) => {
        mergeSettingsPatch(raw, patch);
      }),
    async setModel(agent, model) {
      if (!(MODELS as readonly string[]).includes(model)) {
        throw new Error(`unknown model "${model}" — use ${MODELS.join(", ")}`);
      }
      await persist((raw) => {
        settingsSection(raw, agent).model = model;
      });
    },
    async setEffort(agent, effort) {
      const level = EFFORT_LEVELS.find((candidate) => candidate === effort);
      if (level === undefined) {
        throw new Error(`unknown effort "${effort}" — use ${EFFORT_LEVELS.join(", ")}`);
      }
      if (!supportsEffort(config[agent].model)) {
        throw new Error(
          `${config[agent].model} has no reasoning effort level — switch the ${agent} model first`,
        );
      }
      await persist((raw) => {
        settingsSection(raw, agent).effort = level;
      });
    },
    async setIntervalMinutes(minutes) {
      if (!Number.isFinite(minutes) || minutes <= 0) {
        throw new Error("interval must be a positive number of minutes");
      }
      await persist((raw) => {
        settingsSection(raw, "monitor").intervalMinutes = minutes;
      });
    },
    async setActiveHours(spec) {
      if (spec !== null) parseTimeWindow(spec);
      await persist((raw) => {
        const monitor = settingsSection(raw, "monitor");
        if (spec === null) delete monitor.activeHours;
        else monitor.activeHours = spec;
      });
    },
    async setActiveDays(spec) {
      if (spec !== null) parseActiveDays(spec);
      await persist((raw) => {
        const monitor = settingsSection(raw, "monitor");
        if (spec === null) delete monitor.activeDays;
        else monitor.activeDays = spec;
      });
    },
  };
}

import { Box, useInput, useStdin } from "ink";
import type { JSX } from "react";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { PROMPT_FILE_LABELS } from "../config.js";
import type { ContextFileAccess } from "../context-file.js";
import type { PromptFileAccess } from "../prompt-files.js";
import type { SettingsController } from "../settings-controller.js";
import type { WorkerStatusStore } from "../status.js";
import type { WorkerConfig } from "../types.js";
import type { Waker } from "../waker.js";
import { executorPanelModel, monitorPanelModel } from "./agent-visuals.js";
import { CommandInput } from "./command-input.js";
import { CommandSuggestions, SUGGESTION_WINDOW } from "./command-suggestions.js";
import {
  argumentGhost,
  commandMenu,
  dispatchCommand,
  type AgentControls,
  type CommandContext,
  type DrainControls,
  type MemoryReader,
  type TaskControls,
  type View,
} from "./commands.js";
import { Header, headerBanners } from "./header.js";
import type { KeyHint } from "./key-hints.js";
import { computeLayout } from "./layout.js";
import { lineEdits, readlineEdit, type LineEdit } from "./line-editing.js";
import { PromptEditor } from "./prompt-editor.js";
import { maxListOffset, PANEL_BORDER_ROWS } from "./scroll.js";
import { AnimationProvider } from "./spinner.js";
import { StatusBar, type Notice } from "./status-bar.js";
import { taskRows } from "./task-table.js";
import { useNow } from "./use-now.js";
import { useTerminalSize } from "./use-terminal-size.js";
import { AgentView } from "./views/agent-view.js";
import { configRows, ConfigView } from "./views/config-view.js";
import { agentSubtitle, DashboardView, type PanelId } from "./views/dashboard-view.js";
import { helpRows, HelpView } from "./views/help-view.js";
import { MemoryView } from "./views/memory-view.js";
import { TasksView } from "./views/tasks-view.js";

const SCROLL_PAGE_MARGIN = 6;
const HISTORY_LIMIT = 50;
const NOTICE_TIMEOUT_MS = 5_000;

type ListId = "tasks" | "memory" | "config" | "help";
type ScrollId = PanelId | ListId;

const NO_SCROLL: Record<ScrollId, number> = {
  monitor: 0,
  executor: 0,
  tasks: 0,
  memory: 0,
  config: 0,
  help: 0,
};

interface InputState {
  value: string;
  cursor: number;
  history: readonly string[];
  historyIndex: number | null;
  draft: string;
}

const EMPTY_INPUT: InputState = {
  value: "",
  cursor: 0,
  history: [],
  historyIndex: null,
  draft: "",
};

function withValue(state: InputState, value: string): InputState {
  return { ...state, value, cursor: value.length, historyIndex: null, draft: "" };
}

function applyEdit(state: InputState, edit: LineEdit): InputState {
  return { ...state, ...edit({ value: state.value, cursor: state.cursor }) };
}

function historyUp(state: InputState): InputState {
  if (state.history.length === 0) return state;
  if (state.historyIndex === null) {
    const index = state.history.length - 1;
    const value = state.history[index] ?? "";
    return {
      ...state,
      value,
      cursor: value.length,
      historyIndex: index,
      draft: state.value,
    };
  }
  if (state.historyIndex === 0) return state;
  const index = state.historyIndex - 1;
  const value = state.history[index] ?? "";
  return { ...state, value, cursor: value.length, historyIndex: index };
}

function historyDown(state: InputState): InputState {
  if (state.historyIndex === null) return state;
  if (state.historyIndex >= state.history.length - 1) {
    return {
      ...state,
      value: state.draft,
      cursor: state.draft.length,
      historyIndex: null,
      draft: "",
    };
  }
  const index = state.historyIndex + 1;
  const value = state.history[index] ?? "";
  return { ...state, value, cursor: value.length, historyIndex: index };
}

function submitToHistory(state: InputState, line: string): InputState {
  const history =
    state.history[state.history.length - 1] === line
      ? state.history
      : [...state.history, line].slice(-HISTORY_LIMIT);
  return { ...EMPTY_INPUT, history };
}

function scrollIdFor(view: View, focusedPanel: PanelId): ScrollId | null {
  switch (view.kind) {
    case "dashboard":
      return focusedPanel;
    case "monitor":
    case "executor":
    case "tasks":
    case "memory":
    case "config":
    case "help":
      return view.kind;
    case "prompt":
    case "context":
      return null;
  }
}

function keyHints(view: View, menuOpen: boolean, expanded: boolean): KeyHint[] {
  if (menuOpen) {
    return [
      ["↑↓", "select"],
      ["tab", "complete"],
      ["enter", "run"],
      ["esc", "clear"],
    ];
  }
  const expand: KeyHint = ["ctrl+o", expanded ? "collapse" : "expand"];
  switch (view.kind) {
    case "dashboard":
      return [["tab", "focus"], ["pgup/pgdn", "scroll"], expand, ["/", "commands"]];
    case "monitor":
    case "executor":
      return [["pgup/pgdn", "scroll"], expand, ["/dashboard", "back"]];
    default:
      return [
        ["pgup/pgdn", "scroll"],
        ["/dashboard", "back"],
      ];
  }
}

export interface AppProps {
  store: WorkerStatusStore;
  config: WorkerConfig;
  version: string;
  controls: { monitor: AgentControls; executor: AgentControls };
  drain: DrainControls;
  tasks: TaskControls;
  memory: MemoryReader;
  settings: SettingsController;
  prompts: PromptFileAccess;
  context: ContextFileAccess;
  waker: Pick<Waker, "notify">;
  requestExit: () => void;
  noticeTimeoutMs?: number | undefined;
  animate?: boolean | undefined;
}

export function App({
  store,
  config,
  version,
  controls,
  drain,
  tasks,
  memory,
  settings,
  prompts,
  context,
  waker,
  requestExit,
  noticeTimeoutMs = NOTICE_TIMEOUT_MS,
  animate = true,
}: AppProps): JSX.Element {
  const status = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const { columns, rows } = useTerminalSize();
  const now = useNow();
  const { isRawModeSupported } = useStdin();
  const interactive = (isRawModeSupported as boolean | undefined) === true;

  const [view, setView] = useState<View>({ kind: "dashboard" });
  const [input, setInput] = useState<InputState>(EMPTY_INPUT);
  const [notice, setNotice] = useState<Notice | null>(() =>
    controls.monitor.state === "running" && controls.executor.state === "running"
      ? null
      : { text: "agents are paused — run /start to wake them", tone: "info" },
  );
  const [focusedPanel, setFocusedPanel] = useState<PanelId>("monitor");
  const [expanded, setExpanded] = useState(false);
  const [scrollOffsets, setScrollOffsets] = useState<Record<ScrollId, number>>(NO_SCROLL);
  const [selectedSuggestion, setSelectedSuggestion] = useState(0);
  const [menuValue, setMenuValue] = useState(input.value);

  const menu = useMemo(() => commandMenu(input.value), [input.value]);
  const menuOpen = interactive && menu.items.length > 0 && input.historyIndex === null;
  const ghost = interactive ? argumentGhost(input.value) : undefined;

  if (menuValue !== input.value) {
    setMenuValue(input.value);
    setSelectedSuggestion(0);
  }

  useEffect(() => {
    if (notice === null) return;
    const timer = setTimeout(() => {
      setNotice(null);
    }, noticeTimeoutMs);
    return () => {
      clearTimeout(timer);
    };
  }, [notice, noticeTimeoutMs]);

  const ctx = useMemo<CommandContext>(
    () => ({
      setView: (next) => {
        setView(next);
        setScrollOffsets((current) => ({
          ...current,
          tasks: 0,
          memory: 0,
          config: 0,
          help: 0,
        }));
      },
      monitorControl: controls.monitor,
      executorControl: controls.executor,
      drain,
      tasks,
      memory,
      settings,
      prompts,
      context,
      waker,
      requestExit,
      notice: (text, tone = "info") => {
        setNotice({ text, tone });
      },
    }),
    [controls, drain, tasks, memory, settings, prompts, context, waker, requestExit],
  );

  const editing = view.kind === "prompt" || view.kind === "context";

  const saveFile = (written: Promise<void>, savedText: string): void => {
    void written
      .then(() => {
        setView({ kind: "dashboard" });
        setNotice({ text: savedText, tone: "ok" });
      })
      .catch((err: unknown) => {
        setNotice({
          text: err instanceof Error ? err.message : String(err),
          tone: "error",
        });
      });
  };

  const banners = headerBanners(status, now);
  const layout = computeLayout({
    rows,
    columns,
    interactive,
    editing,
    menuRows: menuOpen ? Math.min(menu.items.length, SUGGESTION_WINDOW) : 0,
    bannerRows: banners.length,
  });
  const { contentHeight } = layout;
  const scrollId = scrollIdFor(view, focusedPanel);

  const listLength = (id: ListId): number => {
    switch (id) {
      case "tasks":
        return taskRows(status.tasks).length;
      case "memory":
        return view.kind === "memory" ? view.entries.length : 0;
      case "config":
        return configRows(config, columns).length;
      case "help":
        return helpRows(columns).length;
    }
  };

  const scroll = (direction: 1 | -1): void => {
    if (scrollId === null) return;
    const step = Math.max(1, contentHeight - SCROLL_PAGE_MARGIN);
    const panel = scrollId === "monitor" || scrollId === "executor";
    const maxOffset = panel
      ? Math.max(0, status[scrollId].tail.length * 4 - 1)
      : maxListOffset(listLength(scrollId), contentHeight - PANEL_BORDER_ROWS);
    const delta = panel ? direction * step : -direction * step;
    setScrollOffsets((current) => ({
      ...current,
      [scrollId]: Math.min(Math.max(0, current[scrollId] + delta), maxOffset),
    }));
  };

  useInput(
    (rawInput, key) => {
      if (key.ctrl && rawInput === "c") {
        process.kill(process.pid, "SIGINT");
        return;
      }
      if (key.ctrl && rawInput === "o") {
        setExpanded((current) => !current);
        return;
      }
      if (key.return) {
        const typed = input.value.trim();
        if (!typed.startsWith("/")) return;
        const chosen = menuOpen ? menu.items[selectedSuggestion] : undefined;
        const typedIsExact = menu.items.some((item) => item.apply === typed);
        const completes = menu.argument ? menu.matchLength > 0 : !typedIsExact;
        const line = chosen !== undefined && completes ? chosen.apply.trim() : typed;
        setInput((current) => submitToHistory(current, line));
        setNotice(null);
        void dispatchCommand(line, ctx);
        return;
      }
      if (key.upArrow) {
        if (menuOpen) {
          setSelectedSuggestion(
            (current) => (current - 1 + menu.items.length) % menu.items.length,
          );
          return;
        }
        setInput(historyUp);
        return;
      }
      if (key.downArrow) {
        if (menuOpen) {
          setSelectedSuggestion((current) => (current + 1) % menu.items.length);
          return;
        }
        setInput(historyDown);
        return;
      }
      if (key.tab) {
        if (menuOpen) {
          const chosen = menu.items[selectedSuggestion];
          if (chosen !== undefined)
            setInput((current) => withValue(current, chosen.apply));
          return;
        }
        if (view.kind === "dashboard" && input.value === "") {
          setFocusedPanel((current) => (current === "monitor" ? "executor" : "monitor"));
        }
        return;
      }
      if (key.pageUp || key.pageDown) {
        scroll(key.pageUp ? 1 : -1);
        return;
      }
      if (key.escape) {
        if (input.value !== "") {
          setInput((current) => withValue(current, ""));
          return;
        }
        setScrollOffsets(NO_SCROLL);
        return;
      }
      const edit = readlineEdit(rawInput, key);
      if (edit !== undefined) {
        setInput((current) => applyEdit(current, edit));
        return;
      }
      if (rawInput.length > 0 && !key.ctrl && !key.meta) {
        setInput((current) => applyEdit(current, lineEdits.insert(rawInput)));
      }
    },
    { isActive: interactive && !editing },
  );

  const monitorModel = monitorPanelModel(status.monitor, now);
  const executorModel = executorPanelModel(status.executor, now);

  const content = ((): JSX.Element => {
    switch (view.kind) {
      case "dashboard":
        return (
          <DashboardView
            status={status}
            config={config}
            width={columns}
            height={contentHeight}
            now={now}
            interactive={interactive}
            narrow={layout.narrow}
            focusedPanel={focusedPanel}
            scrollOffsets={scrollOffsets}
            expanded={expanded}
          />
        );
      case "monitor":
        return (
          <AgentView
            title="Monitor"
            subtitle={agentSubtitle(config, "monitor")}
            model={monitorModel}
            width={columns}
            height={contentHeight}
            scrollOffset={scrollOffsets.monitor}
            expanded={expanded}
          />
        );
      case "executor":
        return (
          <AgentView
            title="Executor"
            subtitle={agentSubtitle(config, "executor")}
            model={executorModel}
            width={columns}
            height={contentHeight}
            scrollOffset={scrollOffsets.executor}
            expanded={expanded}
          />
        );
      case "tasks":
        return (
          <TasksView
            tasks={status.tasks}
            height={contentHeight}
            now={now}
            offset={scrollOffsets.tasks}
          />
        );
      case "memory":
        return (
          <MemoryView
            entries={view.entries}
            query={view.query}
            height={contentHeight}
            now={now}
            offset={scrollOffsets.memory}
          />
        );
      case "config":
        return (
          <ConfigView
            config={config}
            width={columns}
            height={contentHeight}
            offset={scrollOffsets.config}
          />
        );
      case "prompt":
        return (
          <PromptEditor
            title={`${view.agent} prompt`}
            subtitle={`.kikimora/prompts/${view.agent}.prompt.md`}
            submitLabel="save"
            cancelLabel="close without saving"
            initialValue={view.content}
            width={columns}
            maxVisibleLines={Math.max(4, contentHeight - 3)}
            fill
            error={notice?.tone === "error" ? notice.text : undefined}
            onSubmit={(value) => {
              saveFile(
                prompts.write(view.agent, value),
                `${view.agent} prompt saved — applies from the next session`,
              );
            }}
            onCancel={() => {
              setView({ kind: "dashboard" });
            }}
          />
        );
      case "context":
        return (
          <PromptEditor
            title="context"
            subtitle={PROMPT_FILE_LABELS.contextPath}
            submitLabel="save"
            cancelLabel="close without saving"
            initialValue={view.content}
            width={columns}
            maxVisibleLines={Math.max(4, contentHeight - 3)}
            fill
            error={notice?.tone === "error" ? notice.text : undefined}
            onSubmit={(value) => {
              saveFile(
                context.write(value),
                "context saved — applies from the next session",
              );
            }}
            onCancel={() => {
              setView({ kind: "dashboard" });
            }}
          />
        );
      case "help":
        return (
          <HelpView width={columns} height={contentHeight} offset={scrollOffsets.help} />
        );
    }
  })();

  return (
    <AnimationProvider value={animate}>
      <Box flexDirection="column" height={rows}>
        <Header
          config={config}
          version={version}
          status={status}
          banners={banners}
          now={now}
        />
        {content}
        {menuOpen ? (
          <CommandSuggestions
            items={menu.items}
            selected={selectedSuggestion}
            matchLength={menu.matchLength}
          />
        ) : null}
        {layout.showPrompt ? (
          <CommandInput value={input.value} cursor={input.cursor} ghost={ghost} />
        ) : null}
        {layout.showStatusBar ? (
          <StatusBar
            viewName={view.kind}
            agents={[
              ["monitor", monitorModel.status],
              ["executor", executorModel.status],
            ]}
            notice={notice}
            hints={interactive ? keyHints(view, menuOpen, expanded) : []}
            width={columns}
          />
        ) : null}
      </Box>
    </AnimationProvider>
  );
}

import { Box, Text, useInput, useStdin } from "ink";
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
  dispatchCommand,
  suggestions,
  type AgentControls,
  type CommandContext,
  type DrainControls,
  type MemoryReader,
  type NoticeTone,
  type TaskControls,
  type View,
} from "./commands.js";
import { Header } from "./header.js";
import { PromptEditor } from "./prompt-editor.js";
import { theme } from "./theme.js";
import { useNow } from "./use-now.js";
import { useTerminalSize } from "./use-terminal-size.js";
import { AgentView } from "./views/agent-view.js";
import { ConfigView } from "./views/config-view.js";
import { DashboardView, type PanelId } from "./views/dashboard-view.js";
import { HelpView } from "./views/help-view.js";
import { MemoryView } from "./views/memory-view.js";
import { TasksView } from "./views/tasks-view.js";

const HEADER_HEIGHT = 6;
const INPUT_HEIGHT = 3;
const SCROLL_PAGE_MARGIN = 6;
const HISTORY_LIMIT = 50;
const NOTICE_TIMEOUT_MS = 5_000;

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

interface Notice {
  text: string;
  tone: NoticeTone;
}

function withValue(state: InputState, value: string): InputState {
  return { ...state, value, cursor: value.length, historyIndex: null, draft: "" };
}

function insertAtCursor(state: InputState, text: string): InputState {
  const value =
    state.value.slice(0, state.cursor) + text + state.value.slice(state.cursor);
  return { ...state, value, cursor: state.cursor + text.length };
}

function deleteBeforeCursor(state: InputState): InputState {
  if (state.cursor === 0) return state;
  const value = state.value.slice(0, state.cursor - 1) + state.value.slice(state.cursor);
  return { ...state, value, cursor: state.cursor - 1 };
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
  const [scrollOffsets, setScrollOffsets] = useState<Record<PanelId, number>>({
    monitor: 0,
    executor: 0,
  });
  const [selectedSuggestion, setSelectedSuggestion] = useState(0);
  const [menuValue, setMenuValue] = useState(input.value);

  const suggestionList = useMemo(() => suggestions(input.value), [input.value]);
  const menuOpen =
    interactive && suggestionList.length > 0 && input.historyIndex === null;
  const matchLength = menuOpen ? input.value.length - 1 : 0;

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
      setView,
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
        setNotice({ text: savedText, tone: "info" });
      })
      .catch((err: unknown) => {
        setNotice({
          text: err instanceof Error ? err.message : String(err),
          tone: "error",
        });
      });
  };

  const noticeHeight = notice === null ? 0 : 1;
  const hintHeight = interactive && !editing ? 1 : 0;
  const inputHeight = interactive && !editing ? INPUT_HEIGHT : 0;
  const menuHeight = menuOpen ? Math.min(suggestionList.length, SUGGESTION_WINDOW) : 0;
  const shutdownHeight = status.shutdownSignal === undefined ? 0 : 1;
  const headerHeight =
    HEADER_HEIGHT +
    (status.drain === undefined ? 0 : 1) +
    (status.update === undefined ? 0 : 1);
  const contentHeight = Math.max(
    6,
    rows -
      headerHeight -
      inputHeight -
      menuHeight -
      hintHeight -
      noticeHeight -
      shutdownHeight,
  );

  const scrollTarget: PanelId | null =
    view.kind === "dashboard"
      ? focusedPanel
      : view.kind === "monitor" || view.kind === "executor"
        ? view.kind
        : null;

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
        const chosen = menuOpen ? suggestionList[selectedSuggestion] : undefined;
        const typedIsExact = suggestionList.some((item) => `/${item.name}` === typed);
        const line = chosen === undefined || typedIsExact ? typed : `/${chosen.name}`;
        setInput((current) => submitToHistory(current, line));
        setNotice(null);
        void dispatchCommand(line, ctx);
        return;
      }
      if (key.backspace || key.delete) {
        setInput(deleteBeforeCursor);
        return;
      }
      if (key.upArrow) {
        if (menuOpen) {
          setSelectedSuggestion(
            (current) => (current - 1 + suggestionList.length) % suggestionList.length,
          );
          return;
        }
        setInput(historyUp);
        return;
      }
      if (key.downArrow) {
        if (menuOpen) {
          setSelectedSuggestion((current) => (current + 1) % suggestionList.length);
          return;
        }
        setInput(historyDown);
        return;
      }
      if (key.leftArrow) {
        setInput((current) => ({ ...current, cursor: Math.max(0, current.cursor - 1) }));
        return;
      }
      if (key.rightArrow) {
        setInput((current) => ({
          ...current,
          cursor: Math.min(current.value.length, current.cursor + 1),
        }));
        return;
      }
      if (key.tab) {
        if (menuOpen) {
          const chosen = suggestionList[selectedSuggestion];
          if (chosen !== undefined)
            setInput((current) => withValue(current, `/${chosen.name}`));
          return;
        }
        if (view.kind === "dashboard" && input.value === "") {
          setFocusedPanel((current) => (current === "monitor" ? "executor" : "monitor"));
        }
        return;
      }
      if (key.pageUp || key.pageDown) {
        if (scrollTarget === null) return;
        const step = Math.max(1, contentHeight - SCROLL_PAGE_MARGIN);
        const direction = key.pageUp ? 1 : -1;
        const maxOffset = Math.max(0, status[scrollTarget].tail.length * 4 - 1);
        setScrollOffsets((current) => ({
          ...current,
          [scrollTarget]: Math.min(
            Math.max(0, current[scrollTarget] + direction * step),
            maxOffset,
          ),
        }));
        return;
      }
      if (key.escape) {
        if (input.value !== "") {
          setInput((current) => ({ ...current, ...withValue(current, "") }));
          return;
        }
        setScrollOffsets({ monitor: 0, executor: 0 });
        return;
      }
      if (rawInput.length > 0 && !key.ctrl && !key.meta) {
        setInput((current) => insertAtCursor(current, rawInput));
      }
    },
    { isActive: interactive && !editing },
  );

  const content = ((): JSX.Element => {
    switch (view.kind) {
      case "dashboard":
        return (
          <DashboardView
            status={status}
            width={columns}
            height={contentHeight}
            now={now}
            interactive={interactive}
            focusedPanel={focusedPanel}
            scrollOffsets={scrollOffsets}
            expanded={expanded}
          />
        );
      case "monitor":
        return (
          <AgentView
            title="Monitor"
            model={monitorPanelModel(status.monitor, now)}
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
            model={executorPanelModel(status.executor, now)}
            width={columns}
            height={contentHeight}
            scrollOffset={scrollOffsets.executor}
            expanded={expanded}
          />
        );
      case "tasks":
        return <TasksView tasks={status.tasks} height={contentHeight} now={now} />;
      case "memory":
        return (
          <MemoryView
            entries={view.entries}
            query={view.query}
            height={contentHeight}
            now={now}
          />
        );
      case "config":
        return <ConfigView config={config} height={contentHeight} />;
      case "prompt":
        return (
          <PromptEditor
            title={`${view.agent} prompt (.brownie/prompts/${view.agent}.prompt.md)`}
            hint="Enter: new line · Ctrl+D: save · Esc: close without saving"
            initialValue={view.content}
            maxVisibleLines={Math.max(4, contentHeight - 4)}
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
            title={PROMPT_FILE_LABELS.contextPath}
            hint="Enter: new line · Ctrl+D: save · Esc: close without saving"
            initialValue={view.content}
            maxVisibleLines={Math.max(4, contentHeight - 4)}
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
        return <HelpView width={columns} height={contentHeight} />;
    }
  })();

  return (
    <Box flexDirection="column" height={rows}>
      <Header config={config} version={version} status={status} now={now} />
      {content}
      {notice === null ? null : (
        <Text
          color={notice.tone === "error" ? theme.error : theme.muted}
          wrap="truncate-end"
        >
          {notice.text}
        </Text>
      )}
      {menuOpen ? (
        <CommandSuggestions
          suggestions={suggestionList}
          selected={selectedSuggestion}
          matchLength={matchLength}
        />
      ) : null}
      {interactive && !editing ? (
        <CommandInput value={input.value} cursor={input.cursor} />
      ) : null}
      {interactive && !editing ? (
        <Text dimColor wrap="truncate-end">
          {`${view.kind} · /help commands & keys · ctrl+c quit${expanded ? " · expanded output (ctrl+o)" : ""}`}
        </Text>
      ) : null}
      {status.shutdownSignal === undefined ? null : (
        <Text color={theme.warn}>Received {status.shutdownSignal} — shutting down…</Text>
      )}
    </Box>
  );
}

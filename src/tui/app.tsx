import { Box, Text, useApp, useInput, useStdout } from "ink";
import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { ProjectInfo } from "../core/scan/detect.js";
import { completeMention, fuzzyFiles, parseCommand } from "./commands.js";
import { CommandBar, computeSuggestions } from "./components/commandbar.js";
import { Header, Help, StatusLine } from "./components/layout.js";
import { Details, FileList, ReportOnly } from "./components/list.js";
import { DoneView, ReviewView, RunView } from "./components/run.js";
import { displayOutDir, type Session } from "./session.js";
import { PRESET_CYCLE, initialState, reducer, rowAt, type State } from "./state.js";

const FRAMEWORK_NAMES: Record<string, string> = {
  next: "Next.js",
  astro: "Astro",
  vite: "Vite",
  static: "static site",
};

export interface AppProps {
  session: Session;
  project: ProjectInfo;
  projectRoot: string;
  /** Paths being scanned, for the header. */
  inputs: string[];
  outDir: string;
  /** Formatted `doctor` report, loaded on demand for /doctor. */
  loadDoctor: () => Promise<string>;
}

export function App(props: AppProps): ReactNode {
  const { session, project, projectRoot } = props;
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [state, dispatch] = useReducer(reducer, props.outDir, initialState);
  const [doctor, setDoctor] = useState<string | null>(null);

  // Handlers read the latest state without re-subscribing the input listener.
  const stateRef = useRef<State>(state);
  stateRef.current = state;
  const abortRef = useRef<AbortController | null>(null);

  const term = stdout as NodeJS.WriteStream | undefined;
  const rows = term?.rows ?? 24;
  const columns = term?.columns ?? 100;
  const listHeight = Math.max(5, rows - 12);

  // --- scan ---------------------------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const { model, files } = await session.scan(
          stateRef.current.outDir,
          stateRef.current.presets,
          (p) => {
            if (!cancelled) dispatch({ type: "scan-progress", ...p });
          },
        );
        if (!cancelled) dispatch({ type: "scan-done", model, files });
      } catch (error) {
        if (!cancelled) {
          dispatch({
            type: "fatal",
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [session, state.scanId]);

  // --- actions ------------------------------------------------------------------------
  const startReview = useCallback(
    async (only?: string[]) => {
      const s = stateRef.current;
      const sources =
        only ?? s.model.rows.filter((r) => s.selected.has(r.source)).map((r) => r.source);
      if (sources.length === 0) {
        dispatch({ type: "status", message: "Nothing selected: press space to select files." });
        return;
      }
      dispatch({ type: "status", message: "Planning…" });
      try {
        const review = await session.review(sources, s.presets, s.outDir);
        dispatch({ type: "review-ready", review });
      } catch (error) {
        dispatch({
          type: "status",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    },
    [session],
  );

  const startRun = useCallback(async () => {
    const s = stateRef.current;
    if (!s.review) return;
    const sources = s.review.items.filter((i) => i.state === "encode").map((i) => i.source);
    if (sources.length === 0) {
      dispatch({ type: "status", message: "Everything is already up to date." });
      return;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    dispatch({ type: "run-start", total: sources.length });
    try {
      const result = await session.run(
        sources,
        s.presets,
        s.outDir,
        {
          onItemStart: (source) => dispatch({ type: "run-item-start", source }),
          onOutput: (source, output) => dispatch({ type: "run-output", source, output }),
          onItemDone: () => dispatch({ type: "run-item-done" }),
        },
        controller.signal,
      );
      dispatch({ type: "run-done", result });
    } catch (error) {
      dispatch({ type: "fatal", error: error instanceof Error ? error.message : String(error) });
    } finally {
      abortRef.current = null;
    }
  }, [session]);

  const cancelRun = useCallback(() => {
    dispatch({ type: "cancel" });
    abortRef.current?.abort();
  }, []);

  const applyOutDir = useCallback(
    async (text: string) => {
      const value = text.trim();
      if (!value) return;
      const s = stateRef.current;
      const reason = await session.validateOutDir(
        value,
        s.model.rows.map((r) => r.source),
      );
      if (reason) {
        dispatch({ type: "status", message: reason });
        return;
      }
      dispatch({ type: "set-out-dir", outDir: displayOutDir(projectRoot, value) });
      dispatch({ type: "rescan" });
    },
    [session, projectRoot],
  );

  const resolveMentions = useCallback((mentions: string[]): string[] => {
    const known = stateRef.current.model.rows.map((r) => r.source);
    const out: string[] = [];
    for (const m of mentions) {
      const hit = known.includes(m) ? m : fuzzyFiles(m, known, 1)[0];
      if (hit) out.push(hit);
    }
    return out;
  }, []);

  const execute = useCallback(
    async (text: string) => {
      const s = stateRef.current;
      if (!text.trim().startsWith("/")) {
        // A bare @mention jumps to that file.
        const mention = /@(\S+)/.exec(text)?.[1];
        const [hit] = mention ? resolveMentions([mention]) : [];
        dispatch({ type: "overlay", overlay: null });
        if (hit) dispatch({ type: "cursor-to", source: hit });
        else dispatch({ type: "status", message: "No such file in the list." });
        return;
      }
      const parsed = parseCommand(text);
      if (!parsed.ok) {
        dispatch({ type: "status", message: parsed.error });
        return;
      }
      const targets = resolveMentions(parsed.mentions);
      dispatch({ type: "overlay", overlay: null });
      switch (parsed.name) {
        case "audit":
          dispatch({ type: "rescan" });
          return;
        case "optimize":
          if (targets.length > 0) dispatch({ type: "select-files", sources: targets });
          await startReview(targets.length > 0 ? targets : undefined);
          return;
        case "preset": {
          const name = parsed.args[0];
          if (!name || !(PRESET_CYCLE as readonly string[]).includes(name)) {
            dispatch({
              type: "status",
              message: `Usage: /preset <${PRESET_CYCLE.join("|")}> [@file…]`,
            });
            return;
          }
          const sources = targets.length > 0 ? targets : rowAt(s) ? [rowAt(s)!.source] : [];
          dispatch({ type: "cycle-preset", sources, to: name });
          return;
        }
        case "out":
          if (parsed.args[0]) await applyOutDir(parsed.args[0]);
          else dispatch({ type: "status", message: "Usage: /out <dir>" });
          return;
        case "select": {
          const mode = parsed.args[0];
          if (mode === "all" || mode === "none" || mode === "warn") {
            dispatch({ type: "select", mode });
          } else dispatch({ type: "status", message: "Usage: /select <all|none|warn>" });
          return;
        }
        case "doctor":
          dispatch({ type: "overlay", overlay: "doctor" });
          void props.loadDoctor().then(setDoctor);
          return;
        case "help":
          dispatch({ type: "overlay", overlay: "help" });
          return;
        case "quit":
          exit();
          return;
      }
    },
    [applyOutDir, exit, props, resolveMentions, startReview],
  );

  // --- keys ---------------------------------------------------------------------------
  const suggestions = useMemo(
    () => computeSuggestions(state.input, state.files),
    [state.input, state.files],
  );

  useInput((input, key) => {
    const s = stateRef.current;

    if (key.ctrl && input === "c") {
      if (s.view === "running") cancelRun();
      else exit();
      return;
    }

    // A paste arrives as one chunk. Treat it as typing: open the command bar for a leading
    // "/" or "@", append to an open prompt, and submit when it ends with a newline.
    // eslint-disable-next-line no-control-regex
    const clean = (t: string) => t.replace(/[\u0000-\u001f\u007f]/g, "");
    const chunk = input.length > 1 && !key.ctrl && !key.meta ? input : null;
    if (chunk !== null) {
      const submit = /[\r\n]$/.test(chunk);
      const text = clean(chunk);
      if (s.overlay === "command" || s.overlay === "outdir") {
        const next = s.input + text;
        dispatch({ type: "input", text: next });
        if (submit) {
          if (s.overlay === "outdir") void applyOutDir(next);
          else void execute(next);
        }
        return;
      }
      if (!s.overlay && s.view === "list" && (text.startsWith("/") || text.startsWith("@"))) {
        dispatch({ type: "overlay", overlay: "command", input: text });
        if (submit) void execute(text);
        return;
      }
    }

    // Text entry: command bar and the output-folder prompt.
    if (s.overlay === "command" || s.overlay === "outdir") {
      if (key.escape) {
        dispatch({ type: "back" });
      } else if (key.return) {
        if (s.overlay === "outdir") void applyOutDir(s.input);
        else {
          const picked = suggestions.items[s.suggestion];
          // Enter on an unfinished command/mention completes it first, like most shells.
          if (picked && suggestions.kind === "command" && /^\/\S*$/.test(s.input.trim())) {
            const complete = `/${picked.value}`;
            if (s.input.trim() !== complete) {
              dispatch({ type: "input", text: `${complete} ` });
              return;
            }
          }
          void execute(s.input);
        }
      } else if (key.tab) {
        const picked = suggestions.items[s.suggestion];
        if (!picked) return;
        dispatch({
          type: "input",
          text:
            suggestions.kind === "file"
              ? completeMention(s.input, picked.value)
              : `/${picked.value} `,
        });
      } else if (key.upArrow) {
        dispatch({ type: "suggest", delta: -1, max: suggestions.items.length });
      } else if (key.downArrow) {
        dispatch({ type: "suggest", delta: 1, max: suggestions.items.length });
      } else if (key.backspace || key.delete) {
        dispatch({ type: "input", text: s.input.slice(0, -1) });
      } else if (input && !key.ctrl && !key.meta) {
        // eslint-disable-next-line no-control-regex
        dispatch({ type: "input", text: s.input + input.replace(/[\u0000-\u001f\u007f]/g, "") });
      }
      return;
    }

    if (s.overlay) {
      if (key.escape || key.return || input === "q" || input === "?" || input === "d") {
        dispatch({ type: "back" });
      }
      return;
    }

    if (input === "q" && s.view !== "running") {
      exit();
      return;
    }

    switch (s.view) {
      case "list":
        if (key.upArrow || input === "k") dispatch({ type: "move", delta: -1 });
        else if (key.downArrow || input === "j") dispatch({ type: "move", delta: 1 });
        else if (key.pageUp) dispatch({ type: "move", delta: -listHeight });
        else if (key.pageDown) dispatch({ type: "move", delta: listHeight });
        else if (input === " ") dispatch({ type: "toggle" });
        else if (input === "a") dispatch({ type: "toggle-all" });
        else if (input === "p") dispatch({ type: "cycle-preset" });
        else if (input === "d") {
          if (rowAt(s)) dispatch({ type: "overlay", overlay: "details" });
        } else if (input === "o") dispatch({ type: "overlay", overlay: "outdir", input: s.outDir });
        else if (input === "?") dispatch({ type: "overlay", overlay: "help" });
        else if (input === "/") dispatch({ type: "overlay", overlay: "command", input: "/" });
        else if (input === "@") dispatch({ type: "overlay", overlay: "command", input: "@" });
        else if (key.return) void startReview();
        break;
      case "review":
        if (key.return) void startRun();
        else if (key.escape) dispatch({ type: "back" });
        break;
      case "running":
        if (key.escape) cancelRun();
        break;
      case "done":
        if (key.return || key.escape) dispatch({ type: "back" });
        break;
      case "scanning":
      case "error":
        break;
    }
  });

  // --- render -------------------------------------------------------------------------
  const model = state.model;
  const scanLabel = props.inputs.join(", ");
  let body: ReactNode;

  if (state.view === "scanning") {
    const sc = state.scan;
    body = (
      <Text>
        Scanning
        {sc && sc.total > 0
          ? ` ${Math.min(sc.done, sc.total)}/${sc.total} images (${sc.phase})`
          : ""}
        …
      </Text>
    );
  } else if (state.view === "error") {
    body = <Text color="red">{state.error}</Text>;
  } else if (state.view === "review" && state.review) {
    body = <ReviewView review={state.review} outDir={state.outDir} />;
  } else if (state.view === "running") {
    body = <RunView state={state} />;
  } else if (state.view === "done") {
    body = <DoneView state={state} />;
  } else if (state.overlay === "help") {
    body = <Help />;
  } else if (state.overlay === "details") {
    body = <Details state={state} row={rowAt(state)} />;
  } else if (state.overlay === "doctor") {
    body = (
      <Box flexDirection="column" borderStyle="round" paddingX={1}>
        <Text>{doctor ?? "Checking…"}</Text>
        <Text dimColor>esc closes this</Text>
      </Box>
    );
  } else {
    body = (
      <Box flexDirection="column">
        <FileList state={state} height={listHeight} width={columns} />
        <ReportOnly findings={model.reportOnly} skipped={model.skipped} />
        {model.notes.map((n) => (
          <Text key={n} dimColor>
            {n}
          </Text>
        ))}
        {state.overlay === "command" ? (
          <Box marginTop={1}>
            <CommandBar
              prompt="›"
              input={state.input}
              suggestions={suggestions}
              selected={state.suggestion}
              hint="tab completes · enter runs · esc cancels · @ mentions a file"
            />
          </Box>
        ) : null}
        {state.overlay === "outdir" ? (
          <Box marginTop={1}>
            <CommandBar
              prompt="Output folder:"
              input={state.input}
              suggestions={{ kind: "none", items: [] }}
              selected={0}
              hint="enter applies (the project is rescanned) · esc cancels"
            />
          </Box>
        ) : null}
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Header
        framework={FRAMEWORK_NAMES[project.framework] ?? project.framework}
        scanning={scanLabel}
        outDir={state.outDir}
      />
      {body}
      <StatusLine state={state} model={model} />
    </Box>
  );
}

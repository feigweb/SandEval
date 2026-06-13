import React, { useEffect, useMemo, useState } from "react";
import { Box, Text, render, useApp, useInput } from "ink";
import TextInput from "ink-text-input";
import Spinner from "ink-spinner";
import { runArena } from "./arena.js";
import { packageArenaArtifacts, packageRunArtifacts } from "./artifacts.js";
import { loginModel } from "./auth.js";
import { findModel, getConfigPath, listModelNames, loadConfig, saveConfig } from "./config.js";
import { extractContextMentions, listContextNames } from "./contexts.js";
import { createProvider } from "./providers/index.js";
import { saveArenaReport, saveRunReport } from "./report.js";
import { runTask } from "./runner.js";
import { scoreRun } from "./scorer.js";
import { createStorage } from "./storage.js";
import type { ArenaReport, RunEvent, RunReport, SandEvalConfig, StoredRunSummary } from "./types.js";
import { stringifyError, truncate } from "./utils.js";

type Screen = "home" | "run" | "arena" | "config" | "history" | "login" | "result" | "error";
type RunMode = "single" | "arena";

interface AppState {
  screen: Screen;
  selectedModel: string;
  selectedModels: string[];
  selectedContexts: string[];
  prompt: string;
  review: string;
  score: boolean;
  busy: boolean;
  status: string;
  error?: string;
  result?: RunReport | ArenaReport;
  resultMode?: RunMode;
  history: StoredRunSummary[];
  eventLog: RunEvent[];
  reviewDraft: string;
}

const HOME_ITEMS: Array<{ label: string; screen: Screen }> = [
  { label: "Run single model", screen: "run" },
  { label: "Arena comparison", screen: "arena" },
  { label: "Login / auth", screen: "login" },
  { label: "Config", screen: "config" },
  { label: "History", screen: "history" }
];

export async function runTui(cwd: string, configPath?: string): Promise<void> {
  if (!process.stdin.isTTY) {
    throw new Error("SandEval TUI requires an interactive terminal. Run `sandeval tui` without piping stdin.");
  }
  const config = await loadConfig(cwd, configPath);
  const app = render(<SandEvalTui cwd={cwd} configPath={configPath} initialConfig={config} />);
  await app.waitUntilExit();
}

function SandEvalTui(props: { cwd: string; configPath?: string; initialConfig: SandEvalConfig }) {
  const { exit } = useApp();
  const [config, setConfig] = useState(props.initialConfig);
  const models = useMemo(() => listModelNames(config), [config]);
  const contexts = useMemo(() => listContextNames(config), [config]);
  const [state, setState] = useState<AppState>({
    screen: "home",
    selectedModel: models.includes(config.defaultModel ?? "") ? config.defaultModel ?? models[0] ?? "mock/mock-agent" : models[0] ?? "mock/mock-agent",
    selectedModels: config.defaultModel && models.includes(config.defaultModel) ? [config.defaultModel] : models.slice(0, 1),
    selectedContexts: [],
    prompt: "",
    review: "",
    score: config.scoring?.enabled ?? true,
    busy: false,
    status: "Ready",
    history: [],
    eventLog: [],
    reviewDraft: ""
  });

  const theme = config.ui?.theme ?? "sand";
  const colors = {
    accent: theme === "mono" ? "white" : theme === "dark" ? "cyan" : "yellow",
    muted: theme === "mono" ? "gray" : "gray",
    ok: theme === "mono" ? "white" : "green",
    danger: theme === "mono" ? "white" : "red"
  } as const;

  const go = (screen: Screen) => setState((current) => ({ ...current, screen, error: undefined, status: screen === "home" ? "Ready" : current.status }));
  const back = () => {
    if (state.busy) {
      return;
    }
    if (state.screen === "home") {
      exit();
      return;
    }
    go("home");
  };

  useInput((input, key) => {
    if (state.busy) {
      return;
    }
    if (state.screen === "run" || state.screen === "arena" || state.screen === "result") {
      return;
    }
    if (input === "q") {
      exit();
    }
    if (key.escape || input === "b") {
      back();
    }
  });

  async function refreshHistory() {
    try {
      const history = await (await createStorage(config, props.cwd)).listRuns(config.ui?.pageSize ?? 12);
      setState((current) => ({ ...current, history, status: `Loaded ${history.length} history entries` }));
    } catch (error) {
      setState((current) => ({ ...current, error: stringifyError(error), screen: "error" }));
    }
  }

  async function persistConfig(next: SandEvalConfig) {
    const savedPath = await saveConfig(next, props.cwd, props.configPath);
    setConfig({ ...next });
    setState((current) => ({ ...current, status: `Config saved: ${savedPath}` }));
  }

  function appendRunEvent(event: RunEvent) {
    setState((current) => ({
      ...current,
      eventLog: [...current.eventLog, event].slice(-80),
      status: event.message
    }));
  }

  async function runSingle() {
    if (!state.prompt.trim()) {
      setState((current) => ({ ...current, status: "Enter a task prompt first" }));
      return;
    }
    setState((current) => ({
      ...current,
      busy: true,
      eventLog: [],
      status: `Running ${current.selectedModel}`
    }));
    try {
      const report = await runTask({
        config,
        cwd: props.cwd,
        prompt: state.prompt,
        modelName: state.selectedModel,
        score: false,
        onEvent: appendRunEvent,
        contextNames: state.selectedContexts
      });
      const paths = await saveRunReport(report, resolveReportDir(config, props.cwd));
      report.reportPaths = paths;
      await (await createStorage(config, props.cwd)).saveRun(report);
      setState((current) => ({
        ...current,
        busy: false,
        result: report,
        resultMode: "single",
        screen: "result",
        status: `Run complete: ${paths.markdownPath}`
      }));
    } catch (error) {
      setState((current) => ({ ...current, busy: false, error: stringifyError(error), screen: "error" }));
    }
  }

  async function runArenaFlow() {
    if (!state.prompt.trim()) {
      setState((current) => ({ ...current, status: "Enter a task prompt first" }));
      return;
    }
    if (state.selectedModels.length < 2) {
      setState((current) => ({ ...current, status: "Select at least two models for Arena" }));
      return;
    }
    setState((current) => ({
      ...current,
      busy: true,
      eventLog: [],
      status: `Running arena: ${current.selectedModels.join(", ")}`
    }));
    try {
      const report = await runArena({
        config,
        cwd: props.cwd,
        prompt: state.prompt,
        models: state.selectedModels,
        score: false,
        onEvent: appendRunEvent,
        contextNames: state.selectedContexts
      });
      const paths = await saveArenaReport(report, resolveReportDir(config, props.cwd));
      report.reportPaths = paths;
      await (await createStorage(config, props.cwd)).saveArena(report);
      setState((current) => ({
        ...current,
        busy: false,
        result: report,
        resultMode: "arena",
        screen: "result",
        status: `Arena complete: ${paths.markdownPath}`
      }));
    } catch (error) {
      setState((current) => ({ ...current, busy: false, error: stringifyError(error), screen: "error" }));
    }
  }

  async function loginSelected(modelName: string) {
    setState((current) => ({ ...current, busy: true, status: `Logging in ${modelName}` }));
    try {
      const message = await loginModel({ config, cwd: props.cwd, modelName, configPath: props.configPath });
      setState((current) => ({ ...current, busy: false, status: message }));
    } catch (error) {
      setState((current) => ({ ...current, busy: false, error: stringifyError(error), screen: "error" }));
    }
  }

  async function packageCurrentArtifacts() {
    if (!state.result) {
      return;
    }
    setState((current) => ({ ...current, busy: true, status: "Packaging artifacts into current directory" }));
    try {
      const artifactPath =
        state.resultMode === "arena" && "results" in state.result
          ? await packageArenaArtifacts(state.result, props.cwd)
          : await packageRunArtifacts(state.result as RunReport, props.cwd);
      if (state.resultMode === "arena" && "results" in state.result) {
        const paths = await saveArenaReport(state.result, resolveReportDir(config, props.cwd));
        state.result.reportPaths = { ...paths, artifactPath };
        await (await createStorage(config, props.cwd)).saveArena(state.result);
      } else {
        const report = state.result as RunReport;
        const paths = await saveRunReport(report, resolveReportDir(config, props.cwd));
        report.reportPaths = { ...paths, artifactPath };
        await (await createStorage(config, props.cwd)).saveRun(report);
      }
      setState((current) => ({
        ...current,
        busy: false,
        result: state.result,
        status: `Artifacts packaged: ${artifactPath}`
      }));
    } catch (error) {
      setState((current) => ({ ...current, busy: false, error: stringifyError(error), screen: "error" }));
    }
  }

  async function scoreCurrentResult(review: string) {
    if (!state.result) {
      return;
    }
    setState((current) => ({
      ...current,
      busy: true,
      eventLog: [],
      status: "Scoring with judge model"
    }));
    try {
      const judgeConfig = findModel(config, config.judgeModel);
      const judgeProvider = createProvider(judgeConfig);
      const scoreOne = async (report: RunReport) => {
        appendRunEvent({
          type: "score-start",
          at: new Date().toISOString(),
          modelName: judgeConfig.name,
          message: `Scoring ${report.run.modelName} with ${judgeConfig.name}`
        });
        report.userReview = review || undefined;
        report.score = await scoreRun({
          run: report.run,
          provider: judgeProvider,
          modelConfig: judgeConfig,
          userReview: report.userReview
        });
        appendRunEvent({
          type: "score-finish",
          at: new Date().toISOString(),
          modelName: judgeConfig.name,
          level: "success",
          message: `${report.run.modelName} score: ${report.score.score}/100`
        });
      };

      if (state.resultMode === "arena" && "results" in state.result) {
        for (const report of state.result.results) {
          await scoreOne(report);
        }
        const paths = await saveArenaReport(state.result, resolveReportDir(config, props.cwd));
        state.result.reportPaths = { ...state.result.reportPaths, ...paths };
        await (await createStorage(config, props.cwd)).saveArena(state.result);
      } else {
        const report = state.result as RunReport;
        await scoreOne(report);
        const paths = await saveRunReport(report, resolveReportDir(config, props.cwd));
        report.reportPaths = { ...report.reportPaths, ...paths };
        await (await createStorage(config, props.cwd)).saveRun(report);
      }

      setState((current) => ({
        ...current,
        busy: false,
        result: state.result,
        reviewDraft: "",
        status: "Review and scoring complete"
      }));
    } catch (error) {
      setState((current) => ({ ...current, busy: false, error: stringifyError(error), screen: "error" }));
    }
  }

  let body: React.ReactNode;
  if (state.screen === "home") {
    body = <Home colors={colors} onSelect={go} />;
  } else if (state.screen === "run") {
    body = (
      <RunScreen
        colors={colors}
        models={models}
        contexts={contexts}
        cwd={props.cwd}
        state={state}
        setState={setState}
        onRun={runSingle}
        onBack={back}
      />
    );
  } else if (state.screen === "arena") {
    body = (
      <ArenaScreen
        colors={colors}
        models={models}
        contexts={contexts}
        cwd={props.cwd}
        state={state}
        setState={setState}
        onRun={runArenaFlow}
        onBack={back}
      />
    );
  } else if (state.screen === "config") {
    body = <ConfigScreen colors={colors} config={config} models={models} onSave={persistConfig} onBack={back} />;
  } else if (state.screen === "history") {
    body = <HistoryScreen colors={colors} history={state.history} onRefresh={refreshHistory} />;
  } else if (state.screen === "login") {
    body = <LoginScreen colors={colors} models={models} onLogin={loginSelected} />;
  } else if (state.screen === "result") {
    body = (
      <ResultScreen
        colors={colors}
        result={state.result}
        mode={state.resultMode}
        reviewDraft={state.reviewDraft}
        setReviewDraft={(reviewDraft) => setState((current) => ({ ...current, reviewDraft }))}
        onPackage={packageCurrentArtifacts}
        onScore={scoreCurrentResult}
        onBackHome={() => go("home")}
      />
    );
  } else {
    body = <ErrorScreen colors={colors} error={state.error ?? "Unknown error"} />;
  }

  return (
    <Box flexDirection="column" paddingX={1}>
      <Header colors={colors} cwd={props.cwd} configPath={getConfigPath(props.cwd, props.configPath)} />
      <Box borderStyle="round" borderColor={colors.accent} paddingX={1} paddingY={0} minHeight={18} flexDirection="column">
        {state.busy ? (
          <LiveRunPanel colors={colors} status={state.status} events={state.eventLog} />
        ) : (
          body
        )}
      </Box>
      <Footer colors={colors} status={state.status} />
    </Box>
  );
}

function Header(props: { colors: Colors; cwd: string; configPath: string }) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text bold color={props.colors.accent}>
        SandEval
      </Text>
      <Text color={props.colors.muted}>
        cwd {props.cwd} | config {props.configPath}
      </Text>
    </Box>
  );
}

function Footer(props: { colors: Colors; status: string }) {
  return (
    <Box marginTop={1} justifyContent="space-between">
      <Text color={props.colors.muted}>↑↓/j/k move · enter select · b/esc back · q quit · space toggle</Text>
      <Text color={props.colors.accent}>{props.status}</Text>
    </Box>
  );
}

function Home(props: { colors: Colors; onSelect: (screen: Screen) => void }) {
  return (
    <Box flexDirection="column">
      <Text color={props.colors.muted}>Choose a workflow.</Text>
      <Menu
        colors={props.colors}
        items={HOME_ITEMS.map((item) => ({ label: item.label, value: item.screen }))}
        onSelect={(screen) => props.onSelect(screen as Screen)}
      />
    </Box>
  );
}

function RunScreen(props: {
  colors: Colors;
  models: string[];
  contexts: string[];
  cwd: string;
  state: AppState;
  setState: React.Dispatch<React.SetStateAction<AppState>>;
  onRun: () => void;
  onBack: () => void;
}) {
  return (
    <ChatWorkspace
      title="Single"
      mode="single"
      colors={props.colors}
      cwd={props.cwd}
      models={props.models}
      contexts={props.contexts}
      prompt={props.state.prompt}
      selectedModel={props.state.selectedModel}
      selectedModels={props.state.selectedModels}
      selectedContexts={props.state.selectedContexts}
      onPromptChange={(prompt) => props.setState((current) => ({ ...current, prompt }))}
      onModelChange={(selectedModel) => props.setState((current) => ({ ...current, selectedModel }))}
      onModelsChange={(selectedModels) => props.setState((current) => ({ ...current, selectedModels }))}
      onContextsChange={(selectedContexts) => props.setState((current) => ({ ...current, selectedContexts }))}
      onRun={props.onRun}
      onBack={props.onBack}
    />
  );
}

function ArenaScreen(props: {
  colors: Colors;
  models: string[];
  contexts: string[];
  cwd: string;
  state: AppState;
  setState: React.Dispatch<React.SetStateAction<AppState>>;
  onRun: () => void;
  onBack: () => void;
}) {
  return (
    <ChatWorkspace
      title="Arena"
      mode="arena"
      colors={props.colors}
      cwd={props.cwd}
      models={props.models}
      contexts={props.contexts}
      prompt={props.state.prompt}
      selectedModel={props.state.selectedModel}
      selectedModels={props.state.selectedModels}
      selectedContexts={props.state.selectedContexts}
      onPromptChange={(prompt) => props.setState((current) => ({ ...current, prompt }))}
      onModelChange={(selectedModel) => props.setState((current) => ({ ...current, selectedModel }))}
      onModelsChange={(selectedModels) => props.setState((current) => ({ ...current, selectedModels }))}
      onContextsChange={(selectedContexts) => props.setState((current) => ({ ...current, selectedContexts }))}
      onRun={props.onRun}
      onBack={props.onBack}
    />
  );
}

function ChatWorkspace(props: {
  title: string;
  mode: RunMode;
  colors: Colors;
  cwd: string;
  models: string[];
  contexts: string[];
  prompt: string;
  selectedModel: string;
  selectedModels: string[];
  selectedContexts: string[];
  onPromptChange: (prompt: string) => void;
  onModelChange: (model: string) => void;
  onModelsChange: (models: string[]) => void;
  onContextsChange: (contexts: string[]) => void;
  onRun: () => void;
  onBack: () => void;
}) {
  return (
    <Box flexDirection="column" minHeight={15}>
      <Box marginBottom={1} justifyContent="space-between">
        <Text bold color={props.colors.accent}>
          {props.title}
        </Text>
        <Text color={props.colors.muted}>{props.mode === "arena" ? "Arena compares selected models" : "Single model run"}</Text>
      </Box>
      <ChatComposer {...props} />
    </Box>
  );
}

function ChatComposer(props: {
  mode: RunMode;
  colors: Colors;
  cwd: string;
  models: string[];
  contexts: string[];
  prompt: string;
  selectedModel: string;
  selectedModels: string[];
  selectedContexts: string[];
  onPromptChange: (prompt: string) => void;
  onModelChange: (model: string) => void;
  onModelsChange: (models: string[]) => void;
  onContextsChange: (contexts: string[]) => void;
  onRun: () => void;
  onBack: () => void;
}) {
  const [overlay, setOverlay] = useState<"none" | "model">("none");
  const [modelIndex, setModelIndex] = useState(0);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [dismissedMentionStart, setDismissedMentionStart] = useState<number | undefined>();
  const mention = getActiveMention(props.prompt);
  const mentionOptions = mention
    ? props.contexts.filter((context) => context.toLowerCase().startsWith(mention.query.toLowerCase()))
    : [];
  const mentionOpen = overlay === "none" && mention !== undefined && mention.start !== dismissedMentionStart;
  const displayModel =
    props.mode === "arena"
      ? props.selectedModels.length
        ? props.selectedModels.join(", ")
        : "Select models"
      : props.selectedModel;

  useEffect(() => {
    setMentionIndex(0);
  }, [mention?.query]);

  useEffect(() => {
    if (overlay === "model") {
      const current = props.mode === "arena" ? props.selectedModels[0] : props.selectedModel;
      setModelIndex(Math.max(0, props.models.indexOf(current)));
    }
  }, [overlay, props.mode, props.models, props.selectedModel, props.selectedModels]);

  useInput((input, key) => {
    if (overlay === "model") {
      if (key.escape) {
        setOverlay("none");
      }
      if (key.upArrow || input === "k") {
        setModelIndex((value) => Math.max(0, value - 1));
      }
      if (key.downArrow || input === "j") {
        setModelIndex((value) => Math.min(props.models.length - 1, value + 1));
      }
      if (input === " " && props.mode === "arena") {
        const model = props.models[modelIndex];
        if (model) {
          props.onModelsChange(toggleValue(props.selectedModels, model));
        }
      }
      if (key.return) {
        const model = props.models[modelIndex];
        if (model && props.mode === "single") {
          props.onModelChange(model);
          setOverlay("none");
        } else if (model && props.mode === "arena") {
          props.onModelsChange(toggleValue(props.selectedModels, model));
        }
      }
      return;
    }

    if (mentionOpen) {
      if (key.escape && mention) {
        setDismissedMentionStart(mention.start);
      }
      if (key.upArrow) {
        setMentionIndex((value) => Math.max(0, value - 1));
      }
      if (key.downArrow) {
        setMentionIndex((value) => Math.min(Math.max(0, mentionOptions.length - 1), value + 1));
      }
      if (key.return && mentionOptions.length > 0 && mention) {
        const context = mentionOptions[mentionIndex] ?? mentionOptions[0];
        updatePrompt(insertMention(props.prompt, mention, context));
      }
      return;
    }

    if (key.escape) {
      props.onBack();
      return;
    }
    if (key.return) {
      props.onRun();
      return;
    }
    if ((key as { ctrl?: boolean }).ctrl && input.toLowerCase() === "o") {
      setOverlay("model");
      return;
    }
    if (key.tab || input === "\t") {
      setOverlay("model");
    }
  });

  const updatePrompt = (value: string) => {
    if (value !== props.prompt) {
      setDismissedMentionStart(undefined);
    }
    props.onPromptChange(value);
    props.onContextsChange(getMentionedContexts(value, props.contexts));
  };

  return (
    <Box flexDirection="column">
      <Box borderStyle="single" borderColor={mentionOpen ? props.colors.accent : "gray"} paddingX={1} paddingY={1} minHeight={5}>
        <Box flexDirection="column" width="100%">
          <Box>
            <Text color={props.colors.accent}>› </Text>
            <TextInput
              value={props.prompt}
              onChange={updatePrompt}
              placeholder="Describe a task, type @ to attach workspace context"
              focus={overlay === "none"}
            />
          </Box>
        </Box>
      </Box>
      <Box marginLeft={2} marginTop={0}>
        <Text color={props.colors.accent}>{truncate(displayModel, 58)}</Text>
        <Text color={props.colors.muted}> · </Text>
        <Text color={props.colors.ok}>{formatCwd(props.cwd)}</Text>
      </Box>
      {props.selectedContexts.length > 0 ? (
        <Box marginLeft={2}>
          <Text color={props.colors.muted}>context </Text>
          {props.selectedContexts.map((context) => (
            <Text key={context} color={props.colors.accent}>
              @{context}{" "}
            </Text>
          ))}
        </Box>
      ) : null}
      <Box marginTop={1}>
        <Text color={props.colors.muted}>Enter send · @ mention context · Ctrl+O/Tab model picker · Esc back</Text>
      </Box>
      {mentionOpen ? (
        <MentionMenu colors={props.colors} query={mention?.query ?? ""} options={mentionOptions} selectedIndex={mentionIndex} />
      ) : null}
      {overlay === "model" ? (
        <ModelPickerOverlay
          colors={props.colors}
          mode={props.mode}
          models={props.models}
          selectedModel={props.selectedModel}
          selectedModels={props.selectedModels}
          index={modelIndex}
        />
      ) : null}
    </Box>
  );
}

function MentionMenu(props: { colors: Colors; query: string; options: string[]; selectedIndex: number }) {
  return (
    <Box borderStyle="round" borderColor={props.colors.accent} paddingX={1} marginTop={1} flexDirection="column">
      <Text color={props.colors.muted}>Mention context {props.query ? `matching @${props.query}` : ""}</Text>
      {props.options.length === 0 ? (
        <Text color={props.colors.muted}>No matching context</Text>
      ) : (
        props.options.slice(0, 8).map((context, index) => (
          <Text key={context} color={index === props.selectedIndex ? props.colors.accent : undefined}>
            {index === props.selectedIndex ? "›" : " "} @{context}
          </Text>
        ))
      )}
    </Box>
  );
}

function ModelPickerOverlay(props: {
  colors: Colors;
  mode: RunMode;
  models: string[];
  selectedModel: string;
  selectedModels: string[];
  index: number;
}) {
  return (
    <Box borderStyle="round" borderColor={props.colors.accent} paddingX={1} marginTop={1} flexDirection="column">
      <Text bold color={props.colors.accent}>
        Model Picker
      </Text>
      <Text color={props.colors.muted}>
        {props.mode === "arena" ? "Space/Enter toggles, Esc closes" : "Enter selects, Esc closes"}
      </Text>
      {props.models.map((model, index) => {
        const selected = props.mode === "arena" ? props.selectedModels.includes(model) : props.selectedModel === model;
        return (
          <Text key={model} color={index === props.index ? props.colors.accent : undefined}>
            {index === props.index ? "›" : " "} {selected ? "●" : "○"} {model}
          </Text>
        );
      })}
    </Box>
  );
}

function ConfigScreen(props: {
  colors: Colors;
  config: SandEvalConfig;
  models: string[];
  onSave: (config: SandEvalConfig) => Promise<void>;
  onBack: () => void;
}) {
  const [field, setField] = useState(0);
  const fields = ["default", "judge", "theme", "scoring"];
  useInput((input, key) => {
    if (key.upArrow || input === "k") setField((value) => Math.max(0, value - 1));
    if (key.downArrow || input === "j") setField((value) => Math.min(fields.length - 1, value + 1));
    if (key.return && fields[field] === "scoring") {
      void props.onSave({
        ...props.config,
        scoring: { ...props.config.scoring, enabled: !(props.config.scoring?.enabled ?? true) }
      });
    }
  });
  return (
    <FormLayout title="Config" colors={props.colors}>
      <PickerLine
        active={field === 0}
        label="Default model"
        value={props.config.defaultModel ?? props.models[0] ?? ""}
        options={props.models}
        colors={props.colors}
        onChange={(defaultModel) => void props.onSave({ ...props.config, defaultModel })}
      />
      <PickerLine
        active={field === 1}
        label="Judge model"
        value={props.config.judgeModel ?? props.config.defaultModel ?? props.models[0] ?? ""}
        options={props.models}
        colors={props.colors}
        onChange={(judgeModel) => void props.onSave({ ...props.config, judgeModel })}
      />
      <PickerLine
        active={field === 2}
        label="Theme"
        value={props.config.ui?.theme ?? "sand"}
        options={["sand", "dark", "mono"]}
        colors={props.colors}
        onChange={(theme) => void props.onSave({ ...props.config, ui: { ...props.config.ui, theme: theme as SandEvalConfig["ui"] extends infer U ? U extends { theme?: infer T } ? T : never : never } })}
      />
      <ActionLine active={field === 3} colors={props.colors} label={`Scoring default: ${props.config.scoring?.enabled !== false ? "on" : "off"}`} />
      <Text color={props.colors.muted}>For provider/storage additions, run: sandeval config wizard</Text>
    </FormLayout>
  );
}

function HistoryScreen(props: { colors: Colors; history: StoredRunSummary[]; onRefresh: () => Promise<void> }) {
  useEffect(() => {
    void props.onRefresh();
  }, []);
  return (
    <Box flexDirection="column">
      <Text bold color={props.colors.accent}>
        History
      </Text>
      {props.history.length === 0 ? (
        <Text color={props.colors.muted}>No stored runs yet.</Text>
      ) : (
        props.history.map((item) => (
          <Text key={item.id}>
            <Text color={props.colors.accent}>{item.type}</Text> {item.startedAt} score {item.score ?? "-"}{" "}
            {item.modelNames.join(",")} · {item.taskPreview}
          </Text>
        ))
      )}
    </Box>
  );
}

function LoginScreen(props: { colors: Colors; models: string[]; onLogin: (model: string) => void }) {
  return (
    <Box flexDirection="column">
      <Text bold color={props.colors.accent}>
        Login / Auth
      </Text>
      <Text color={props.colors.muted}>Select a model. Command providers run their configured login command.</Text>
      <Menu colors={props.colors} items={props.models.map((model) => ({ label: model, value: model }))} onSelect={props.onLogin} />
    </Box>
  );
}

function ResultScreen(props: {
  colors: Colors;
  result?: RunReport | ArenaReport;
  mode?: RunMode;
  reviewDraft: string;
  setReviewDraft: (value: string) => void;
  onPackage: () => void;
  onScore: (review: string) => void;
  onBackHome: () => void;
}) {
  const [actionIndex, setActionIndex] = useState(0);
  const [isReviewing, setIsReviewing] = useState(false);
  const actions = ["Package artifacts", "Review & score", "Back home"];

  useInput((input, key) => {
    if (isReviewing) {
      if (key.escape) {
        setIsReviewing(false);
      }
      if (key.return) {
        props.onScore(props.reviewDraft);
        setIsReviewing(false);
      }
      return;
    }
    if (key.leftArrow || key.upArrow || input === "h" || input === "k") {
      setActionIndex((value) => Math.max(0, value - 1));
    }
    if (key.rightArrow || key.downArrow || input === "l" || input === "j") {
      setActionIndex((value) => Math.min(actions.length - 1, value + 1));
    }
    if (key.return) {
      if (actionIndex === 0) props.onPackage();
      if (actionIndex === 1) setIsReviewing(true);
      if (actionIndex === 2) props.onBackHome();
    }
  });

  if (!props.result) {
    return <Text>No result.</Text>;
  }
  if (props.mode === "arena" && "results" in props.result) {
    return (
      <Box flexDirection="column">
        <Text bold color={props.colors.accent}>
          Arena Result
        </Text>
        {props.result.results.map((result) => (
          <Text key={result.run.id}>
            {result.run.modelName}: score {result.score?.score ?? "-"} · turns {result.run.turns} · tokens{" "}
            {result.run.usage.totalTokens ?? "-"}
          </Text>
        ))}
        <Text color={props.colors.muted}>{props.result.reportPaths?.markdownPath}</Text>
        {props.result.reportPaths?.artifactPath ? <Text color={props.colors.ok}>{props.result.reportPaths.artifactPath}</Text> : null}
        <ResultActions
          colors={props.colors}
          actions={actions}
          actionIndex={actionIndex}
          isReviewing={isReviewing}
          reviewDraft={props.reviewDraft}
          setReviewDraft={props.setReviewDraft}
        />
      </Box>
    );
  }
  const report = props.result as RunReport;
  return (
    <Box flexDirection="column">
      <Text bold color={props.colors.accent}>
        Run Result
      </Text>
      <Text>
        {report.run.modelName}: score {report.score?.score ?? "-"} · turns {report.run.turns} · tokens{" "}
        {report.run.usage.totalTokens ?? "-"} · duration {report.run.durationMs}ms
      </Text>
      <Text>{report.run.finish?.summary ?? report.run.finalContent ?? "No summary."}</Text>
      <Text color={props.colors.muted}>{report.reportPaths?.markdownPath}</Text>
      {report.reportPaths?.artifactPath ? <Text color={props.colors.ok}>{report.reportPaths.artifactPath}</Text> : null}
      <ResultActions
        colors={props.colors}
        actions={actions}
        actionIndex={actionIndex}
        isReviewing={isReviewing}
        reviewDraft={props.reviewDraft}
        setReviewDraft={props.setReviewDraft}
      />
    </Box>
  );
}

function ResultActions(props: {
  colors: Colors;
  actions: string[];
  actionIndex: number;
  isReviewing: boolean;
  reviewDraft: string;
  setReviewDraft: (value: string) => void;
}) {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box>
        {props.actions.map((action, index) => (
          <Text key={action} color={index === props.actionIndex ? props.colors.accent : undefined}>
            {index === props.actionIndex ? "[" : " "}
            {action}
            {index === props.actionIndex ? "]" : " "}{" "}
          </Text>
        ))}
      </Box>
      {props.isReviewing ? (
        <Box>
          <Text color={props.colors.accent}>Review: </Text>
          <TextInput value={props.reviewDraft} onChange={props.setReviewDraft} />
        </Box>
      ) : (
        <Text color={props.colors.muted}>Use h/l or arrows, Enter to choose. Review is optional; empty review is allowed.</Text>
      )}
    </Box>
  );
}

function LiveRunPanel(props: { colors: Colors; status: string; events: RunEvent[] }) {
  const visibleEvents = props.events.slice(-13);
  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text color={props.colors.accent}>
          <Spinner type="dots" /> {props.status}
        </Text>
      </Box>
      <Text bold color={props.colors.accent}>
        Workflow
      </Text>
      {visibleEvents.length === 0 ? (
        <Text color={props.colors.muted}>Waiting for first model event...</Text>
      ) : (
        visibleEvents.map((event, index) => (
          <Text key={`${event.at}-${index}`} color={eventColor(props.colors, event)}>
            {eventMark(event)} {formatTime(event.at)} {event.modelName ? `[${event.modelName}] ` : ""}
            {event.message}
          </Text>
        ))
      )}
      <Box marginTop={1} flexDirection="column">
        <Text color={props.colors.muted}>Live events include model turns, file edits, terminal commands, finish, and scoring.</Text>
        <Text color={props.colors.muted}>External custom providers can only report wrapper progress unless they emit tool calls.</Text>
      </Box>
    </Box>
  );
}

function ErrorScreen(props: { colors: Colors; error: string }) {
  return (
    <Box flexDirection="column">
      <Text bold color={props.colors.danger}>
        Error
      </Text>
      <Text>{truncate(props.error, 4000)}</Text>
    </Box>
  );
}

function FormLayout(props: { title: string; colors: Colors; children: React.ReactNode }) {
  return (
    <Box flexDirection="column">
      <Text bold color={props.colors.accent}>
        {props.title}
      </Text>
      {props.children}
    </Box>
  );
}

function Menu<T extends string>(props: { colors: Colors; items: Array<{ label: string; value: T }>; onSelect: (value: T) => void }) {
  const [index, setIndex] = useState(0);
  useInput((input, key) => {
    if (key.upArrow || input === "k") setIndex((value) => Math.max(0, value - 1));
    if (key.downArrow || input === "j") setIndex((value) => Math.min(props.items.length - 1, value + 1));
    if (key.return) props.onSelect(props.items[index]?.value);
  });
  return (
    <Box flexDirection="column" marginTop={1}>
      {props.items.map((item, itemIndex) => (
        <Text key={item.value} color={itemIndex === index ? props.colors.accent : undefined}>
          {itemIndex === index ? ">" : " "} {item.label}
        </Text>
      ))}
    </Box>
  );
}

function InputLine(props: { active: boolean; label: string; value: string; colors: Colors; onChange: (value: string) => void }) {
  return (
    <Box>
      <Text color={props.active ? props.colors.accent : undefined}>{props.active ? ">" : " "} {props.label}: </Text>
      {props.active ? (
        <TextInput value={props.value} onChange={props.onChange} />
      ) : (
        <Text>{props.value || <Text color={props.colors.muted}>empty</Text>}</Text>
      )}
    </Box>
  );
}

function PickerLine(props: {
  active: boolean;
  label: string;
  value: string;
  options: string[];
  colors: Colors;
  onChange: (value: string) => void;
}) {
  useInput((input, key) => {
    if (!props.active) return;
    if (key.leftArrow || input === "h") props.onChange(nextOption(props.options, props.value, -1));
    if (key.rightArrow || input === "l") props.onChange(nextOption(props.options, props.value, 1));
  });
  return (
    <Box>
      <Text color={props.active ? props.colors.accent : undefined}>
        {props.active ? ">" : " "} {props.label}:{" "}
      </Text>
      <Text>{props.value}</Text>
      {props.active ? <Text color={props.colors.muted}>  h/l change</Text> : null}
    </Box>
  );
}

function MultiPickerLine(props: {
  active: boolean;
  label: string;
  value: string[];
  options: string[];
  colors: Colors;
  onChange: (value: string[]) => void;
}) {
  const [index, setIndex] = useState(0);
  useInput((input, key) => {
    if (!props.active) return;
    if (key.leftArrow || input === "h") setIndex((value) => Math.max(0, value - 1));
    if (key.rightArrow || input === "l") setIndex((value) => Math.min(props.options.length - 1, value + 1));
    if (input === " ") {
      const current = props.options[index];
      props.onChange(props.value.includes(current) ? props.value.filter((item) => item !== current) : [...props.value, current]);
    }
  });
  return (
    <Box>
      <Text color={props.active ? props.colors.accent : undefined}>
        {props.active ? ">" : " "} {props.label}:{" "}
      </Text>
      {props.options.map((option, optionIndex) => (
        <Text key={option} color={props.active && optionIndex === index ? props.colors.accent : undefined}>
          {props.value.includes(option) ? "[x]" : "[ ]"}
          {option}{" "}
        </Text>
      ))}
    </Box>
  );
}

function ActionLine(props: { active: boolean; colors: Colors; label: string }) {
  return (
    <Text color={props.active ? props.colors.accent : undefined}>
      {props.active ? ">" : " "} {props.label}
    </Text>
  );
}

function nextOption(options: string[], current: string, delta: number): string {
  if (options.length === 0) {
    return current;
  }
  const index = Math.max(0, options.indexOf(current));
  return options[(index + delta + options.length) % options.length] ?? current;
}

function getActiveMention(prompt: string): { start: number; end: number; query: string } | undefined {
  const match = prompt.match(/(^|\s)@([a-zA-Z0-9_.-]*)$/);
  if (!match || match.index === undefined) {
    return undefined;
  }
  const prefixLength = match[1]?.length ?? 0;
  const query = match[2] ?? "";
  const start = match.index + prefixLength;
  return { start, end: prompt.length, query };
}

function insertMention(prompt: string, mention: { start: number; end: number }, context: string): string {
  return `${prompt.slice(0, mention.start)}@${context} ${prompt.slice(mention.end)}`;
}

function toggleValue(values: string[], value: string): string[] {
  return values.includes(value) ? values.filter((item) => item !== value) : [...values, value];
}

function getMentionedContexts(prompt: string, contexts: string[]): string[] {
  return extractContextMentions(prompt).filter((context) => contexts.includes(context));
}

function formatCwd(cwd: string): string {
  const home = process.env.HOME;
  if (home && cwd.startsWith(home)) {
    return cwd.replace(home, "~");
  }
  return cwd;
}

function resolveReportDir(config: SandEvalConfig, cwd: string): string {
  return config.reportDir?.startsWith("/") ? config.reportDir : `${cwd}/${config.reportDir ?? ".sandeval/reports"}`;
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  return date.toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
}

function eventMark(event: RunEvent): string {
  if (event.level === "error" || event.type === "error") {
    return "x";
  }
  if (event.level === "success" || event.type.endsWith("finish")) {
    return "+";
  }
  if (event.type === "tool-start") {
    return ">";
  }
  return "-";
}

function eventColor(colors: Colors, event: RunEvent): Colors[keyof Colors] | undefined {
  if (event.level === "error" || event.type === "error") {
    return colors.danger;
  }
  if (event.level === "success" || event.type.endsWith("finish")) {
    return colors.ok;
  }
  if (event.type === "tool-start" || event.type === "model-turn-start" || event.type === "score-start") {
    return colors.accent;
  }
  return undefined;
}

type Colors = {
  accent: "white" | "cyan" | "yellow";
  muted: "gray";
  ok: "white" | "green";
  danger: "white" | "red";
};

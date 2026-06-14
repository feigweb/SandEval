import React, { useEffect, useMemo, useRef, useState } from "react";
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
import { activeRules, summarizeRules } from "./rules.js";
import { extractSkillMentions, listSkills } from "./skills.js";
import { createStorage } from "./storage.js";
import type { ArenaReport, RunEvent, RunPlan, RunReport, SandEvalConfig, StoredRunSummary, WorkflowEvent } from "./types.js";
import { stringifyError, truncate } from "./utils.js";

type Screen = "run" | "config" | "history" | "login" | "result" | "workflow" | "planApproval" | "error";
type RunMode = "single" | "arena";
type PaletteView = "commands" | "runMode" | "model" | "arenaModels" | "contexts" | "skills" | "rules" | "sandboxMode" | "login";

interface AppState {
  screen: Screen;
  runMode: RunMode;
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
  pendingPlan?: RunPlan;
  planFeedback: string;
}

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
  const models = useMemo(() => listModelNames(config).filter((model) => findModel(config, model).kind !== "mock"), [config]);
  const contexts = useMemo(() => listContextNames(config), [config]);
  const [skillNames, setSkillNames] = useState<string[]>([]);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteView, setPaletteView] = useState<PaletteView>("commands");
  const [state, setState] = useState<AppState>({
    screen: "run",
    runMode: "single",
    selectedModel: models.includes(config.defaultModel ?? "") ? config.defaultModel ?? models[0] ?? "" : models[0] ?? "",
    selectedModels: config.defaultModel && models.includes(config.defaultModel) ? [config.defaultModel] : models.slice(0, 1),
    selectedContexts: [],
    prompt: "",
    review: "",
    score: config.scoring?.enabled ?? true,
    busy: false,
    status: "Ready",
    history: [],
    eventLog: [],
    reviewDraft: "",
    planFeedback: ""
  });
  const planResolver = useRef<((plan: RunPlan) => void) | undefined>(undefined);

  const theme = config.ui?.theme ?? "sand";
  const colors = {
    accent: theme === "mono" ? "white" : theme === "dark" ? "cyan" : "yellow",
    muted: theme === "mono" ? "gray" : "gray",
    ok: theme === "mono" ? "white" : "green",
    danger: theme === "mono" ? "white" : "red"
  } as const;

  useEffect(() => {
    void listSkills(config, props.cwd)
      .then((skills) => setSkillNames(skills.map((skill) => skill.name)))
      .catch((error) => setState((current) => ({ ...current, status: `Skill load failed: ${stringifyError(error)}` })));
  }, [config, props.cwd]);

  const go = (screen: Screen) => setState((current) => ({ ...current, screen, error: undefined, status: screen === "run" ? "Ready" : current.status }));
  const back = () => {
    if (state.busy) {
      return;
    }
    if (state.screen === "run") {
      exit();
      return;
    }
    go("run");
  };

  useInput((input, key) => {
    if (state.busy) {
      return;
    }
    if (input === "q") {
      exit();
      return;
    }
    if ((key as { ctrl?: boolean }).ctrl && input.toLowerCase() === "k") {
      setPaletteView("commands");
      setPaletteOpen(true);
      return;
    }
    if (paletteOpen || state.screen === "run" || state.screen === "result") {
      return;
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

  async function openHistoryItem(item: StoredRunSummary) {
    setState((current) => ({ ...current, busy: true, status: `Opening ${item.id}` }));
    try {
      const storage = await createStorage(config, props.cwd);
      const report = await storage.loadReport?.(item);
      if (!report) {
        throw new Error(item.reportPath ? `Report file not found: ${item.reportPath}` : `History item ${item.id} has no report path.`);
      }
      setState((current) => ({
        ...current,
        busy: false,
        result: report,
        resultMode: "results" in report ? "arena" : "single",
        screen: "result",
        eventLog: [],
        status: `Opened history: ${item.id}`
      }));
    } catch (error) {
      setState((current) => ({ ...current, busy: false, error: stringifyError(error), screen: "error" }));
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
      eventLog: [...current.eventLog, event].slice(-(config.workflow?.maxWorkflowEvents ?? 200)),
      status: event.message
    }));
  }

  async function approvePlanInTui(plan: RunPlan): Promise<RunPlan> {
    return new Promise((resolve) => {
      planResolver.current = resolve;
      setState((current) => ({
        ...current,
        busy: false,
        screen: "planApproval",
        pendingPlan: plan,
        planFeedback: "",
        status: "Plan awaiting approval"
      }));
    });
  }

  function resolvePendingPlan(next: RunPlan) {
    const resolve = planResolver.current;
    planResolver.current = undefined;
    setState((current) => ({
      ...current,
      busy: true,
      screen: "run",
      pendingPlan: undefined,
      planFeedback: "",
      status: next.approved ? "Plan approved, continuing run" : "Revising plan"
    }));
    resolve?.(next);
  }

  async function runSingle(promptOverride?: string) {
    const prompt = promptOverride ?? state.prompt;
    if (!state.selectedModel) {
      setState((current) => ({ ...current, status: "No non-mock model is configured for TUI runs" }));
      return;
    }
    if (!prompt.trim()) {
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
        prompt,
        modelName: state.selectedModel,
        score: state.score,
        onEvent: appendRunEvent,
        contextNames: state.selectedContexts,
        onPlanApproval: approvePlanInTui
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

  async function runArenaFlow(promptOverride?: string) {
    const prompt = promptOverride ?? state.prompt;
    if (!prompt.trim()) {
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
        prompt,
        models: state.selectedModels,
        score: state.score,
        concurrency: requiresInteractivePlanApproval(config) ? 1 : undefined,
        onEvent: appendRunEvent,
        contextNames: state.selectedContexts,
        onPlanApproval: approvePlanInTui
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
          config,
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

  const runCurrent = (promptOverride?: string) => {
    if (state.runMode === "arena") {
      void runArenaFlow(promptOverride);
    } else {
      void runSingle(promptOverride);
    }
  };

  let body: React.ReactNode;
  if (paletteOpen) {
    body = (
      <CommandPalette
        colors={colors}
        view={paletteView}
        setView={setPaletteView}
        state={state}
        config={config}
        models={models}
        contexts={contexts}
        skillNames={skillNames}
        onClose={() => setPaletteOpen(false)}
        onRun={runCurrent}
        onGo={go}
        onSetState={setState}
        onSaveConfig={persistConfig}
        onLogin={loginSelected}
        onPackage={packageCurrentArtifacts}
        onScore={() => scoreCurrentResult(state.reviewDraft)}
      />
    );
  } else if (state.screen === "run") {
    body = (
      <RunScreen
        colors={colors}
        models={models}
        contexts={contexts}
        cwd={props.cwd}
        state={state}
        setState={setState}
        onRun={runCurrent}
        onBack={back}
      />
    );
  } else if (state.screen === "config") {
    body = <ConfigScreen colors={colors} config={config} models={models} onSave={persistConfig} onBack={back} />;
  } else if (state.screen === "history") {
    body = <HistoryScreen colors={colors} history={state.history} onRefresh={refreshHistory} onOpen={openHistoryItem} />;
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
        onBackHome={() => go("run")}
      />
    );
  } else if (state.screen === "workflow") {
    body = <WorkflowScreen colors={colors} result={state.result} events={state.eventLog} config={config} />;
  } else if (state.screen === "planApproval") {
    body = (
      <PlanApprovalScreen
        colors={colors}
        plan={state.pendingPlan}
        feedback={state.planFeedback}
        setFeedback={(planFeedback) => setState((current) => ({ ...current, planFeedback }))}
        onApprove={() => state.pendingPlan && resolvePendingPlan({ ...state.pendingPlan, approved: true, approvalMode: "interactive" })}
        onRevise={() =>
          state.pendingPlan &&
          resolvePendingPlan({
            ...state.pendingPlan,
            approved: false,
            approvalMode: "interactive",
            revisions: [...state.pendingPlan.revisions, { feedback: state.planFeedback || "Revise the plan.", content: state.pendingPlan.content }]
          })
        }
        onCancel={() => state.pendingPlan && resolvePendingPlan({ ...state.pendingPlan, approved: false, approvalMode: "interactive" })}
      />
    );
  } else {
    body = <ErrorScreen colors={colors} error={state.error ?? "Unknown error"} />;
  }

  return (
    <Box flexDirection="column" paddingX={1}>
      <Header colors={colors} cwd={props.cwd} configPath={getConfigPath(props.cwd, props.configPath)} />
      <Box borderStyle="round" borderColor={colors.accent} paddingX={1} paddingY={0} minHeight={18} flexDirection="column">
        {state.busy && state.screen !== "planApproval" ? (
          <LiveRunPanel colors={colors} status={state.status} events={state.eventLog} config={config} />
        ) : (
          body
        )}
      </Box>
      <Footer colors={colors} help={footerHelp(state, paletteOpen)} status={`${statusSummary(state, config)} · ${state.status}`} />
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

function Footer(props: { colors: Colors; help: string; status: string }) {
  return (
    <Box marginTop={1} justifyContent="space-between">
      <Text color={props.colors.muted}>{props.help}</Text>
      <Text color={props.colors.accent}>{props.status}</Text>
    </Box>
  );
}

function CommandPalette(props: {
  colors: Colors;
  view: PaletteView;
  setView: (view: PaletteView) => void;
  state: AppState;
  config: SandEvalConfig;
  models: string[];
  contexts: string[];
  skillNames: string[];
  onClose: () => void;
  onRun: (promptOverride?: string) => void;
  onGo: (screen: Screen) => void;
  onSetState: React.Dispatch<React.SetStateAction<AppState>>;
  onSaveConfig: (config: SandEvalConfig) => Promise<void>;
  onLogin: (model: string) => void;
  onPackage: () => void;
  onScore: () => void;
}) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const selectedSkills = extractSkillMentions(props.state.prompt);
  const rules = props.config.rules ?? [];

  useEffect(() => {
    setQuery("");
    setIndex(0);
  }, [props.view]);

  const close = () => {
    props.setView("commands");
    props.onClose();
  };

  const commands: Array<{ label: string; hint: string; run: () => void }> = [
    { label: "Run task", hint: props.state.runMode, run: () => { close(); props.onRun(); } },
    { label: "Switch run mode", hint: props.state.runMode, run: () => props.setView("runMode") },
    { label: "Switch model", hint: props.state.selectedModel, run: () => props.setView("model") },
    { label: "Select arena models", hint: `${props.state.selectedModels.length} selected`, run: () => props.setView("arenaModels") },
    { label: "Select contexts", hint: `${props.state.selectedContexts.length} selected`, run: () => props.setView("contexts") },
    { label: "Toggle skill", hint: `${selectedSkills.length} selected`, run: () => props.setView("skills") },
    { label: "Toggle rule", hint: summarizeRules(props.config), run: () => props.setView("rules") },
    {
      label: "Toggle scoring",
      hint: props.state.score ? "on" : "off",
      run: () => props.onSetState((current) => ({ ...current, score: !current.score, status: `Scoring: ${!current.score ? "on" : "off"}` }))
    },
    { label: "Switch sandbox mode", hint: props.config.sandbox?.mode ?? "local", run: () => props.setView("sandboxMode") },
    {
      label: "Toggle network",
      hint: props.config.sandbox?.network === true ? "on" : "off",
      run: () => void props.onSaveConfig({ ...props.config, sandbox: { ...props.config.sandbox, network: !(props.config.sandbox?.network === true) } })
    },
    {
      label: "Toggle tool: shell",
      hint: props.config.tools?.shell !== false ? "on" : "off",
      run: () => void props.onSaveConfig({ ...props.config, tools: { ...props.config.tools, shell: !(props.config.tools?.shell !== false) } })
    },
    {
      label: "Toggle tool: git",
      hint: props.config.tools?.git ?? "full",
      run: () =>
        void props.onSaveConfig({
          ...props.config,
          tools: { ...props.config.tools, git: props.config.tools?.git === "off" ? "full" : "off" }
        })
    },
    { label: "Open history", hint: "stored runs", run: () => { close(); props.onGo("history"); } },
    { label: "Login provider", hint: "auth", run: () => props.setView("login") },
    { label: "Package artifacts", hint: props.state.result ? "current result" : "no result", run: () => { close(); props.onPackage(); } },
    { label: "Review and score", hint: props.state.result ? "current result" : "no result", run: () => { close(); props.onScore(); } },
    { label: "Show workflow output", hint: "events", run: () => { close(); props.onGo("workflow"); } },
    { label: "Open config summary", hint: "config", run: () => { close(); props.onGo("config"); } }
  ];

  const rows = paletteRows(props.view, query, props, commands);
  const selected = rows[index];

  useInput((input, key) => {
    if (key.escape) {
      if (props.view === "commands") {
        close();
      } else {
        props.setView("commands");
      }
      return;
    }
    if (key.upArrow || input === "k") {
      setIndex((value) => Math.max(0, value - 1));
      return;
    }
    if (key.downArrow || input === "j") {
      setIndex((value) => Math.min(rows.length - 1, value + 1));
      return;
    }
    if (key.return && selected) {
      selected.run();
      return;
    }
    if (input === " " && selected?.multi) {
      selected.run();
    }
  });

  return (
    <Box flexDirection="column">
      <Text bold color={props.colors.accent}>
        Command Palette
      </Text>
      <Box>
        <Text color={props.colors.accent}>{props.view === "commands" ? ">" : `${props.view}>`} </Text>
        <TextInput value={query} onChange={setQuery} placeholder="Search commands" />
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {rows.length === 0 ? (
          <Text color={props.colors.muted}>No matches</Text>
        ) : (
          rows.slice(0, 12).map((row, rowIndex) => (
            <Text key={row.key} color={rowIndex === index ? props.colors.accent : undefined}>
              {rowIndex === index ? ">" : " "} {row.mark ?? " "} {row.label}
              {row.hint ? <Text color={props.colors.muted}> · {row.hint}</Text> : null}
            </Text>
          ))
        )}
      </Box>
      <Text color={props.colors.muted}>Enter select · Esc {props.view === "commands" ? "close" : "commands"} · type to filter</Text>
    </Box>
  );
}

function paletteRows(
  view: PaletteView,
  query: string,
  props: Parameters<typeof CommandPalette>[0],
  commands: Array<{ label: string; hint: string; run: () => void }>
): Array<{ key: string; label: string; hint?: string; mark?: string; multi?: boolean; run: () => void }> {
  const filter = (label: string) => label.toLowerCase().includes(query.toLowerCase());
  if (view === "commands") {
    return commands
      .filter((command) => filter(command.label) || command.hint.toLowerCase().includes(query.toLowerCase()))
      .map((command) => ({ key: command.label, label: command.label, hint: command.hint, run: command.run }));
  }
  if (view === "runMode") {
    return (["single", "arena"] as RunMode[]).map((mode) => ({
      key: mode,
      label: mode,
      mark: props.state.runMode === mode ? "*" : " ",
      run: () => {
        props.onSetState((current) => ({ ...current, runMode: mode, status: `Run mode: ${mode}` }));
        props.setView("commands");
      }
    }));
  }
  if (view === "model") {
    return props.models.filter(filter).map((model) => ({
      key: model,
      label: model,
      mark: props.state.selectedModel === model ? "*" : " ",
      run: () => {
        props.onSetState((current) => ({ ...current, selectedModel: model, status: `Model: ${model}` }));
        props.setView("commands");
      }
    }));
  }
  if (view === "arenaModels") {
    return props.models.filter(filter).map((model) => ({
      key: model,
      label: model,
      mark: props.state.selectedModels.includes(model) ? "x" : " ",
      multi: true,
      run: () => props.onSetState((current) => ({ ...current, selectedModels: toggleValue(current.selectedModels, model) }))
    }));
  }
  if (view === "contexts") {
    return props.contexts.filter(filter).map((context) => ({
      key: context,
      label: `@${context}`,
      mark: props.state.selectedContexts.includes(context) ? "x" : " ",
      multi: true,
      run: () => props.onSetState((current) => ({ ...current, selectedContexts: toggleValue(current.selectedContexts, context) }))
    }));
  }
  if (view === "skills") {
    const selectedSkills = extractSkillMentions(props.state.prompt);
    return props.skillNames.filter(filter).map((skill) => ({
      key: skill,
      label: `@skill:${skill}`,
      mark: selectedSkills.includes(skill) ? "x" : " ",
      multi: true,
      run: () => props.onSetState((current) => ({ ...current, prompt: toggleSkillMention(current.prompt, skill) }))
    }));
  }
  if (view === "rules") {
    return (props.config.rules ?? []).filter((rule) => filter(rule.name)).map((rule) => ({
      key: rule.name,
      label: rule.name,
      hint: rule.description,
      mark: rule.enabled !== false ? "x" : " ",
      multi: true,
      run: () =>
        void props.onSaveConfig({
          ...props.config,
          rules: (props.config.rules ?? []).map((candidate) =>
            candidate.name === rule.name ? { ...candidate, enabled: !(candidate.enabled !== false) } : candidate
          )
        })
    }));
  }
  if (view === "sandboxMode") {
    return (["local", "docker", "podman", "bubblewrap", "firejail", "nsjail"] as const).filter(filter).map((mode) => ({
      key: mode,
      label: mode,
      mark: props.config.sandbox?.mode === mode ? "*" : " ",
      run: () => {
        void props.onSaveConfig({ ...props.config, sandbox: { ...props.config.sandbox, mode } });
        props.setView("commands");
      }
    }));
  }
  if (view === "login") {
    return props.models.filter(filter).map((model) => ({
      key: model,
      label: model,
      run: () => {
        props.onClose();
        props.onLogin(model);
      }
    }));
  }
  return [];
}

function RunScreen(props: {
  colors: Colors;
  models: string[];
  contexts: string[];
  cwd: string;
  state: AppState;
  setState: React.Dispatch<React.SetStateAction<AppState>>;
  onRun: (promptOverride?: string) => void;
  onBack: () => void;
}) {
  return (
    <ChatWorkspace
      title="Workspace"
      mode={props.state.runMode}
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
  onRun: (promptOverride?: string) => void;
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
  onRun: (promptOverride?: string) => void;
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
  onRun: (promptOverride?: string) => void;
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
    if ((key as { ctrl?: boolean }).ctrl && input.toLowerCase() === "o") {
      setOverlay("model");
      return;
    }
    if (key.tab || input === "\t") {
      setOverlay("model");
    }
  });

  const submitPrompt = (value: string) => {
    const cleaned = value.replace(/[\r\n]+/g, "").trimEnd();
    props.onPromptChange(cleaned);
    props.onContextsChange(getMentionedContexts(cleaned, props.contexts));
    props.onRun(cleaned);
  };

  const updatePrompt = (value: string) => {
    if (/[\r\n]/.test(value)) {
      submitPrompt(value);
      return;
    }
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
              onSubmit={submitPrompt}
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

function HistoryScreen(props: {
  colors: Colors;
  history: StoredRunSummary[];
  onRefresh: () => Promise<void>;
  onOpen: (item: StoredRunSummary) => void;
}) {
  const [index, setIndex] = useState(0);
  useEffect(() => {
    void props.onRefresh();
  }, []);
  useEffect(() => {
    setIndex((value) => Math.min(value, Math.max(0, props.history.length - 1)));
  }, [props.history.length]);
  useInput((input, key) => {
    if (key.upArrow || input === "k") {
      setIndex((value) => Math.max(0, value - 1));
      return;
    }
    if (key.downArrow || input === "j") {
      setIndex((value) => Math.min(props.history.length - 1, value + 1));
      return;
    }
    if (input === "r") {
      void props.onRefresh();
      return;
    }
    if (key.return && props.history[index]) {
      props.onOpen(props.history[index]);
    }
  });
  return (
    <Box flexDirection="column">
      <Text bold color={props.colors.accent}>
        History
      </Text>
      {props.history.length === 0 ? (
        <Text color={props.colors.muted}>No stored runs yet.</Text>
      ) : (
        props.history.map((item, itemIndex) => (
          <Text key={item.id} color={itemIndex === index ? props.colors.accent : undefined}>
            {itemIndex === index ? ">" : " "} <Text color={props.colors.accent}>{item.type}</Text> {item.startedAt} score{" "}
            {item.score ?? "-"} {item.modelNames.join(",")} · {item.taskPreview}
          </Text>
        ))
      )}
      <Text color={props.colors.muted}>Enter open details · r refresh · b back</Text>
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
            {result.run.usage.totalTokens ?? "-"} · workflow {result.run.workflowEvents?.length ?? 0}
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
      <Text color={props.colors.muted}>
        workflow {report.run.workflowAdapter ?? "none"} · events {report.run.workflowEvents?.length ?? 0}
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

function PlanApprovalScreen(props: {
  colors: Colors;
  plan?: RunPlan;
  feedback: string;
  setFeedback: (feedback: string) => void;
  onApprove: () => void;
  onRevise: () => void;
  onCancel: () => void;
}) {
  useInput((input, key) => {
    if (input === "a") {
      props.onApprove();
      return;
    }
    if (input === "c" || key.escape) {
      props.onCancel();
      return;
    }
    if (key.return && props.feedback.trim()) {
      props.onRevise();
    }
  });

  return (
    <Box flexDirection="column">
      <Text bold color={props.colors.accent}>
        Approve Plan
      </Text>
      <Text>{truncate(props.plan?.content ?? "No plan content.", 2400)}</Text>
      <Box marginTop={1}>
        <Text color={props.colors.accent}>Feedback: </Text>
        <TextInput value={props.feedback} onChange={props.setFeedback} />
      </Box>
      <Text color={props.colors.muted}>a approve · Enter revise with feedback · c cancel</Text>
    </Box>
  );
}

function LiveRunPanel(props: { colors: Colors; status: string; events: RunEvent[]; config: SandEvalConfig }) {
  const maxEvents = props.config.workflow?.maxLiveEvents ?? 40;
  const visibleEvents = compactRunEvents(props.events, props.config).slice(-Math.min(13, maxEvents));
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

function WorkflowScreen(props: { colors: Colors; result?: RunReport | ArenaReport; events: RunEvent[]; config: SandEvalConfig }) {
  const workflowEvents = compactWorkflowEvents(collectWorkflowEvents(props.result), props.config).slice(-(props.config.workflow?.maxLiveEvents ?? 40));
  const events = compactRunEvents(props.events, props.config).slice(-30);
  const commandCount =
    props.result && "results" in props.result
      ? props.result.results.reduce((sum, result) => sum + result.run.commands.length, 0)
      : props.result
        ? (props.result as RunReport).run.commands.length
        : 0;
  return (
    <Box flexDirection="column">
      <Text bold color={props.colors.accent}>
        Workflow Output
      </Text>
      <Text color={props.colors.muted}>
        Structured events: {workflowEvents.length} · Commands captured: {commandCount}
      </Text>
      {workflowEvents.length > 0 ? (
        workflowEvents.map((event) => (
          <Text key={event.id} color={workflowEventColor(props.colors, event)}>
            {workflowEventMark(event)} {event.adapter} · {event.kind} · {event.title}
            {event.count && event.count > 1 ? ` x${event.count}` : ""}
            {event.message ? ` - ${truncate(event.message.replace(/\s+/g, " "), 160)}` : ""}
          </Text>
        ))
      ) : events.length === 0 ? (
        <Text color={props.colors.muted}>No workflow events yet.</Text>
      ) : (
        events.map((event, index) => (
          <Text key={`${event.at}-${index}`} color={eventColor(props.colors, event)}>
            {eventMark(event)} {formatTime(event.at)} {event.modelName ? `[${event.modelName}] ` : ""}
            {event.message}
          </Text>
        ))
      )}
    </Box>
  );
}

function collectWorkflowEvents(result?: RunReport | ArenaReport): WorkflowEvent[] {
  if (!result) {
    return [];
  }
  if ("results" in result) {
    return result.results.flatMap((item) => item.run.workflowEvents ?? []);
  }
  return result.run.workflowEvents ?? [];
}

function compactWorkflowEvents(events: WorkflowEvent[], config: SandEvalConfig): WorkflowEvent[] {
  if (config.workflow?.collapseSimilar === false) {
    return events;
  }
  const compacted: WorkflowEvent[] = [];
  for (const event of events) {
    const previous = compacted.at(-1);
    if (previous && workflowFoldKey(previous) === workflowFoldKey(event)) {
      compacted[compacted.length - 1] = {
        ...previous,
        count: (previous.count ?? 1) + 1,
        message: summarizeFoldedWorkflow(previous, event)
      };
    } else {
      compacted.push(event);
    }
  }
  return compacted;
}

function compactRunEvents(events: RunEvent[], config: SandEvalConfig): RunEvent[] {
  if (config.workflow?.collapseSimilar === false) {
    return events;
  }
  const compacted: RunEvent[] = [];
  for (const event of events) {
    const previous = compacted.at(-1);
    if (previous && runFoldKey(previous) === runFoldKey(event)) {
      const count = Number(previous.detail?.count ?? 1) + 1;
      compacted[compacted.length - 1] = {
        ...previous,
        message: `${previous.message.replace(/\s+x\d+$/, "")} x${count}`,
        detail: { ...previous.detail, count }
      };
    } else {
      compacted.push(event);
    }
  }
  return compacted;
}

function workflowFoldKey(event: WorkflowEvent): string {
  return [event.adapter, event.kind, event.phase, event.toolName ?? "", event.command ? "command" : "", event.path ? "path" : ""].join("|");
}

function runFoldKey(event: RunEvent): string {
  return [event.type, event.modelName ?? "", event.toolName ?? "", event.detail?.phase ?? "", event.level ?? ""].join("|");
}

function summarizeFoldedWorkflow(previous: WorkflowEvent, current: WorkflowEvent): string | undefined {
  if (previous.kind === "file-change") {
    return `${(previous.count ?? 1) + 1} file changes`;
  }
  if (previous.kind === "tool-call") {
    return `${(previous.count ?? 1) + 1} ${previous.toolName ?? "tool"} calls`;
  }
  if (previous.kind === "command") {
    return `${(previous.count ?? 1) + 1} commands`;
  }
  return current.message ?? previous.message;
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

function toggleSkillMention(prompt: string, skill: string): string {
  const escaped = escapeRegExp(skill);
  const pattern = new RegExp(`(^|\\s)@skill:(?:\\{${escaped}\\}|${escaped})(?=\\s|$)`);
  if (pattern.test(prompt)) {
    return prompt.replace(pattern, (match, prefix: string) => prefix).replace(/\s{2,}/g, " ").trimStart();
  }
  return prompt.trim() ? `${prompt} @skill:${skill}` : `@skill:${skill}`;
}

function statusSummary(state: AppState, config: SandEvalConfig): string {
  const model = state.runMode === "arena" ? `${state.selectedModels.length} models` : state.selectedModel;
  const contexts = state.selectedContexts.length ? `ctx${state.selectedContexts.length}` : "ctx0";
  const skills = extractSkillMentions(state.prompt).length;
  const sandbox = config.sandbox?.mode ?? "local";
  const network = config.sandbox?.network === true ? "net" : "no-net";
  const shell = config.tools?.shell !== false ? "sh" : "no-sh";
  const git = config.tools?.git === "off" ? "no-git" : `git-${config.tools?.git ?? "full"}`;
  const scoring = state.score ? "score" : "no-score";
  return `${state.runMode} · ${truncate(model, 28)} · ${contexts} sk${skills} rl${activeRules(config).length} · ${scoring} · ${sandbox}/${network} · ${shell} ${git}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function formatCwd(cwd: string): string {
  const home = process.env.HOME;
  if (home && cwd.startsWith(home)) {
    return cwd.replace(home, "~");
  }
  return cwd;
}

function footerHelp(state: AppState, paletteOpen: boolean): string {
  if (paletteOpen) {
    return "Enter select · Esc close · q quit";
  }
  if (state.busy) {
    return "Running · q quit";
  }
  if (state.screen === "result") {
    return "Arrows choose action · Enter select · q quit";
  }
  if (state.screen === "run") {
    return "Ctrl+K commands · Enter run · Esc back · q quit";
  }
  return "Ctrl+K commands · Esc back · q quit";
}

function requiresInteractivePlanApproval(config: SandEvalConfig): boolean {
  return config.agent?.planMode === "enforced" && config.agent?.planApproval === "interactive";
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

function workflowEventMark(event: WorkflowEvent): string {
  if (event.level === "error" || event.kind === "error") {
    return "x";
  }
  if (event.level === "success" || event.kind === "result") {
    return "+";
  }
  if (event.kind === "command" || event.kind === "tool-call") {
    return ">";
  }
  return "-";
}

function workflowEventColor(colors: Colors, event: WorkflowEvent): Colors[keyof Colors] | undefined {
  if (event.level === "error" || event.kind === "error") {
    return colors.danger;
  }
  if (event.level === "success" || event.kind === "result") {
    return colors.ok;
  }
  if (event.kind === "command" || event.kind === "tool-call" || event.kind === "file-change") {
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

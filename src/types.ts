export type ProviderKind =
  | "openai-compatible"
  | "anthropic-compatible"
  | "gemini-compatible"
  | "command"
  | "custom"
  | "mock";

export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  costUsd?: number;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  name?: string;
}

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ModelResponse {
  content: string;
  toolCalls: ToolCall[];
  usage?: Usage;
  raw?: unknown;
}

export interface ModelProvider {
  name: string;
  chat(request: ModelChatRequest): Promise<ModelResponse>;
}

export interface ModelChatRequest {
  messages: ChatMessage[];
  tools?: ToolSpec[];
  temperature?: number;
  maxTokens?: number;
  metadata?: Record<string, unknown>;
  responseFormat?: StructuredResponseFormat;
}

export interface StructuredResponseFormat {
  type: "json_schema";
  name: string;
  schema: Record<string, unknown>;
  description?: string;
  strict?: boolean;
}

export interface BaseModelConfig {
  name: string;
  kind: ProviderKind;
  model?: string;
  provider?: string;
  modelIds?: string[];
  temperature?: number;
  maxTokens?: number;
  description?: string;
  tags?: string[];
  enabled?: boolean;
  auth?: AuthConfig;
}

export interface HttpModelConfig extends BaseModelConfig {
  kind: "openai-compatible" | "anthropic-compatible" | "gemini-compatible";
  baseUrl: string;
  apiKey?: string;
  apiKeyEnv?: string;
  headers?: Record<string, string>;
}

export interface CommandModelConfig extends BaseModelConfig {
  kind: "command";
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  protocol?: "sandeval-json" | "plain-final";
  workflowAdapter?: "codex" | "claude-code" | "jsonl" | "none" | string;
}

export interface CustomModelConfig extends BaseModelConfig {
  kind: "custom";
  modulePath: string;
  exportName?: string;
  options?: Record<string, unknown>;
}

export interface MockModelConfig extends BaseModelConfig {
  kind: "mock";
}

export type ModelConfig = HttpModelConfig | CommandModelConfig | CustomModelConfig | MockModelConfig;

export interface AuthConfig {
  type?: "none" | "api-key" | "command" | "command-token";
  apiKeyEnv?: string;
  tokenCommand?: string;
  tokenArgs?: string[];
  loginCommand?: string;
  loginArgs?: string[];
  checkCommand?: string;
  checkArgs?: string[];
  cwd?: string;
  env?: Record<string, string>;
}

export type SandboxMode = "local" | "docker" | "podman" | "bubblewrap" | "firejail" | "nsjail" | "external";

export interface ExternalSandboxConfig {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}

export interface SandboxConfig {
  mode?: SandboxMode;
  root?: string;
  dockerImage?: string;
  dockerRuntime?: string;
  podmanImage?: string;
  nsjailRootfs?: string;
  commandTimeoutMs?: number;
  network?: boolean;
  env?: Record<string, string>;
  sandboxExtraArgs?: string[];
  external?: ExternalSandboxConfig;
  preserveRuns?: number;
  copyTaskFiles?: boolean;
}

export type GitToolPermission = "off" | "read" | "full";

export interface ToolsConfig {
  files?: boolean;
  shell?: boolean;
  git?: GitToolPermission;
  gitRemote?: boolean;
  packageManager?: boolean;
  maxCommandTimeoutMs?: number;
  blockedCommands?: string[];
}

export interface RuleConfig {
  name: string;
  description?: string;
  prompt: string;
  enabled?: boolean;
}

export interface SkillsConfig {
  localDir?: string;
  globalDir?: string;
}

export interface AppliedRule {
  name: string;
  description?: string;
}

export interface AppliedSkill {
  name: string;
  description?: string;
  source: "builtin" | "local" | "global";
}

export interface AgentConfig {
  maxTurns?: number;
  systemPrompt?: string;
  toolTimeoutMs?: number;
  autoRunVerification?: boolean;
  planMode?: "off" | "prompt" | "enforced";
  planApproval?: "auto" | "interactive";
}

export interface ScoringDimensionConfig {
  key: string;
  label?: string;
  description?: string;
  weight?: number;
}

export interface ScoringConfig {
  enabled?: boolean;
  mode?: "single" | "multi";
  rubric?: string;
  maxRetries?: number;
  minScore?: number;
  maxScore?: number;
  dimensions?: ScoringDimensionConfig[];
}

export interface ArenaConfig {
  concurrency?: number;
}

export interface WorkflowConfig {
  compact?: boolean;
  collapseSimilar?: boolean;
  maxLiveEvents?: number;
  maxWorkflowEvents?: number;
}

export interface StorageConfig {
  kind?: "filesystem" | "custom";
  root?: string;
  indexFile?: string;
  modulePath?: string;
  options?: Record<string, unknown>;
}

export interface UiConfig {
  theme?: "sand" | "mono" | "dark";
  pageSize?: number;
  showRawUsage?: boolean;
  confirmBeforeRun?: boolean;
}

export interface ContextConfig {
  name: string;
  path: string;
  description?: string;
  include?: string[];
  exclude?: string[];
  maxFiles?: number;
  maxFileBytes?: number;
}

export interface SandEvalConfig {
  version?: number;
  defaultModel?: string;
  judgeModel?: string;
  reportDir?: string;
  sandbox?: SandboxConfig;
  agent?: AgentConfig;
  scoring?: ScoringConfig;
  arena?: ArenaConfig;
  workflow?: WorkflowConfig;
  storage?: StorageConfig;
  ui?: UiConfig;
  tools?: ToolsConfig;
  rules?: RuleConfig[];
  skills?: SkillsConfig;
  contexts?: ContextConfig[];
  models: ModelConfig[];
}

export interface CommandResult {
  command: string;
  args: string[];
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

export type RunEventType =
  | "run-start"
  | "run-finish"
  | "model-turn-start"
  | "model-turn-finish"
  | "tool-start"
  | "tool-finish"
  | "score-start"
  | "score-finish"
  | "arena-model-start"
  | "arena-model-finish"
  | "info"
  | "error";

export interface RunEvent {
  type: RunEventType;
  at: string;
  message: string;
  modelName?: string;
  turn?: number;
  toolName?: string;
  level?: "info" | "success" | "warning" | "error";
  detail?: Record<string, unknown>;
}

export type RunEventHandler = (event: RunEvent) => void;

export type WorkflowEventKind =
  | "status"
  | "assistant-message"
  | "tool-call"
  | "tool-result"
  | "command"
  | "file-change"
  | "result"
  | "usage"
  | "error"
  | "raw";

export interface WorkflowEvent {
  id: string;
  adapter: string;
  kind: WorkflowEventKind;
  phase?: "plan" | "think" | "tool" | "command" | "file" | "verify" | "finish" | "score" | "raw";
  status?: "pending" | "running" | "success" | "error";
  at?: string;
  turn?: number;
  title: string;
  message?: string;
  toolName?: string;
  command?: string;
  path?: string;
  durationMs?: number;
  count?: number;
  level?: "info" | "success" | "warning" | "error";
  rawType?: string;
  raw?: Record<string, unknown>;
}

export interface WorkflowRawArtifact {
  adapter: string;
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
  timedOut?: boolean;
  jsonLineCount?: number;
}

export interface FinishPayload {
  summary?: string;
  instructions?: string;
  artifacts?: string[];
}

export interface PlanRevision {
  feedback: string;
  content: string;
}

export interface RunPlan {
  content: string;
  approved: boolean;
  approvalMode: "auto" | "interactive";
  revisions: PlanRevision[];
}

export interface AgentRunResult {
  id: string;
  modelName: string;
  task: string;
  workspace: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  messages: ChatMessage[];
  finish?: FinishPayload;
  finalContent?: string;
  commands: CommandResult[];
  files: ArtifactFile[];
  usage: Usage;
  turns: number;
  activeRules?: AppliedRule[];
  activeSkills?: AppliedSkill[];
  plan?: RunPlan;
  toolPermissions?: ToolsConfig;
  workflowAdapter?: string;
  workflowEvents?: WorkflowEvent[];
  workflowRaw?: WorkflowRawArtifact[];
}

export interface ArtifactFile {
  path: string;
  sizeBytes: number;
  preview?: string;
}

export interface ScoreResult {
  score: number;
  overall?: number;
  dimensions?: ScoreDimensionResult[];
  summary: string;
  strengths: string[];
  weaknesses: string[];
  userFeedbackImpact?: string;
  raw?: string;
  usage?: Usage;
}

export interface ScoreDimensionResult {
  key: string;
  label?: string;
  score: number;
  weight: number;
  summary?: string;
}

export interface RunReport {
  run: AgentRunResult;
  userReview?: string;
  score?: ScoreResult;
  reportPaths?: {
    jsonPath?: string;
    markdownPath?: string;
    artifactPath?: string;
  };
}

export interface ArenaReport {
  id: string;
  task: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  results: RunReport[];
  reportPaths?: {
    jsonPath?: string;
    markdownPath?: string;
    artifactPath?: string;
  };
}

export interface StoredRunSummary {
  id: string;
  type: "run" | "arena";
  modelNames: string[];
  taskPreview: string;
  score?: number;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  reportPath?: string;
}

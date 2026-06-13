# SandEval

SandEval is a CLI/TUI tool for evaluating coding agents in a sandboxed workspace. A configured model receives a task, creates artifacts through tool calls, runs its own verification commands, and returns a report with artifacts, command output, token usage, elapsed time, human feedback, and judge-model scoring.

The current implementation is an MVP foundation:

- OpenAI-compatible chat completions
- Anthropic-compatible messages API
- Gemini-compatible generateContent API
- Model selection as `<provider>/<model-id>`, such as `openai/gpt-5.4`
- Command-token auth for using Codex or Claude Code credentials with API model providers
- Command adapters for tools such as Claude Code, Codex CLI, or custom runners
- Custom provider modules
- Filesystem or custom storage modules
- Local, container, or Linux command sandbox backends
- Project contexts with `@context` mentions, copied into each sandbox under `@context/<name>`
- Richer project tools: file search, file replacement, file reads/writes, directory listing, and command execution
- Single-model runs and Arena runs
- Component-based Ink TUI with navigation, back actions, model picking, Arena multi-select, login, config, history, and result panels
- Post-run artifact packaging from sandbox workspaces into the current directory
- Optional post-run human review and judge scoring from the result screen
- JSON and Markdown reports

## Quick Start

```bash
npm install
npm run build
node dist/cli.js init
node dist/cli.js config wizard
node dist/cli.js login codex-cli
node dist/cli.js run --prompt "Create a tiny Node script that prints a haiku" --model mock/mock-agent
node dist/cli.js tui
```

In the TUI, Single and Arena use a chat-style panel. Switch models through the model button row, select project context through `Context @`, or type `@workspace` directly in the message. Generation runs first. After a result is ready, choose `Package artifacts` to create a `.tar.gz` archive in the current directory, or choose `Review & score` to enter optional feedback and score the finished artifact.

`sandeval init` creates `.sandeval/config.json`. The generated config includes a `mock` model so the full loop can be tested without API keys.

## Configuration

Set API keys through environment variables, then edit `.sandeval/config.json`.

```json
{
  "defaultModel": "openai/gpt-5.4",
  "judgeModel": "openai/gpt-5.4",
  "models": [
    {
      "name": "openai",
      "provider": "openai",
      "kind": "openai-compatible",
      "baseUrl": "https://api.openai.com/v1",
      "apiKeyEnv": "OPENAI_API_KEY",
      "model": "gpt-5.4",
      "modelIds": ["gpt-5.4", "gpt-4.1"]
    }
  ]
}
```

`.sandeval/config.json` is intentionally git-ignored because it may contain local command paths or secrets.

Command adapters run in the sandbox workspace by default. They receive a JSON payload on stdin and can use these argument templates:

- `{{task}}`: the original task prompt
- `{{prompt}}`: the full conversation transcript
- `{{sandbox}}`: the current sandbox path

By default a command should return a SandEval JSON response:

```json
{
  "content": "optional assistant text",
  "toolCalls": [
    {
      "id": "call_1",
      "name": "write_file",
      "arguments": {
        "path": "index.js",
        "content": "console.log('hello')"
      }
    }
  ],
  "usage": {
    "inputTokens": 100,
    "outputTokens": 20
  }
}
```

Use `protocol: "plain-final"` for commands that produce a final text answer instead of tool calls. In that mode, SandEval still captures any files the command writes inside the sandbox.

## Commands

```bash
sandeval init
sandeval config wizard
sandeval config show
sandeval config set-default openai/gpt-5.4
sandeval login codex-cli
sandeval auth
sandeval run task.md --model openai/gpt-5.4 --judge openai/gpt-5.4
sandeval run --prompt "Build a CLI calculator" --review "Works, but lacks tests"
sandeval arena task.md --models openai/gpt-5.4,anthropic/claude-sonnet-4-5,gemini/gemini-2.5-pro
sandeval history
sandeval tui
```

## Codex / Claude Code Login

Command models can define auth commands:

```json
{
  "name": "codex-cli",
  "kind": "command",
  "command": "codex",
  "args": ["exec", "--json", "{{task}}"],
  "protocol": "plain-final",
  "auth": {
    "type": "command",
    "loginCommand": "codex",
    "loginArgs": ["login"],
    "checkCommand": "codex",
    "checkArgs": ["--version"]
  }
}
```

Run `sandeval login codex-cli` to launch the configured login flow.

To use a logged-in tool only as a token source for a normal API provider, configure `auth.type: "command-token"` instead of `kind: "command"`:

```json
{
  "name": "anthropic",
  "provider": "anthropic",
  "kind": "anthropic-compatible",
  "baseUrl": "https://api.anthropic.com",
  "model": "claude-sonnet-4-5",
  "modelIds": ["claude-sonnet-4-5", "claude-opus-4-1"],
  "auth": {
    "type": "command-token",
    "tokenCommand": "claude",
    "tokenArgs": ["auth", "token"]
  }
}
```

The token command must print the token on stdout. Codex-backed GPT access can be configured the same way with a command that prints a Codex credential token.

## Contexts

Contexts let an existing project participate in a task without modifying the original files. Selected context files are copied into the run sandbox under `@context/<name>` and summarized in the prompt.

```json
{
  "contexts": [
    {
      "name": "workspace",
      "path": ".",
      "exclude": ["node_modules", "dist", ".git", ".sandeval", "package-lock.json"],
      "maxFiles": 40,
      "maxFileBytes": 12000
    }
  ]
}
```

Use `@workspace` in a prompt or select it in the TUI.

## Custom Provider

Use `kind: "custom"` to load a provider module:

```json
{
  "name": "my-provider",
  "kind": "custom",
  "model": "my-provider",
  "modulePath": "./sandeval-provider.js",
  "exportName": "createProvider",
  "options": {}
}
```

The module should export `createProvider(config)` and return `{ chat(request) }`, where `chat` returns `{ content, toolCalls, usage }`.

## Storage

Filesystem storage writes a JSONL index for history:

```json
{
  "storage": {
    "kind": "filesystem",
    "root": ".sandeval/storage",
    "indexFile": "runs.jsonl"
  }
}
```

Custom storage modules can export `createStorage(config)` returning `saveRun(report)`, `saveArena(report)`, and `listRuns(limit)`.

## Sandbox Notes

`sandbox.mode: "local"` runs commands in an isolated run directory under `.sandeval/runs`, with all model file operations confined to that directory. Local mode is convenient, but commands still run as normal host processes. For stronger command isolation, choose one of the optional open-source sandbox backends:

- `docker`: runs commands in a Docker container.
- `podman`: runs commands in a Podman container.
- `bubblewrap`: runs commands through Bubblewrap (`bwrap`) on Linux.
- `firejail`: runs commands through Firejail on Linux.
- `nsjail`: runs commands through nsjail on Linux.

All modes keep the same SandEval run directory, context copying, and artifact packaging flow. Container modes mount only the run directory at `/workspace` and disable network by default:

```json
{
  "sandbox": {
    "mode": "docker",
    "dockerImage": "node:22-bookworm",
    "network": false
  }
}
```

Docker can also use gVisor's `runsc` runtime when it is installed and registered with Docker:

```json
{
  "sandbox": {
    "mode": "docker",
    "dockerImage": "node:22-bookworm",
    "dockerRuntime": "runsc",
    "network": false
  }
}
```

Podman uses the same `/workspace` contract:

```json
{
  "sandbox": {
    "mode": "podman",
    "podmanImage": "node:22-bookworm",
    "network": false
  }
}
```

For Linux host sandbox tools, install the selected binary and set `sandbox.mode` to `bubblewrap`, `firejail`, or `nsjail`. You can pass backend-specific flags with `sandboxExtraArgs`:

```json
{
  "sandbox": {
    "mode": "bubblewrap",
    "network": false,
    "sandboxExtraArgs": ["--hostname", "sandeval"]
  }
}
```

`nsjail` also requires an absolute root filesystem path. SandEval bind-mounts the run directory into that rootfs at `/workspace`:

```json
{
  "sandbox": {
    "mode": "nsjail",
    "nsjailRootfs": "/opt/sandeval-rootfs",
    "network": false
  }
}
```

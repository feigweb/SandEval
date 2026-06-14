# Configuration

SandEval stores configuration in `.sandeval/config.json`. Use `sandeval init` to create a default config.

## Config Wizard

```bash
sandeval config wizard
```

The wizard walks through provider setup, sandbox mode, tools, scoring dimensions, and UI preferences. It appends new model entries instead of replacing existing ones.

## Config Structure

```json
{
  "version": 1,
  "defaultModel": "openai/gpt-5.4",
  "judgeModel": "openai/gpt-5.4",
  "sandbox": { ... },
  "tools": { ... },
  "agent": { ... },
  "scoring": { ... },
  "arena": { ... },
  "workflow": { ... },
  "storage": { ... },
  "ui": { ... },
  "rules": [ ... ],
  "skills": { ... },
  "contexts": [ ... ],
  "models": [ ... ]
}
```

## Providers

### OpenAI-Compatible

```json
{
  "name": "openai",
  "provider": "openai",
  "kind": "openai-compatible",
  "baseUrl": "https://api.openai.com/v1",
  "apiKeyEnv": "OPENAI_API_KEY",
  "model": "gpt-5.4",
  "modelIds": ["gpt-5.4", "gpt-4.1"]
}
```

### Anthropic-Compatible

```json
{
  "name": "anthropic",
  "provider": "anthropic",
  "kind": "anthropic-compatible",
  "baseUrl": "https://api.anthropic.com",
  "apiKeyEnv": "ANTHROPIC_API_KEY",
  "model": "claude-sonnet-4-5",
  "modelIds": ["claude-sonnet-4-5", "claude-opus-4-1"]
}
```

### Ollama / LM Studio

```json
{
  "name": "ollama",
  "kind": "openai-compatible",
  "baseUrl": "http://localhost:11434/v1",
  "apiKey": "ollama",
  "model": "qwen2.5-coder:latest",
  "modelIds": ["qwen2.5-coder:latest", "llama3.1:latest"]
}
```

### Command Models

Command adapters run external agent CLIs in the sandbox:

```json
{
  "name": "codex-cli",
  "kind": "command",
  "command": "codex",
  "args": ["exec", "--json", "{{task}}"],
  "protocol": "plain-final",
  "workflowAdapter": "codex"
}
```

Supported adapters: `codex`, `claude-code`, `jsonl`, `none`.

### Custom Provider

Load a provider module:

```json
{
  "name": "my-provider",
  "kind": "custom",
  "modulePath": "./sandeval-provider.js",
  "exportName": "createProvider",
  "options": {}
}
```

## Sandbox

| Mode | Description |
|------|-------------|
| `local` | Commands run in isolated run directory under `.sandeval/runs` |
| `docker` | Commands run in Docker container |
| `podman` | Commands run in Podman container |
| `bubblewrap` | Linux Bubblewrap (`bwrap`) |
| `firejail` | Linux Firejail |
| `nsjail` | Linux nsjail |
| `external` | Third-party sandbox adapter |

```json
{
  "sandbox": {
    "mode": "docker",
    "dockerImage": "node:22-bookworm",
    "network": false
  }
}
```

## Tools

```json
{
  "tools": {
    "files": true,
    "shell": true,
    "git": "full",
    "gitRemote": false,
    "packageManager": true,
    "maxCommandTimeoutMs": 120000,
    "blockedCommands": ["shutdown", "reboot"]
  }
}
```

## Scoring

Multi-dimensional scoring with weights:

```json
{
  "scoring": {
    "enabled": true,
    "mode": "multi",
    "maxRetries": 2,
    "dimensions": [
      { "key": "taskSatisfaction", "label": "Task", "weight": 30 },
      { "key": "correctness", "label": "Correctness", "weight": 25 },
      { "key": "runnability", "label": "Runnable", "weight": 15 },
      { "key": "codeQuality", "label": "Quality", "weight": 15 },
      { "key": "workflowQuality", "label": "Workflow", "weight": 10 },
      { "key": "userFeedbackImpact", "label": "Feedback", "weight": 5 }
    ]
  }
}
```

## Context Trimming

Controls how much context is sent to the model per request:

```json
{
  "agent": {
    "contextTrimmer": {
      "maxTokens": 32000,
      "maxMessages": 30,
      "truncateCodeBlocks": true,
      "truncateAssistantReplies": true
    }
  }
}
```

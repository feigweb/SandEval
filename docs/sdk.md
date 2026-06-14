# SDK Usage

SandEval can be embedded in Node.js applications.

## Installation

```bash
npm install sandeval
```

## Basic Usage

```ts
import { createSandEval } from "sandeval";

const sandeval = await createSandEval({ cwd: process.cwd() });

// Run a single task
const report = await sandeval.run({
  prompt: "Create a tiny Node script that prints ok",
  modelName: "openai/gpt-5.4",
  judgeName: "openai/gpt-5.4"
});

console.log(report.score?.score);

// Run an arena comparison
const arena = await sandeval.arena({
  prompt: "Build a minimal landing page",
  models: ["openai/gpt-5.4", "anthropic/claude-sonnet-4-5"],
  concurrency: 2
});

// Generate score dashboard
const dashboard = await sandeval.modelScoreDashboard("openai/gpt-5.4");
console.log(dashboard.htmlPath);
```

## API Reference

### `createSandEval(options)`

Creates a SandEval instance.

```ts
interface SandEvalSdkOptions {
  cwd?: string;           // Working directory (default: process.cwd())
  configPath?: string;    // Custom config path
}
```

### `sandeval.run(options)`

Runs a single task.

```ts
interface SdkRunOptions {
  prompt?: string;        // Task prompt
  taskFile?: string;      // Path to task file
  modelName?: string;     // Model to use
  judgeName?: string;     // Judge model for scoring
  userReview?: string;    // Optional human feedback
  score?: boolean;        // Enable/disable scoring
  maxTurns?: number;      // Max agent turns
  contextNames?: string[]; // Context names to attach
}
```

### `sandeval.arena(options)`

Runs multiple models on the same task.

```ts
interface SdkArenaOptions {
  prompt?: string;
  taskFile?: string;
  models?: string[];
  concurrency?: number;
  judgeName?: string;
  userReview?: string;
  score?: boolean;
}
```

### `sandeval.modelScoreDashboard(modelName)`

Generates an HTML dashboard for model scores.

## Exports

```ts
// Core functions
export { runTask, runArena, scoreRun, createSandEval };

// Config helpers
export { loadConfig, saveConfig, findModel, listModelNames };

// Storage
export { createStorage, ensureStorage, FileStorage };

// Analytics
export { buildModelScoreIndex, generateModelScoreDashboard };

// Types
export type { RunReport, ArenaReport, ScoreResult, ModelConfig, ... };
```

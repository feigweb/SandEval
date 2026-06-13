import { spawn } from "node:child_process";
import password from "@inquirer/password";
import type { ModelConfig, SandEvalConfig } from "./types.js";
import { findModel, saveConfig } from "./config.js";

export async function loginModel(options: {
  config: SandEvalConfig;
  cwd: string;
  modelName?: string;
  configPath?: string;
  apiKey?: string;
  store?: "config" | "env";
}): Promise<string> {
  const model = findModel(options.config, options.modelName);
  const auth = model.auth;

  if (auth?.type === "command-token") {
    return `Model "${model.name}" uses command-token auth; no agent login is required. Configure auth.tokenCommand to emit a token.`;
  }

  if (auth?.type === "command" || model.kind === "command") {
    const command = auth?.loginCommand ?? (model.kind === "command" ? model.command : undefined);
    const args = auth?.loginArgs ?? ["login"];
    if (!command) {
      throw new Error(`Model "${model.name}" has no login command configured.`);
    }
    const exitCode = await runInteractiveCommand(command, args, auth?.cwd ?? options.cwd, {
      ...process.env,
      ...auth?.env
    });
    if (exitCode !== 0) {
      throw new Error(`Login command exited with code ${exitCode}.`);
    }
    return `Login command completed for ${model.name}.`;
  }

  if (isApiKeyModel(model)) {
    const envName = model.auth?.apiKeyEnv ?? model.apiKeyEnv ?? `${model.name.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_API_KEY`;
    const key =
      options.apiKey ??
      (await password({
        message: `API key for ${model.name} (${envName})`,
        mask: "*",
        validate: (value) => (value.trim() ? true : "API key is required")
      }));

    if (options.store === "config") {
      model.apiKey = key;
      model.apiKeyEnv = undefined;
      await saveConfig(options.config, options.cwd, options.configPath);
      return `Stored API key in config for ${model.name}.`;
    }

    process.env[envName] = key;
    return `API key loaded into current process as ${envName}. Add it to your shell profile for future sessions.`;
  }

  return `Model "${model.name}" does not require login.`;
}

export async function checkModelAuth(model: ModelConfig, cwd = process.cwd()): Promise<{ ok: boolean; message: string }> {
  const auth = model.auth;
  if (auth?.type === "command-token") {
    if (!auth.tokenCommand) {
      return { ok: false, message: "Missing auth.tokenCommand." };
    }
    const exitCode = await runCaptureCommand(auth.tokenCommand, auth.tokenArgs ?? [], auth.cwd ?? cwd, {
      ...process.env,
      ...auth.env
    });
    return { ok: exitCode.ok, message: exitCode.ok ? "Token command returned a token." : exitCode.message };
  }
  if (auth?.type === "command") {
    const command = auth.checkCommand ?? auth.loginCommand;
    if (!command) {
      return { ok: false, message: "No auth check command configured." };
    }
    const exitCode = await runInteractiveCommand(command, auth.checkArgs ?? ["--version"], auth.cwd ?? cwd, {
      ...process.env,
      ...auth.env
    });
    return { ok: exitCode === 0, message: exitCode === 0 ? "Command auth check passed." : `Exited with ${exitCode}.` };
  }

  if (isApiKeyModel(model)) {
    const envName = model.auth?.apiKeyEnv ?? model.apiKeyEnv;
    if (model.apiKey || (envName && process.env[envName])) {
      return { ok: true, message: "API key is available." };
    }
    return { ok: false, message: `Missing API key${envName ? ` in ${envName}` : ""}.` };
  }

  return { ok: true, message: "No auth required." };
}

function runCaptureCommand(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv
): Promise<{ ok: boolean; message: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, env, shell: false });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => resolve({ ok: false, message: error.message }));
    child.on("close", (exitCode) => {
      if (exitCode !== 0) {
        resolve({ ok: false, message: `Token command exited with ${exitCode}: ${stderr}` });
        return;
      }
      resolve(stdout.trim() ? { ok: true, message: "ok" } : { ok: false, message: "Token command produced no stdout." });
    });
  });
}

function isApiKeyModel(model: ModelConfig): model is Extract<ModelConfig, { kind: "openai-compatible" | "anthropic-compatible" | "gemini-compatible" }> {
  return model.kind === "openai-compatible" || model.kind === "anthropic-compatible" || model.kind === "gemini-compatible";
}

function runInteractiveCommand(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv
): Promise<number | null> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: "inherit",
      shell: false
    });
    child.on("error", (error) => {
      console.error(error.message);
      resolve(1);
    });
    child.on("close", resolve);
  });
}

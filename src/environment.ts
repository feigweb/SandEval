import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { access } from "node:fs/promises";
import path from "node:path";
import { confirm } from "@inquirer/prompts";
import type { SandboxConfig, SandboxMode } from "./types.js";

export interface EnvironmentDependency {
  name: string;
  command: string;
  mode: SandboxMode;
  installCommand?: string[];
  installNote: string;
}

export interface EnvironmentCheckResult {
  ok: boolean;
  missing: EnvironmentDependency[];
}

export async function checkSandboxEnvironment(config: SandboxConfig = {}): Promise<EnvironmentCheckResult> {
  const dependency = sandboxDependency(config);
  if (!dependency) {
    return { ok: true, missing: [] };
  }
  const available = await commandExists(dependency.command);
  return available ? { ok: true, missing: [] } : { ok: false, missing: [dependency] };
}

export async function ensureSandboxEnvironment(options: {
  sandbox?: SandboxConfig;
  prompt?: boolean;
  context: "wizard" | "run" | "tui" | "web";
}): Promise<void> {
  const result = await checkSandboxEnvironment(options.sandbox);
  if (result.ok) {
    return;
  }

  const dependency = result.missing[0];
  if (!dependency) {
    return;
  }
  const installText = formatInstallSuggestion(dependency);
  if (!options.prompt || !process.stdin.isTTY) {
    throw new Error(`${dependency.name} is required for sandbox.mode "${dependency.mode}" but "${dependency.command}" was not found.\n${installText}`);
  }

  if (!dependency.installCommand) {
    if (options.context === "wizard") {
      const keepConfig = await confirm({
        message: `${dependency.name} is missing and cannot be installed automatically here. Keep this sandbox setting and install it manually later?`,
        default: true
      });
      if (keepConfig) {
        return;
      }
    }
    throw new Error(`${dependency.name} cannot be installed automatically on this system.\n${installText}`);
  }

  const shouldInstall = await confirm({
    message: `${dependency.name} is required for sandbox.mode "${dependency.mode}" but is not installed. Install it now?`,
    default: false
  });
  if (!shouldInstall) {
    if (options.context === "wizard") {
      return;
    }
    throw new Error(`${dependency.name} is not installed.\n${installText}`);
  }

  const [command, ...args] = dependency.installCommand;
  const resultAfterInstall = await runInstaller(command, args);
  if (resultAfterInstall.exitCode !== 0) {
    throw new Error(
      [
        `${dependency.name} installation failed with exit code ${resultAfterInstall.exitCode}.`,
        `$ ${dependency.installCommand.join(" ")}`,
        resultAfterInstall.stderr ? `stderr:\n${resultAfterInstall.stderr}` : "",
        resultAfterInstall.stdout ? `stdout:\n${resultAfterInstall.stdout}` : "",
        installText
      ]
        .filter(Boolean)
        .join("\n\n")
    );
  }

  const available = await commandExists(dependency.command);
  if (!available) {
    throw new Error(`${dependency.name} installer finished, but "${dependency.command}" is still not on PATH.\n${installText}`);
  }
}

export function sandboxDependency(config: SandboxConfig = {}): EnvironmentDependency | undefined {
  const mode = config.mode ?? "local";
  if (mode === "local") {
    return undefined;
  }
  if (mode === "docker") {
    return dependency("Docker", "docker", mode);
  }
  if (mode === "podman") {
    return dependency("Podman", "podman", mode);
  }
  if (mode === "bubblewrap") {
    return dependency("Bubblewrap", "bwrap", mode);
  }
  if (mode === "firejail") {
    return dependency("Firejail", "firejail", mode);
  }
  if (mode === "nsjail") {
    return dependency("nsjail", "nsjail", mode);
  }
  if (mode === "external") {
    const command = config.external?.command;
    if (!command) {
      return undefined;
    }
    return {
      name: `External sandbox command (${command})`,
      command,
      mode,
      installNote: `Install "${command}" with your system package manager or update sandbox.external.command.`
    };
  }
  return undefined;
}

function dependency(name: string, command: string, mode: SandboxMode): EnvironmentDependency {
  const installCommand = detectInstallCommand(command);
  return {
    name,
    command,
    mode,
    installCommand,
    installNote: installCommand
      ? `Suggested install command: ${installCommand.join(" ")}`
      : `Install "${command}" with your system package manager, then re-run SandEval.`
  };
}

function detectInstallCommand(command: string): string[] | undefined {
  if (process.platform === "darwin") {
    if (!commandExistsSync("brew")) {
      return undefined;
    }
    if (command === "docker") return ["brew", "install", "--cask", "docker"];
    if (command === "podman") return ["brew", "install", "podman"];
    return undefined;
  }
  if (process.platform !== "linux") {
    return undefined;
  }
  const packageName = command === "bwrap" ? "bubblewrap" : command;
  if (commandExistsSync("apt-get")) return ["sudo", "apt-get", "install", "-y", packageName];
  if (commandExistsSync("dnf")) return ["sudo", "dnf", "install", "-y", packageName];
  if (commandExistsSync("yum")) return ["sudo", "yum", "install", "-y", packageName];
  if (commandExistsSync("pacman")) return ["sudo", "pacman", "-S", "--needed", packageName];
  if (commandExistsSync("zypper")) return ["sudo", "zypper", "install", "-y", packageName];
  return undefined;
}

function formatInstallSuggestion(dependency: EnvironmentDependency): string {
  return dependency.installNote;
}

async function commandExists(command: string): Promise<boolean> {
  if (command.includes(path.sep)) {
    try {
      await access(command);
      return true;
    } catch {
      return false;
    }
  }
  return commandExistsSync(command);
}

function commandExistsSync(command: string): boolean {
  if (command.includes(path.sep)) {
    return existsSync(command);
  }
  const pathEnv = process.env.PATH ?? "";
  const extensions = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  for (const directory of pathEnv.split(path.delimiter)) {
    for (const extension of extensions) {
      if (existsSync(path.join(directory, `${command}${extension}`))) {
        return true;
      }
    }
  }
  return false;
}

async function runInstaller(command: string, args: string[]): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: ["inherit", "pipe", "pipe"],
      shell: false
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stdout += text;
      process.stdout.write(text);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stderr += text;
      process.stderr.write(text);
    });
    child.on("error", (error) => {
      stderr += `${error.message}\n`;
    });
    child.on("close", (exitCode) => {
      resolve({ exitCode, stdout, stderr });
    });
  });
}

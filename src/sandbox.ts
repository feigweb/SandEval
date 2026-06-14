import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CommandResult, SandboxConfig } from "./types.js";
import { ensureDir, truncate } from "./utils.js";

const DEFAULT_CONTAINER_IMAGE = "node:22-bookworm";

export class Sandbox {
  readonly root: string;
  readonly config: SandboxConfig;
  readonly commandResults: CommandResult[] = [];

  constructor(root: string, config: SandboxConfig = {}) {
    this.root = root;
    this.config = config;
  }

  async init(): Promise<void> {
    await ensureDir(this.root);
  }

  async writeFile(relativePath: string, content: string): Promise<{ path: string; bytes: number }> {
    const target = this.resolveInside(relativePath);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, "utf8");
    return { path: path.relative(this.root, target), bytes: Buffer.byteLength(content) };
  }

  async readFile(relativePath: string): Promise<string> {
    const target = this.resolveInside(relativePath);
    if (!existsSync(target)) {
      throw new Error(`File not found: ${relativePath}`);
    }
    return readFile(target, "utf8");
  }

  async listFiles(relativePath = "."): Promise<string[]> {
    const target = this.resolveInside(relativePath);
    const entries = await readdir(target, { withFileTypes: true });
    return entries
      .map((entry) => `${entry.name}${entry.isDirectory() ? "/" : ""}`)
      .sort((a, b) => a.localeCompare(b));
  }

  async searchFiles(query: string, relativePath = "."): Promise<Array<{ path: string; line: number; text: string }>> {
    const root = this.resolveInside(relativePath);
    const results: Array<{ path: string; line: number; text: string }> = [];
    await this.searchWalk(root, query, results);
    return results.slice(0, 100);
  }

  async replaceInFile(relativePath: string, search: string, replace: string, all = false): Promise<{ path: string; replacements: number }> {
    const target = this.resolveInside(relativePath);
    const content = await readFile(target, "utf8");
    const count = all ? content.split(search).length - 1 : content.includes(search) ? 1 : 0;
    if (count === 0) {
      throw new Error(`Text not found in ${relativePath}`);
    }
    const next = all ? content.split(search).join(replace) : content.replace(search, replace);
    await writeFile(target, next, "utf8");
    return { path: relativePath, replacements: count };
  }

  async runCommand(command: string, args: string[] = [], timeoutMs?: number): Promise<CommandResult> {
    let result: CommandResult;
    switch (this.config.mode ?? "local") {
      case "docker":
        result = await this.runDocker(command, args, timeoutMs);
        break;
      case "podman":
        result = await this.runPodman(command, args, timeoutMs);
        break;
      case "bubblewrap":
        result = await this.runBubblewrap(command, args, timeoutMs);
        break;
      case "firejail":
        result = await this.runFirejail(command, args, timeoutMs);
        break;
      case "nsjail":
        result = await this.runNsJail(command, args, timeoutMs);
        break;
      case "external":
        result = await this.runExternal(command, args, timeoutMs);
        break;
      case "local":
        result = await this.runLocal(command, args, timeoutMs);
        break;
    }
    this.commandResults.push(result);
    return result;
  }

  resolveInside(relativePath: string): string {
    if (!relativePath || relativePath.includes("\0")) {
      throw new Error("Invalid sandbox path.");
    }

    const normalized = path.resolve(this.root, relativePath);
    const rootWithSep = this.root.endsWith(path.sep) ? this.root : `${this.root}${path.sep}`;
    if (normalized !== this.root && !normalized.startsWith(rootWithSep)) {
      throw new Error(`Path escapes sandbox: ${relativePath}`);
    }
    return normalized;
  }

  private async runLocal(command: string, args: string[], timeoutMs?: number): Promise<CommandResult> {
    return runProcess({
      command,
      args,
      cwd: this.root,
      env: this.processEnv(),
      timeoutMs: this.timeout(timeoutMs)
    });
  }

  private async runDocker(command: string, args: string[], timeoutMs?: number): Promise<CommandResult> {
    const image = this.config.dockerImage ?? DEFAULT_CONTAINER_IMAGE;
    const dockerArgs = [
      "run",
      "--rm",
      "-i",
      "-v",
      `${this.root}:/workspace`,
      "-w",
      "/workspace"
    ];

    if (this.config.dockerRuntime?.trim()) {
      dockerArgs.push("--runtime", this.config.dockerRuntime.trim());
    }

    if (this.config.network === false || this.config.network === undefined) {
      dockerArgs.push("--network", "none");
    }

    dockerArgs.push(...this.extraArgs());
    dockerArgs.push(image, command, ...args);
    return runProcess({
      command: "docker",
      args: dockerArgs,
      cwd: this.root,
      env: this.processEnv(),
      timeoutMs: this.timeout(timeoutMs),
      displayCommand: command,
      displayArgs: args
    });
  }

  private async runPodman(command: string, args: string[], timeoutMs?: number): Promise<CommandResult> {
    const image = this.config.podmanImage ?? this.config.dockerImage ?? DEFAULT_CONTAINER_IMAGE;
    const podmanArgs = [
      "run",
      "--rm",
      "-i",
      "-v",
      `${this.root}:/workspace:Z`,
      "-w",
      "/workspace"
    ];

    if (this.config.network === false || this.config.network === undefined) {
      podmanArgs.push("--network", "none");
    }

    podmanArgs.push(...this.extraArgs());
    podmanArgs.push(image, command, ...args);
    return runProcess({
      command: "podman",
      args: podmanArgs,
      cwd: this.root,
      env: this.processEnv(),
      timeoutMs: this.timeout(timeoutMs),
      displayCommand: command,
      displayArgs: args
    });
  }

  private async runBubblewrap(command: string, args: string[], timeoutMs?: number): Promise<CommandResult> {
    const bubblewrapArgs = [
      "--die-with-parent",
      "--new-session",
      "--unshare-pid",
      "--unshare-ipc",
      "--unshare-uts",
      "--proc",
      "/proc",
      "--dev",
      "/dev",
      "--tmpfs",
      "/tmp",
      "--ro-bind",
      "/usr",
      "/usr",
      "--ro-bind-try",
      "/bin",
      "/bin",
      "--ro-bind-try",
      "/lib",
      "/lib",
      "--ro-bind-try",
      "/lib64",
      "/lib64",
      "--ro-bind-try",
      "/etc",
      "/etc",
      "--bind",
      this.root,
      "/workspace",
      "--chdir",
      "/workspace"
    ];

    if (this.config.network === false || this.config.network === undefined) {
      bubblewrapArgs.push("--unshare-net");
    }

    bubblewrapArgs.push(...this.extraArgs(), command, ...args);
    return runProcess({
      command: "bwrap",
      args: bubblewrapArgs,
      cwd: this.root,
      env: this.processEnv(),
      timeoutMs: this.timeout(timeoutMs),
      displayCommand: command,
      displayArgs: args
    });
  }

  private async runFirejail(command: string, args: string[], timeoutMs?: number): Promise<CommandResult> {
    const firejailArgs = [
      "--quiet",
      "--noprofile",
      `--private=${this.root}`,
      "--private-tmp",
      "--caps.drop=all",
      "--seccomp",
      "--nonewprivs",
      "--nogroups"
    ];

    if (this.config.network === false || this.config.network === undefined) {
      firejailArgs.push("--net=none");
    }

    firejailArgs.push(...this.extraArgs(), "--", command, ...args);
    return runProcess({
      command: "firejail",
      args: firejailArgs,
      cwd: this.root,
      env: this.processEnv(),
      timeoutMs: this.timeout(timeoutMs),
      displayCommand: command,
      displayArgs: args
    });
  }

  private async runNsJail(command: string, args: string[], timeoutMs?: number): Promise<CommandResult> {
    const rootfs = this.config.nsjailRootfs;
    if (!rootfs || !path.isAbsolute(rootfs)) {
      throw new Error("sandbox.mode is nsjail but sandbox.nsjailRootfs is not an absolute path.");
    }

    const nsjailArgs = [
      "-Mo",
      "--quiet",
      "--chroot",
      rootfs,
      "--cwd",
      "/workspace",
      "--bindmount",
      `${this.root}:/workspace`,
      "--tmpfsmount",
      "/tmp",
      "--time_limit",
      String(Math.ceil(this.timeout(timeoutMs) / 1000))
    ];

    if (this.config.network === true) {
      nsjailArgs.push("--disable_clone_newnet");
    }

    nsjailArgs.push(...this.extraArgs(), "--", command, ...args);
    return runProcess({
      command: "nsjail",
      args: nsjailArgs,
      cwd: this.root,
      env: this.processEnv(),
      timeoutMs: this.timeout(timeoutMs),
      displayCommand: command,
      displayArgs: args
    });
  }

  private async runExternal(command: string, args: string[], timeoutMs?: number): Promise<CommandResult> {
    const external = this.config.external;
    if (!external?.command) {
      throw new Error("sandbox.mode is external but sandbox.external.command is not configured.");
    }
    const encodedArgs = JSON.stringify(args);
    const externalArgs = (external.args ?? ["{{command}}", "{{argsJson}}"]).flatMap((arg) =>
      expandExternalArg(arg, {
        workspace: this.root,
        command,
        args,
        argsJson: encodedArgs
      })
    );
    const raw = await runProcess({
      command: external.command,
      args: externalArgs,
      cwd: external.cwd ? path.resolve(external.cwd) : this.root,
      env: { ...this.processEnv(), ...external.env },
      timeoutMs: this.timeout(timeoutMs ?? external.timeoutMs),
      displayCommand: command,
      displayArgs: args
    });
    const parsed = parseExternalResult(raw.stdout);
    if (!parsed) {
      return raw;
    }
    return {
      command,
      args,
      exitCode: parsed.exitCode ?? raw.exitCode,
      stdout: parsed.stdout ?? "",
      stderr: parsed.stderr ?? "",
      durationMs: parsed.durationMs ?? raw.durationMs,
      timedOut: parsed.timedOut ?? raw.timedOut
    };
  }

  private timeout(timeoutMs?: number): number {
    return timeoutMs ?? this.config.commandTimeoutMs ?? 120000;
  }

  private processEnv(): NodeJS.ProcessEnv {
    return { ...process.env, ...this.config.env };
  }

  private extraArgs(): string[] {
    return this.config.sandboxExtraArgs ?? [];
  }

  private async searchWalk(current: string, query: string, results: Array<{ path: string; line: number; text: string }>): Promise<void> {
    if (results.length >= 100) {
      return;
    }
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === ".git" || entry.name === "node_modules") {
        continue;
      }
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await this.searchWalk(fullPath, query, results);
      } else if (entry.isFile() && /\.(txt|md|json|js|jsx|ts|tsx|mjs|cjs|css|html|py|go|rs|java|sh|yaml|yml|toml)$/i.test(entry.name)) {
        const content = await readFile(fullPath, "utf8");
        content.split(/\r?\n/).forEach((line, index) => {
          if (line.includes(query) && results.length < 100) {
            results.push({ path: path.relative(this.root, fullPath), line: index + 1, text: truncate(line, 300) });
          }
        });
      }
    }
  }
}

function expandExternalArg(
  template: string,
  values: { workspace: string; command: string; args: string[]; argsJson: string }
): string[] {
  if (template === "{{args}}") {
    return values.args;
  }
  return [
    template
      .replaceAll("{{workspace}}", values.workspace)
      .replaceAll("{{sandbox}}", values.workspace)
      .replaceAll("{{command}}", values.command)
      .replaceAll("{{argsJson}}", values.argsJson)
  ];
}

function parseExternalResult(stdout: string): Partial<CommandResult> | undefined {
  const trimmed = stdout.trim();
  if (!trimmed.startsWith("{")) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(trimmed) as Partial<CommandResult>;
    if (typeof parsed.exitCode === "number" || parsed.exitCode === null) {
      return {
        exitCode: parsed.exitCode,
        stdout: typeof parsed.stdout === "string" ? parsed.stdout : "",
        stderr: typeof parsed.stderr === "string" ? parsed.stderr : "",
        durationMs: typeof parsed.durationMs === "number" ? parsed.durationMs : undefined,
        timedOut: typeof parsed.timedOut === "boolean" ? parsed.timedOut : undefined
      };
    }
  } catch {
    return undefined;
  }
  return undefined;
}

async function runProcess(options: {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  displayCommand?: string;
  displayArgs?: string[];
}): Promise<CommandResult> {
  const started = Date.now();

  return new Promise((resolve) => {
    const child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: options.env,
      shell: false
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, options.timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      stderr += `${error.message}\n`;
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        command: options.displayCommand ?? options.command,
        args: options.displayArgs ?? options.args,
        exitCode: code,
        stdout: truncate(stdout, 20000),
        stderr: truncate(stderr, 20000),
        durationMs: Date.now() - started,
        timedOut
      });
    });
  });
}

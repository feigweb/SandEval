import { spawn } from "node:child_process";

export function createProvider(config) {
  return {
    name: config.name,
    async chat(request) {
      const task = request.messages.find((message) => message.role === "user")?.content ?? "";
      const sandbox = request.metadata?.sandbox ?? process.cwd();
      const command = config.options?.command ?? config.model ?? config.name;
      const args = config.options?.args ?? ["run", "{{task}}"];
      const result = await run(command, args.map((arg) => String(arg).replaceAll("{{task}}", task).replaceAll("{{sandbox}}", sandbox)), sandbox);

      if (result.exitCode !== 0) {
        throw new Error(`Custom provider command failed with exit code ${result.exitCode}:\n${result.stderr}`);
      }

      return {
        content: result.stdout || "Custom provider completed.",
        toolCalls: [],
        usage: {
          inputTokens: Math.ceil(task.length / 4),
          outputTokens: Math.ceil(result.stdout.length / 4),
          totalTokens: Math.ceil((task.length + result.stdout.length) / 4)
        },
        raw: result
      };
    }
  };
}

function run(command, args, cwd) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      shell: false
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      stderr += error.message + "\n";
    });
    child.on("close", (exitCode) => {
      resolve({ command, args, cwd, exitCode, stdout, stderr });
    });
  });
}

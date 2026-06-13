import { spawn } from "node:child_process";
import { cp, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ArenaReport, RunReport } from "./types.js";
import { ensureDir } from "./utils.js";

export async function packageRunArtifacts(report: RunReport, outputDir: string): Promise<string> {
  await ensureDir(outputDir);
  const archivePath = path.resolve(outputDir, `${report.run.id}-artifacts.tar.gz`);
  await tarDirectory(report.run.workspace, archivePath, ".");
  report.reportPaths = {
    ...report.reportPaths,
    artifactPath: archivePath
  };
  return archivePath;
}

export async function packageArenaArtifacts(report: ArenaReport, outputDir: string): Promise<string> {
  await ensureDir(outputDir);
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "sandeval-arena-"));
  try {
    for (const result of report.results) {
      const target = path.join(tempRoot, safeName(result.run.modelName), result.run.id);
      await cp(result.run.workspace, target, {
        recursive: true,
        force: true,
        errorOnExist: false
      });
    }
    const archivePath = path.resolve(outputDir, `${report.id}-artifacts.tar.gz`);
    await tarDirectory(tempRoot, archivePath, ".");
    report.reportPaths = {
      ...report.reportPaths,
      artifactPath: archivePath
    };
    return archivePath;
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

function tarDirectory(cwd: string, archivePath: string, target: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("tar", ["-czf", archivePath, target], {
      cwd,
      shell: false
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (exitCode) => {
      if (exitCode === 0) {
        resolve();
      } else {
        reject(new Error(`tar exited with ${exitCode}: ${stderr}`));
      }
    });
  });
}

function safeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 60) || "model";
}

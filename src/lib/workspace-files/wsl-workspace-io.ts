/**
 * Workspace file I/O routed through WSL.
 *
 * When the app runs on Windows and the workspace lives inside WSL, Node fs
 * over `\\wsl.localhost` (9P) is an order of magnitude slower than running
 * the equivalent command inside the distro — and watchers never fire at all.
 * This module mirrors what src/lib/git/git-panel.ts already does for git:
 * spawn the command inside WSL via spawnCli and parse stdout.
 */
import * as path from "path";
import type { SpawnOptions } from "child_process";
import { spawnCli } from "@/lib/cli/spawn-cli";
import { isWindowsHostedWslFilesystemPath } from "@/lib/filesystem/path-environment";
import { getRuntimePlatform } from "@/lib/system/runtime-platform";
import {
  IGNORED_WORKSPACE_DIR_NAMES,
  isIgnoredWorkspacePath,
  MAX_WORKSPACE_FILES,
  type WorkspaceFileWalkResult,
} from "./workspace-file-scan";

const COMMAND_TIMEOUT_MS = 20_000;
const LIST_MAX_BUFFER = 16 * 1024 * 1024;

export class WorkspaceWslIoError extends Error {
  constructor(
    readonly code: "command_failed" | "command_timeout" | "invalid_file_path" | "file_not_found",
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/**
 * True when workspace file I/O should run inside WSL instead of via Node fs:
 * the server is a Windows process and the workspace resolves to a
 * `\\wsl.localhost` (9P) path or a POSIX display path.
 */
export function shouldUseWslWorkspaceIo(
  displayRoot: string | null,
  filesystemRoot: string | null,
): boolean {
  if (getRuntimePlatform() !== "win32") return false;
  if (filesystemRoot && isWindowsHostedWslFilesystemPath(filesystemRoot)) return true;
  return Boolean(displayRoot?.trim().startsWith("/"));
}

function runWslCommand(
  command: string,
  args: string[],
  cwd: string,
  options?: { maxBuffer?: number; tolerateNonZeroWithOutput?: boolean },
): Promise<Buffer> {
  const maxBuffer = options?.maxBuffer ?? LIST_MAX_BUFFER;
  return new Promise((resolve, reject) => {
    const spawnOptions: SpawnOptions = {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    };
    const child = spawnCli(command, args, spawnOptions, "wsl");
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutLength = 0;
    let stderrLength = 0;

    const killTimer = setTimeout(() => {
      reject(new WorkspaceWslIoError(
        "command_timeout",
        `${command} did not respond within ${COMMAND_TIMEOUT_MS / 1000}s`,
        504,
      ));
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }, COMMAND_TIMEOUT_MS);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutLength += chunk.length;
      if (stdoutLength <= maxBuffer) stdoutChunks.push(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrLength += chunk.length;
      if (stderrLength <= 64 * 1024) stderrChunks.push(chunk);
    });

    child.on("close", (code) => {
      clearTimeout(killTimer);
      const stdout = Buffer.concat(stdoutChunks);
      if (code === 0) {
        resolve(stdout);
        return;
      }
      // find/bfs exit non-zero when any directory is unreadable while still
      // listing everything else; partial output is better than no panel.
      if (options?.tolerateNonZeroWithOutput && stdout.byteLength > 0) {
        resolve(stdout);
        return;
      }
      const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
      reject(new WorkspaceWslIoError(
        "command_failed",
        stderr || `Failed to run ${command}`,
        500,
      ));
    });

    child.on("error", (error) => {
      clearTimeout(killTimer);
      reject(new WorkspaceWslIoError(
        "command_failed",
        error.message || `Failed to run ${command}`,
        500,
      ));
    });
  });
}

/**
 * List workspace files by running `find` inside WSL with the same pruning
 * rules as walkWorkspaceFiles: hidden entries (except .env.example) and the
 * shared ignored directory names.
 */
export async function listWorkspaceFilesViaWsl(
  displayRoot: string,
): Promise<WorkspaceFileWalkResult> {
  // -mindepth 1 keeps the "." start dir out of the prune glob (`.*` matches it).
  const pruneArgs: string[] = ["(", "-name", ".*", "!", "-name", ".env.example"];
  for (const name of IGNORED_WORKSPACE_DIR_NAMES) {
    pruneArgs.push("-o", "-name", name);
  }
  pruneArgs.push(")", "-prune", "-o", "-type", "f", "-print");

  const stdout = await runWslCommand(
    "find",
    [".", "-mindepth", "1", ...pruneArgs],
    displayRoot,
    { tolerateNonZeroWithOutput: true },
  );

  const files: string[] = [];
  let truncated = false;
  for (const line of stdout.toString("utf8").split("\n")) {
    const rel = line.replace(/\r$/, "").replace(/^\.\//, "");
    if (!rel || rel === ".") continue;
    // Re-check with the canonical rules so both listing paths stay in sync.
    if (isIgnoredWorkspacePath(rel)) continue;
    files.push(rel);
    if (files.length >= MAX_WORKSPACE_FILES) {
      truncated = true;
      break;
    }
  }
  files.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));
  return { files, truncated };
}

/**
 * Validate and normalize a workspace-relative path for WSL-side reads.
 * Symlink escapes are not resolved here — the CLI agent already has full
 * access to the same tree, matching the git synthetic-diff tradeoff.
 */
export function resolveWslWorkspaceRelativePath(rawPath: string): string {
  if (!rawPath.trim() || rawPath.includes("\0")) {
    throw new WorkspaceWslIoError("invalid_file_path", "Invalid file path", 400);
  }
  const normalized = path.posix.normalize(rawPath.replace(/\\/g, "/"));
  if (normalized.startsWith("/") || normalized === ".." || normalized.startsWith("../")) {
    throw new WorkspaceWslIoError("invalid_file_path", "File path escapes the workspace", 400);
  }
  return normalized;
}

/** File size in bytes via `stat` inside WSL. Throws file_not_found on failure. */
export async function statWorkspaceFileViaWsl(
  displayRoot: string,
  relativePath: string,
): Promise<{ size: number; isFile: boolean }> {
  try {
    const stdout = await runWslCommand(
      "stat",
      ["-c", "%s %F", "--", `./${relativePath}`],
      displayRoot,
      { maxBuffer: 4096 },
    );
    const text = stdout.toString("utf8").trim();
    const size = Number.parseInt(text, 10);
    if (!Number.isFinite(size)) {
      throw new WorkspaceWslIoError("file_not_found", "File not found", 404);
    }
    return { size, isFile: text.includes("regular") };
  } catch (error) {
    if (error instanceof WorkspaceWslIoError && error.code === "command_timeout") throw error;
    throw new WorkspaceWslIoError("file_not_found", "File not found", 404);
  }
}

/** Read up to maxBytes of a workspace file via `head` inside WSL. */
export async function readWorkspaceFileViaWsl(
  displayRoot: string,
  relativePath: string,
  maxBytes: number,
): Promise<Buffer> {
  return runWslCommand(
    "head",
    ["-c", String(maxBytes), "--", `./${relativePath}`],
    displayRoot,
    { maxBuffer: maxBytes + 4096 },
  );
}

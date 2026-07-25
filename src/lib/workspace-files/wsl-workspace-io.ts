import { spawn } from "node:child_process";
import * as path from "node:path";
import logger from "@/lib/logger";
import { isWslDistroRunning, parseWslUncRoot, type WslUncRoot } from "./wsl-inotify-bridge";
import {
  IGNORED_WORKSPACE_DIR_NAMES,
  isIgnoredWorkspacePath,
  MAX_WORKSPACE_FILES,
  type WorkspaceFileWalkResult,
} from "./workspace-file-scan";

/**
 * Fast-path workspace IO for \\wsl.localhost roots.
 *
 * Node fs over the 9P redirector is an order of magnitude slower than running
 * the same operation inside the distro (a full listing measured 3.7s over 9P
 * vs 0.3s native), and fs.realpath/open routinely blow the file route's 2s
 * deadline. Mirroring the inotify bridge, these helpers run `find`/`stat`/
 * `head` via `wsl.exe -d <distro> --exec` and degrade to null on any failure
 * so callers fall back to the plain fs path. A stopped distro is never booted
 * (same principle as the bridge: after `wsl --shutdown`, stay quiet).
 */

const COMMAND_TIMEOUT_MS = 20_000;
const LIST_MAX_BUFFER = 16 * 1024 * 1024;

export class WorkspaceWslIoError extends Error {
  constructor(
    readonly code: "command_failed" | "command_timeout" | "invalid_file_path",
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

function runWslExec(
  root: WslUncRoot,
  args: string[],
  options?: { maxBuffer?: number; tolerateNonZeroWithOutput?: boolean },
): Promise<Buffer> {
  const maxBuffer = options?.maxBuffer ?? LIST_MAX_BUFFER;
  return new Promise((resolve, reject) => {
    const child = spawn("wsl.exe", ["-d", root.distro, "--exec", ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdoutChunks: Buffer[] = [];
    let stdoutLength = 0;
    let stderrTail = "";

    const killTimer = setTimeout(() => {
      reject(new WorkspaceWslIoError(
        "command_timeout",
        `${args[0]} did not respond within ${COMMAND_TIMEOUT_MS / 1000}s`,
        504,
      ));
      child.kill("SIGKILL");
    }, COMMAND_TIMEOUT_MS);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutLength += chunk.length;
      if (stdoutLength <= maxBuffer) stdoutChunks.push(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString("utf8")).slice(-500);
    });

    child.on("close", (code) => {
      clearTimeout(killTimer);
      const stdout = Buffer.concat(stdoutChunks);
      if (code === 0) {
        resolve(stdout);
        return;
      }
      // find exits non-zero when any directory is unreadable while still
      // listing everything else; partial output beats no listing.
      if (options?.tolerateNonZeroWithOutput && stdout.byteLength > 0) {
        resolve(stdout);
        return;
      }
      reject(new WorkspaceWslIoError(
        "command_failed",
        stderrTail.trim() || `Failed to run ${args[0]}`,
        500,
      ));
    });

    child.on("error", (error) => {
      clearTimeout(killTimer);
      reject(new WorkspaceWslIoError(
        "command_failed",
        error.message || `Failed to run ${args[0]}`,
        500,
      ));
    });
  });
}

/** find(1) prune arguments matching the walk's always-ignored directory set. */
export function buildFindPruneArgs(): string[] {
  const args: string[] = ["("];
  let first = true;
  for (const name of IGNORED_WORKSPACE_DIR_NAMES) {
    if (!first) args.push("-o");
    args.push("-name", name);
    first = false;
  }
  args.push(")", "-prune", "-o", "-type", "f", "-print");
  return args;
}

/**
 * List workspace files by running `find` inside the distro. Matches
 * walkWorkspaceFiles semantics on the current base: dotfiles are included
 * (the client filters them via the show-hidden toggle); only the shared
 * ignored directory names are pruned. Returns null when the root is not a
 * WSL UNC path, the distro is not running, or the command fails — callers
 * fall back to the plain fs walk.
 */
export async function listWorkspaceFilesViaWslUnc(
  root: string,
): Promise<WorkspaceFileWalkResult | null> {
  const parsed = parseWslUncRoot(root);
  if (!parsed) return null;
  if (!(await isWslDistroRunning(parsed.distro))) return null;

  let stdout: Buffer;
  try {
    stdout = await runWslExec(
      parsed,
      ["find", parsed.posixPath, "-mindepth", "1", ...buildFindPruneArgs()],
      { tolerateNonZeroWithOutput: true },
    );
  } catch (error) {
    logger.warn({ error, root }, "workspace-files: WSL find listing failed; falling back to fs walk");
    return null;
  }

  const prefix = parsed.posixPath.endsWith("/") ? parsed.posixPath : `${parsed.posixPath}/`;
  const files: string[] = [];
  let truncated = false;
  for (const line of stdout.toString("utf8").split("\n")) {
    const absolute = line.replace(/\r$/, "");
    if (!absolute.startsWith(prefix)) continue;
    const rel = absolute.slice(prefix.length);
    if (!rel) continue;
    // Re-check with the canonical rules so both listing paths stay in sync.
    if (isIgnoredWorkspacePath(rel, undefined, { includeHidden: true })) continue;
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

/** File size/kind via `stat` inside the distro. Null when unavailable. */
export async function statWorkspaceFileViaWslUnc(
  root: string,
  relativePath: string,
): Promise<{ size: number; isFile: boolean } | null> {
  const parsed = parseWslUncRoot(root);
  if (!parsed) return null;
  if (!(await isWslDistroRunning(parsed.distro))) return null;
  try {
    const stdout = await runWslExec(
      parsed,
      ["stat", "-c", "%s %F", "--", path.posix.join(parsed.posixPath, relativePath)],
      { maxBuffer: 4096 },
    );
    const text = stdout.toString("utf8").trim();
    const size = Number.parseInt(text, 10);
    if (!Number.isFinite(size)) return null;
    return { size, isFile: text.includes("regular") };
  } catch {
    return null;
  }
}

/** Read up to maxBytes via `head` inside the distro. Null when unavailable. */
export async function readWorkspaceFileViaWslUnc(
  root: string,
  relativePath: string,
  maxBytes: number,
): Promise<Buffer | null> {
  const parsed = parseWslUncRoot(root);
  if (!parsed) return null;
  if (!(await isWslDistroRunning(parsed.distro))) return null;
  try {
    return await runWslExec(
      parsed,
      ["head", "-c", String(maxBytes), "--", path.posix.join(parsed.posixPath, relativePath)],
      { maxBuffer: maxBytes + 4096 },
    );
  } catch (error) {
    logger.warn({ error, root, relativePath }, "workspace-files: WSL read failed; falling back to fs");
    return null;
  }
}

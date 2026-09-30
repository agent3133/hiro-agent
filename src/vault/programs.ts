/**
 * Running whisper.cpp or ffmpeg once with a fixed argument, and finding a program on PATH — for the Features tab's
 * detection and Test buttons (extras_api.py, #86). Desktop only. Only the program the settings name is run, with an
 * argument that prints and exits (`-h`, `-version`); never a command line from anywhere else.
 */

import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";

import type { ProgramCheck } from "../api/types";
import { programEnv, programPath } from "../core/programPath";
import type { Programs } from "../config/backend";

const TIMEOUT_MS = 15_000;

function isFile(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isFile();
  } catch {
    return false;
  }
}

/** A program on PATH, as `shutil.which` finds it — with Windows' executable extensions, and Homebrew's on macOS. */
function which(name: string): string | null {
  if (/[\\/]/.test(name)) return isFile(name) ? name : null;
  const extensions = process.platform === "win32"
    ? ["", ...(process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").map((e) => e.toLowerCase())] : [""];
  for (const folder of programPath(process.env.PATH).split(delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = join(folder, name + extension);
      if (isFile(candidate)) return candidate;
    }
  }
  return null;
}

function run(program: string, argument: string): Promise<ProgramCheck> {
  const resolved = which(program) ?? (isFile(program) ? program : null);
  if (!resolved) return Promise.resolve({ ok: false, program, said: [], error: `${program} was not found — give its full path` });
  return new Promise((resolve) => {
    const child = execFile(resolved, [argument], { timeout: TIMEOUT_MS, windowsHide: true, encoding: "utf8",
                                                   env: programEnv() },
                           (error, stdout, stderr) => {
      if (error && (error as { killed?: boolean }).killed) {
        resolve({ ok: false, program: resolved, said: [], error: `it did not answer within ${TIMEOUT_MS / 1000} seconds` });
        return;
      }
      const said = `${stdout}${stderr}`.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
      // whisper-cli -h exits non-zero on some builds while printing its usage; that still proves it runs
      const works = code === 0 || said.slice(0, 5).some((l) => l.toLowerCase().includes("usage"));
      resolve({ ok: works, program: resolved, said: said.slice(0, 1), ...(works ? {} : { error: `it exited with code ${code}` }) });
    });
    child.stdin?.end();  // a child never inherits a pipe it could hang on (#65)
  });
}

export const nodePrograms: Programs = {
  run,
  which: async (name) => which(name),
  isFile: async (path) => isFile(path),
};

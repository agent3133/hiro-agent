/**
 * Which program a stdio MCP server's command starts (#391). A server runs with the vault as its working folder, and
 * on Windows a bare command (`npx`, `uvx`) is looked up in the working folder before PATH — by `cross-spawn`, which
 * the MCP SDK spawns through, and by `cmd.exe` for a `.cmd`. A file `npx.cmd` that arrived by sync in the vault's
 * root would then run under an approval given for `npx`. So a bare command is resolved here, on PATH only, to the
 * absolute path that is started; a PATH folder inside the vault is refused.
 */

import { existsSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

import { programPath } from "../core/programPath";
import { McpConfigError } from "./servers";

export interface CommandLookup {
  /** The PATH the server is started with. */
  path: string | undefined;
  /** Windows' executable extensions (`PATHEXT`). */
  pathext?: string;
  platform: string;
  /** The vault's folder: a program in it is not started by its bare name. */
  vaultPath: string;
  isFile?: (path: string) => boolean;
}

function isFile(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isFile();
  } catch {
    return false;
  }
}

/** Whether *path* is *folder* or inside it; case-insensitive on Windows. */
export function isInside(path: string, folder: string, platform: string): boolean {
  if (!folder) return false;
  const fold = (text: string): string => (platform === "win32" ? text.toLowerCase() : text);
  const between = relative(fold(resolve(folder)), fold(resolve(path)));
  return between === "" || (!between.startsWith("..") && !isAbsolute(between));
}

/** The names *command* may have on disk: on Windows with each executable extension, unless it has one already. */
function candidates(command: string, lookup: CommandLookup): string[] {
  if (lookup.platform !== "win32") return [command];
  const extensions = (lookup.pathext || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean).map((e) => e.toLowerCase());
  const lower = command.toLowerCase();
  return extensions.some((extension) => lower.endsWith(extension)) ? [command] : extensions.map((e) => command + e);
}

/**
 * The program *command* starts: a command with a folder in it as written (it was approved as written); a bare name
 * as the absolute path of its first match on PATH, never the working folder. A name not on PATH, or found only in a
 * PATH folder inside the vault, is an error that says so.
 */
export function resolveCommand(server: string, command: string, lookup: CommandLookup): string {
  if (/[\\/]/.test(command)) return command;
  const exists = lookup.isFile ?? isFile;
  const delimiter = lookup.platform === "win32" ? ";" : ":";
  // Only absolute folders: an empty or relative entry ("." included) is the working folder, the vault
  const folders = programPath(lookup.path, lookup.platform).split(delimiter).filter((folder) => folder && isAbsolute(folder));
  for (const folder of folders) {
    for (const name of candidates(command, lookup)) {
      const found = join(folder, name);
      if (!exists(found)) continue;
      if (isInside(found, lookup.vaultPath, lookup.platform)) {
        throw new McpConfigError(`MCP server '${server}' did not start: '${command}' was found at ${found}, inside the vault, and a `
          + "program in the vault is not started by its name. Give the full path of the program to run.");
      }
      return found;
    }
  }
  throw new McpConfigError(`MCP server '${server}' did not start: '${command}' was not found on PATH. Give its full path.`);
}

/**
 * The environment a stdio server is started with: on Windows, `NoDefaultCurrentDirectoryInExePath` keeps `cmd.exe`
 * (which runs a `.cmd` such as `npx.cmd`) and the programs it starts from looking up names in the vault, too.
 */
export function childEnv(env: Record<string, string>, platform: string): Record<string, string> {
  if (platform !== "win32" || "NoDefaultCurrentDirectoryInExePath" in env) return env;
  return { ...env, NoDefaultCurrentDirectoryInExePath: "1" };
}

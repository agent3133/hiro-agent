/**
 * Where the programs the plugin starts are looked for (#124). Obsidian started from the Dock or Finder on macOS gets
 * `PATH=/usr/bin:/bin:/usr/sbin:/sbin`, not the shell's, and Homebrew installs whisper-cli, ffmpeg, node and npx in
 * `/opt/homebrew/bin` (Apple silicon) or `/usr/local/bin` (Intel) — so on macOS those are searched too.
 */

/** Homebrew's program folders, searched after PATH on macOS. */
export const HOMEBREW_BIN = ["/opt/homebrew/bin", "/usr/local/bin"];

/**
 * *path* with the folders this platform's programs may also be in appended, each once. The platform is given by
 * the caller, a desktop adapter: the core reads nothing of Node's `process` (#183).
 */
export function programPath(path: string | undefined, platform: string): string {
  const delimiter = platform === "win32" ? ";" : ":";
  const folders = (path ?? "").split(delimiter).filter(Boolean);
  if (platform === "darwin") for (const folder of HOMEBREW_BIN) if (!folders.includes(folder)) folders.push(folder);
  return folders.join(delimiter);
}

/**
 * The environment for a program the plugin starts: undefined (inherit it) except on macOS, where PATH gains
 * Homebrew's folders — a program's name is looked up in the PATH it is started with.
 */
export function programEnv(env: Record<string, string | undefined>, platform: string):
    Record<string, string | undefined> | undefined {
  return platform === "darwin" ? { ...env, PATH: programPath(env.PATH, platform) } : undefined;
}

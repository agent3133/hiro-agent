/**
 * The folders an agent is restricted to (`vault_scope`), as one value (#419). The check used to be written out at
 * each tool with its own rules — some normalised the folders and some did not, and one (vaultFiles) read a folder
 * that names the vault itself or leaves it as "the whole vault". Here there is one rule, safeResolve's (#135):
 *
 * - no folders, or none given: the whole vault;
 * - each folder normalised (backslashes, `./`, a trailing slash); one that names the vault itself or leaves it
 *   (`.`, `..`, `/`, `C:/`) allows nothing rather than everything;
 * - a path is inside when it is a folder itself or below one, compared as written (a vault's paths keep their case).
 */

import { normalize } from "./paths";

export class Scope {
  private readonly folders: string[];

  private constructor(readonly restricted: boolean, folders: string[]) {
    this.folders = folders;
  }

  /** The scope of an agent's `vault_scope`: null or empty is the whole vault. */
  static of(folders: string[] | null | undefined): Scope {
    if (!folders || !folders.length) return new Scope(false, []);
    const roots = folders.map((folder) => normalize(folder.replace(/\/+$/, "")))
      .filter((root): root is string => Boolean(root));
    return new Scope(true, [...new Set(roots)]);
  }

  /** The folders it allows, normalised; empty for the whole vault — and for a restriction that allows nothing. */
  roots(): string[] {
    return [...this.folders];
  }

  /** Whether *path* (a vault path, "/" or "\" separated) is inside. */
  contains(path: string): boolean {
    if (!this.restricted) return true;
    const clean = normalize(path.replace(/\/+$/, ""));
    if (!clean) return false;
    return this.folders.some((root) => clean === root || clean.startsWith(`${root}/`));
  }
}

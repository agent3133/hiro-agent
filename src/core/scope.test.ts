// Scope, the one type for the folders an agent is restricted to (#419): what it allows, how a folder is read, and the
// tools that take it — search_vault and vaultFiles — finding nothing where a folder allows nothing.
import { describe, expect, it } from "vitest";

import { makeVault } from "./testing/vault";
import { Scope } from "./scope";
import { makeSearchTools } from "./tools/searchTools";
import { vaultFiles } from "./vault";

describe("Scope (#419)", () => {
  it("treats null and an empty list as the whole vault, with no folders to list", () => {
    for (const scope of [Scope.of(null), Scope.of([]), Scope.of(undefined)]) {
      expect(scope.restricted).toBe(false);
      expect(scope.roots()).toEqual([]);
      expect(scope.contains("a.md")).toBe(true);
      expect(scope.contains("Secret/a.md")).toBe(true);
    }
  });

  it("normalises folders given with a trailing slash or a backslash, and allows the folder and what is below it", () => {
    const scope = Scope.of(["Projects/", "Notes\\Daily"]);
    expect(scope.roots()).toEqual(["Projects", "Notes/Daily"]);
    expect(scope.contains("Projects")).toBe(true);
    expect(scope.contains("Projects/a.md")).toBe(true);
    expect(scope.contains("Notes/Daily/x.md")).toBe(true);
  });

  it("does not allow a folder whose name only starts the same as an allowed one, or a folder beside it", () => {
    const scope = Scope.of(["Projects/", "Notes\\Daily"]);
    expect(scope.contains("ProjectsX/a.md")).toBe(false);
    expect(scope.contains("Notes/a.md")).toBe(false);
  });

  it("keeps the letter case of folders, so 'projects' is not inside 'Projects'", () => {
    expect(Scope.of(["Projects"]).contains("projects/a.md")).toBe(false);
  });

  it("allows nothing for a folder that names the vault itself or leaves it", () => {
    for (const folder of [".", "..", "/"]) {
      const scope = Scope.of([folder]);
      expect(scope.restricted).toBe(true);
      expect(scope.roots()).toEqual([]);
      expect(scope.contains("a.md")).toBe(false);
    }
  });

  it("is never inside for a path that leaves the vault, and is inside for one that only names the folder", () => {
    const scope = Scope.of(["Projects"]);
    expect(scope.contains("Projects/../Secret/a.md")).toBe(false);
    expect(scope.contains("Projects/./a.md")).toBe(true);
  });
});

describe("the tools that take a scope, on a folder that allows nothing (#419)", () => {
  it("search_vault with a scope of '.' finds a note that the whole vault holds (control)", async () => {
    const vault = await makeVault({ "Secret/a.md": "zebra" });
    const search = makeSearchTools(vault.vault, null).find((tool) => tool.name === "search_vault");
    expect(search).toBeDefined();
    expect(await search!.run({ query: "zebra" })).toContain("Secret/a.md");
  });

  it("search_vault with a scope of '.' finds nothing, where it used to search the whole vault", async () => {
    const vault = await makeVault({ "Secret/a.md": "zebra" });
    const search = makeSearchTools(vault.vault, ["."]).find((tool) => tool.name === "search_vault");
    expect(search).toBeDefined();
    expect(await search!.run({ query: "zebra" })).not.toContain("Secret/a.md");
  });

  it("vaultFiles with a scope of '..' lists no files, where the whole vault has some (control)", async () => {
    const vault = await makeVault({ "Secret/a.md": "zebra" });
    expect(await vaultFiles(vault.vault, null, () => true)).toContain("Secret/a.md");
  });

  it("vaultFiles with a scope of '..' lists no files", async () => {
    const vault = await makeVault({ "Secret/a.md": "zebra" });
    expect(await vaultFiles(vault.vault, [".."], () => true)).toEqual([]);
  });
});

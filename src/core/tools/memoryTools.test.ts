import { describe, expect, it } from "vitest";

import { makeVault } from "../testing/vault";
import { truncateToTokens } from "./memoryTools";

const PROFILE = ".memory/user-profile.md";

describe("user-profile tools", () => {
  it("say the profile is empty before anything is learned", async () => {
    const vault = await makeVault();
    expect(await vault.tool("read_user_memory").run({})).toBe("(User profile is empty)");
  });

  it("start a profile with every default section and the updated one filled in", async () => {
    const vault = await makeVault();
    const result = await vault.tool("update_user_memory").run({ section: "Preferences", content: "Short answers." });
    const text = await vault.read(PROFILE);
    expect(result).toBe("Updated 'Preferences' in user profile.");
    expect(text).toMatch(/^---\ntype: user-profile\nupdated: \d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\n---\n## Identity\n/);
    expect(text).toContain("## Preferences\n\nShort answers.\n");
    expect(text).toContain("## Learned Facts\n\n_Specific facts, decisions, or patterns observed over time_");
  });

  it("replace a section's content, keeping one heading", async () => {
    const vault = await makeVault();
    const update = vault.tool("update_user_memory");
    await update.run({ section: "Preferences", content: "Short answers." });
    await update.run({ section: "Preferences", content: "Long answers." });
    const text = await vault.read(PROFILE);
    expect(text.match(/## Preferences/g)).toHaveLength(1);
    expect(text).toContain("## Preferences\n\nLong answers.\n");
    expect(text).not.toContain("Short answers.");
    expect(text).toContain("## Communication Style");
  });

  it("add a section the defaults do not have at the end", async () => {
    const vault = await makeVault();
    await vault.tool("update_user_memory").run({ section: "Hobbies", content: "Running." });
    expect((await vault.read(PROFILE)).trimEnd().endsWith("## Hobbies\n\nRunning.")).toBe(true);
  });

  it("read the profile without its frontmatter", async () => {
    const vault = await makeVault({ [PROFILE]: "---\ntype: user-profile\n---\n## Identity\n\nAlex\n" });
    expect(await vault.tool("read_user_memory").run({})).toBe("## Identity\n\nAlex");
  });
});

describe("truncateToTokens", () => {
  it("leaves content within the budget alone", () => {
    expect(truncateToTokens("abcd", 1)).toBe("abcd");
  });

  it("cuts at a line break in the second half and says so", () => {
    const content = `${"a".repeat(30)}\n${"b".repeat(30)}`;
    expect(truncateToTokens(content, 10)).toBe(`${"a".repeat(30)}\n\n_[Profile truncated to fit context window]_`);
  });

  it("cuts mid-line when no line break is near the end", () => {
    expect(truncateToTokens("x".repeat(50), 10)).toBe(`${"x".repeat(40)}\n\n_[Profile truncated to fit context window]_`);
  });
});

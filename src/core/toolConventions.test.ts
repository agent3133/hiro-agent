// The system prompt's paragraph on paths and finding notes (#165).
import { describe, expect, it } from "vitest";

import { toolConventions } from "./paths";
import specs from "./tools/specs.json";

describe("toolConventions", () => {
  it("says how paths work and which tool finds what, for an agent with the note tools", () => {
    const text = toolConventions(["read_note", "find_notes", "search_vault", "list_notes"]);
    expect(text).toContain(".md is optional");
    expect(text).toContain("find_notes by name, search_vault by content, list_notes by folder");
  });

  it("names only the finding tools the agent has, and none when it has one", () => {
    expect(toolConventions(["read_note", "find_notes", "search_vault"])).toContain("find_notes by name, search_vault by content.");
    expect(toolConventions(["read_note", "find_notes"])).not.toContain("To find a note");
  });

  it("is empty for an agent without note tools", () => {
    expect(toolConventions(["web_fetch", "daily_note"])).toBe("");
    expect(toolConventions([])).toBe("");
  });
});

describe("the tool specs (#165)", () => {
  it("carry no title keys, which no model needs", () => {
    // A parameter may be called "title" (create_tasknote); none has a "title" key in its schema
    const schemas = (specs as unknown as { parameters: { properties: Record<string, object> } }[])
      .flatMap((spec) => Object.values(spec.parameters.properties));
    expect(schemas.filter((schema) => "title" in schema)).toEqual([]);
  });
});

describe("properties in toolConventions (#246)", () => {
  it("sends property changes to update_metadata when the agent can also edit text", () => {
    const text = toolConventions(["read_note", "edit_note", "update_metadata"]);
    expect(text).toContain("Change a note's properties with update_metadata (to remove one, pass the value null); "
      + "edit_note is for the text below them.");
  });

  it("says nothing about properties without both kinds of tool", () => {
    expect(toolConventions(["read_note", "update_metadata"])).not.toContain("update_metadata (to remove");
    expect(toolConventions(["read_note", "edit_note"])).not.toContain("properties");
  });
});


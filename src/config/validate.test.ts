import { describe, it, expect } from "vitest";
import { validate } from "./validate";
import type { JsonSchema } from "./validate";
import schema from "./schema.json";

const validVault = { path: "/test/vault" };

describe("validate", () => {
  it("returns an empty list for valid journal settings", async () => {
    const errors = validate({ journal: { turns: 20 }, vault: validVault }, schema as JsonSchema);
    expect(errors).toEqual([]);
  });

  it("returns error for unknown top-level key", async () => {
    const errors = validate({ nope: 1, vault: validVault }, schema as JsonSchema);
    expect(errors).toEqual([{ path: "nope", message: "is not a setting" }]);
  });

  it("returns error for wrong type in journal.turns", async () => {
    const errors = validate({ journal: { turns: "many" }, vault: validVault }, schema as JsonSchema);
    expect(errors).toEqual([{ path: "journal.turns", message: "must be integer, not string" }]);
  });

  it("returns error for invalid sampling_preset", async () => {
    const errors = validate(
      { llm_profiles: { x: { sampling_preset: "fast" } }, vault: validVault },
      schema as JsonSchema,
    );
    expect(errors.length).toBe(1);
    expect(errors[0].path).toBe("llm_profiles.x.sampling_preset");
    expect(errors[0].message.startsWith("must be one of")).toBe(true);
  });

  it("returns empty for valid sampling_preset 'thinking-coding'", async () => {
    const errors = validate(
      { llm_profiles: { x: { sampling_preset: "thinking-coding" } }, vault: validVault },
      schema as JsonSchema,
    );
    expect(errors).toEqual([]);
  });

  it("returns empty for null sampling_preset", async () => {
    const errors = validate(
      { llm_profiles: { x: { sampling_preset: null } }, vault: validVault },
      schema as JsonSchema,
    );
    expect(errors).toEqual([]);
  });

  it("returns error for missing required field", async () => {
    const smallSchema: JsonSchema = {
      type: "object",
      required: ["a"],
      properties: {
        a: { type: "array", items: { type: "string" } },
      },
    };
    const errors = validate({}, smallSchema);
    expect(errors).toEqual([{ path: "a", message: "is required" }]);
  });

  it("returns error for wrong array item type", async () => {
    const smallSchema: JsonSchema = {
      type: "object",
      required: ["a"],
      properties: {
        a: { type: "array", items: { type: "string" } },
      },
    };
    const errors = validate({ a: ["x", 2] }, smallSchema);
    expect(errors).toEqual([{ path: "a.1", message: "must be string, not integer" }]);
  });
});

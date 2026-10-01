// Each feature's own settings sit under its switch, and Advanced shows none of them twice (#149).
import { describe, expect, it } from "vitest";

import schema from "../config/schema.json";
import { AUDIO_DETAILS, BASIC_PATHS, FEATURES, LABELS, UNUSED_PATHS } from "./basicPaths";

function exists(path: string): boolean {
  const defs = (schema as { $defs: Record<string, { properties?: Record<string, unknown> }> }).$defs;
  let node: { properties?: Record<string, unknown> } = schema as never;
  for (const key of path.split(".")) {
    const next = node.properties?.[key] as { $ref?: string; anyOf?: { $ref?: string }[] } | undefined;
    if (!next) return false;
    const ref = next.$ref ?? next.anyOf?.find((option) => option.$ref)?.$ref;
    node = ref ? defs[ref.split("/").pop()!] : next as never;
  }
  return true;
}

describe("basicPaths", () => {
  it("names only settings the schema has", () => {
    for (const path of BASIC_PATHS) expect(exists(path), path).toBe(true);
  });

  it("keeps every folded setting out of Advanced", () => {
    for (const { path, more } of FEATURES) {
      expect(BASIC_PATHS).toContain(path);
      for (const detail of more) expect(BASIC_PATHS).toContain(detail);
    }
    for (const path of [...AUDIO_DETAILS, ...UNUSED_PATHS]) expect(BASIC_PATHS).toContain(path);
  });

  it("gives the jargon-named fields a plain label", () => {
    expect(LABELS["audio.whisper_cli"]).toBe("whisper.cpp program");
    expect(LABELS["audio.ffmpeg"]).toBe("ffmpeg program");
    for (const path of Object.keys(LABELS)) expect(BASIC_PATHS).toContain(path);
  });
});

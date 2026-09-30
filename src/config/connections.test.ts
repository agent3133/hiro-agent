// Ported from tests/test_config_presets.py: Python's `resolve_sampling_preset(LLMConfig(...))` is
// `resolveConnection({ llm: {...} }, "", env)`, with the sampling fields in camelCase.
import { describe, expect, it } from "vitest";

import { resolveConnection, SAMPLING_PRESETS } from "./connections";

const noEnv = (): undefined => undefined;

describe("test_config_presets.py", () => {
  it("test_resolve_sampling_preset_fills_none_without_overwriting_explicit_values", () => {
    const resolved = resolveConnection({ llm: {
      sampling_preset: "thinking-general", temperature: 0.2, top_p: null, top_k: null, min_p: 0.3,
      presence_penalty: null, repetition_penalty: 1.2,
    } }, "", noEnv);
    expect(resolved.temperature).toBe(0.2);
    expect(resolved.topP).toBe(0.95);
    expect(resolved.topK).toBe(20);
    expect(resolved.minP).toBe(0.3);
    expect(resolved.presencePenalty).toBe(1.5);
    expect(resolved.repetitionPenalty).toBe(1.2);
  });

  it("test_resolve_sampling_preset_all_names", () => {
    for (const [name, values] of Object.entries(SAMPLING_PRESETS)) {
      const resolved = resolveConnection({ llm: { sampling_preset: name } }, "", noEnv);
      expect(resolved.temperature).toBe(values.temperature);
      expect(resolved.topP).toBe(values.top_p);
      expect(resolved.topK).toBe(values.top_k);
      expect(resolved.minP).toBe(values.min_p);
      expect(resolved.presencePenalty).toBe(values.presence_penalty);
      expect(resolved.repetitionPenalty).toBe(values.repetition_penalty);
    }
  });

  it("test_resolve_sampling_preset_none_keeps_config", () => {
    // Python: the config comes back as it was; here, nothing is filled in beyond the defaults
    const resolved = resolveConnection({ llm: { sampling_preset: null, top_p: 0.5 } }, "", noEnv);
    expect(resolved).toMatchObject({ temperature: 0.7, topP: 0.5, topK: undefined, minP: undefined,
                                     presencePenalty: undefined, repetitionPenalty: undefined });
  });
});

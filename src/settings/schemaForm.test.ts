// The Advanced tab's field names: sentence case, acronyms kept (#108).
import { describe, expect, it } from "vitest";

import { humanize } from "./schemaForm";

describe("humanize", () => {
  it("turns a key into sentence case", () => {
    expect(humanize("max_content_length")).toBe("Max content length");
  });

  it("keeps acronyms in capitals, first word or not", () => {
    expect(humanize("whisper_cli")).toBe("Whisper CLI");
    expect(humanize("base_url")).toBe("Base URL");
    expect(humanize("llm_profiles")).toBe("LLM profiles");
    expect(humanize("use_gpu")).toBe("Use GPU");
    expect(humanize("top_p")).toBe("Top P");
    expect(humanize("top_k")).toBe("Top K");
    expect(humanize("min_p")).toBe("Min P");
  });

  it("leaves a word that only contains an acronym alone", () => {
    expect(humanize("temperature")).toBe("Temperature");
    expect(humanize("identity")).toBe("Identity");
  });
});

import { describe, expect, it } from "vitest";

import { promptContext, renderPrompt } from "./prompt";

describe("renderPrompt", () => {
  it("fills in plain placeholders, with or without spaces", () => {
    expect(renderPrompt("Vault {{ vault_path }}, {{current_date}}", { vault_path: "/v", current_date: "2026-09-28" }))
      .toEqual({ text: "Vault /v, 2026-09-28", unsupported: [] });
  });

  it("renders an unknown name empty, as Jinja's default Undefined does", () => {
    expect(renderPrompt("a{{ nope }}b", {}).text).toBe("ab");
  });

  it("takes a slice of a placeholder the way Python does (weekly-review's month)", () => {
    const context = { current_date: "2026-09-28" };
    expect(renderPrompt("{{ current_date[:7] }}|{{current_date[5:7]}}|{{ current_date[-2:] }}", context).text)
      .toBe("2026-09|09|28");
  });

  it("leaves expressions it cannot evaluate as written, and reports them", () => {
    const result = renderPrompt("{{ shell('git log') }} {% if x %}y{% endif %}", { current_date: "2026-09-28" });
    expect(result.text).toBe("{{ shell('git log') }} {% if x %}y{% endif %}");
    expect(result.unsupported).toEqual(["shell('git log')", "{% if x %}", "{% endif %}"]);
  });
});

describe("promptContext", () => {
  it("formats date and time like Python's isoformat and %H:%M", () => {
    const context = promptContext("/v", "assistant", "qwen", new Date(2026, 0, 5, 7, 3));
    expect(context).toMatchObject({ current_date: "2026-01-05", current_time: "07:03", agent_name: "assistant",
                                    model: "qwen", vault_path: "/v" });
  });
});

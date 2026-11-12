// @vitest-environment jsdom
// The model file's help under Features → Audio transcription (#421, on the obsidian stub): what the help line says,
// where its button leads, and which audio row draws it.
import { afterEach, describe, expect, it, vi } from "vitest";

import { buttonNamed, Setting } from "../testing/obsidian";
import type { ConfigDocument } from "../api/types";

import { featureGroup, modelHelp, WHISPER_MODELS_URL } from "./BasicSections";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the model file's help (modelHelp)", () => {
  it("adds a line under the model file's path, naming ggml-base.bin, and a Get a model button", () => {
    const container = document.createElement("div");
    const setting = new Setting(container);
    modelHelp(setting as unknown as Parameters<typeof modelHelp>[0]);

    const help = container.querySelector<HTMLElement>(".obsidian-agent-model-help");
    expect(help).not.toBeNull();
    expect(help?.parentElement).toBe(setting.descEl);
    expect(help?.textContent).toContain("ggml-base.bin");
    expect(buttonNamed(container, "Get a model").buttonEl.textContent).toBe("Get a model");
  });

  it("opens the whisper.cpp model list when Get a model is clicked", async () => {
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    const container = document.createElement("div");
    modelHelp(new Setting(container) as unknown as Parameters<typeof modelHelp>[0]);

    await buttonNamed(container, "Get a model").click();

    expect(open).toHaveBeenCalledWith(WHISPER_MODELS_URL);
  });
});

/** The audio rows as the Features page draws them: the "More for audio transcription" page's rows. */
interface Row {
  name?: string;
  render?: (setting: never, group: never) => void;
}
interface Page {
  type?: string;
  items?: { items?: Row[] }[];
}

const doc: ConfigDocument = {
  path: "config.yaml",
  exists: true,
  values: {},
  secrets: {},
  schema: {
    type: "object",
    properties: {
      audio: {
        type: "object",
        properties: {
          enabled: { type: "boolean", default: false },
          whisper_cli: { type: "string" },
          model: { type: "string" },
          ffmpeg: { type: "string" },
        },
      },
    },
  },
};

function audioRows(): Row[] {
  const group = featureGroup(doc, { save: vi.fn(async () => null) }, vi.fn()) as unknown as { items: Page[] };
  const page = group.items.find((item) => item.type === "page");
  return page?.items?.[0]?.items ?? [];
}

/** The row named *name*, drawn into a container of its own. */
function drawRow(name: string): HTMLElement {
  const row = audioRows().find((item) => item.name === name);
  if (!row?.render) throw new Error(`no audio row '${name}'`);
  const container = document.createElement("div");
  row.render(new Setting(container) as never, undefined as never);
  return container;
}

describe("the audio rows that draw the model help", () => {
  it("draws the help under the Whisper model file row, and not under the ffmpeg row", () => {
    const model = drawRow("Whisper model file");
    expect(model.querySelector(".obsidian-agent-model-help")?.textContent).toContain("ggml-base.bin");
    expect(buttonNamed(model, "Get a model").buttonEl).toBeDefined();

    const ffmpeg = drawRow("ffmpeg program");
    expect(ffmpeg.querySelector(".obsidian-agent-model-help")).toBeNull();
  });
});

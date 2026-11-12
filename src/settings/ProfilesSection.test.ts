// @vitest-environment jsdom
// The connections group (#321, #368, on the obsidian stub): the add row, the form it opens, the rows, editing one, and a
// local server found that no connection uses yet. The create path is the one that broke in 0.9.1–0.9.3 (#343).
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ConfigDocument, JsonSchema } from "../api/types";
import schemaJson from "../config/schema.json";
import {
  App, ButtonComponent, buttonNamed, Notice, Setting, settingNamed, settingsIn, SettingGroup, type TextComponent,
} from "../testing/obsidian";

import { serverLabel, type LocalServer } from "./connections";
import { connectionGroup, type ProfilesHost } from "./ProfilesSection";

type Group = ReturnType<typeof connectionGroup>;
type Item = NonNullable<Group["items"]>[number];

const SCHEMA = schemaJson as unknown as JsonSchema;

function documentWith(profiles: Record<string, Record<string, unknown>>): ConfigDocument {
  return { path: "config.yaml", exists: true, values: { llm_profiles: profiles }, secrets: {}, schema: SCHEMA };
}

function makeHost(): ProfilesHost {
  return {
    app: new App(".") as never,
    save: vi.fn(async () => ({ ok: true, changed: [], fields: [] })),
    probe: vi.fn(async () => null),
    redraw: vi.fn(),
  };
}

/** The group as Obsidian draws it on the stub: its heading, then a row per item, each drawn by its own render. */
function drawGroup(container: HTMLElement, group: Group): void {
  const list = new SettingGroup(container).setHeading(group.heading ?? "");
  for (const item of (group.items ?? []) as Item[]) {
    list.addSetting((setting: Setting) => {
      setting.setName(item.name);
      if (item.desc) setting.setDesc(item.desc);
      if ("render" in item && item.render) {
        const render = item.render as unknown as (row: unknown, group: unknown) => void;
        render(setting, list);
      }
    });
  }
}

/** The form on screen: the stub appends a modal's container to the body; its first child holds the title and content. */
function openForm(): { title: string; content: HTMLElement } {
  const container = document.body.lastElementChild as HTMLElement;
  const modalEl = container.firstElementChild as HTMLElement;
  return { title: modalEl.children[0].textContent ?? "", content: modalEl.children[1] as HTMLElement };
}

function field(content: HTMLElement, name: string): TextComponent {
  return settingNamed(content, name).components[0] as TextComponent;
}

/** The icon button of a row, found by its tooltip: Edit and Remove have no text to find them by. */
function iconButton(container: HTMLElement, tooltip: string): ButtonComponent {
  for (const setting of settingsIn(container)) {
    for (const component of setting.components) {
      if (component instanceof ButtonComponent && component.buttonEl.getAttribute("aria-label") === tooltip) {
        return component;
      }
    }
  }
  throw new Error(`no button with the tooltip '${tooltip}'`);
}

describe("connectionGroup", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    Notice.shown = [];
  });

  it("with no connections, offers to add one, and choosing it opens the 'Add a connection' form", async () => {
    const container = document.createElement("div");
    drawGroup(container, connectionGroup(documentWith({}), makeHost(), [], vi.fn()));

    await buttonNamed(container, "Add connection").click();

    expect(document.body.childElementCount).toBe(1);
    const form = openForm();
    expect(form.title).toBe("Add a connection");
    expect(settingNamed(form.content, "Address")).toBeDefined();
  });

  it("saves a new connection with the name and address typed, through the host, and closes", async () => {
    const container = document.createElement("div");
    const host = makeHost();
    drawGroup(container, connectionGroup(documentWith({}), host, [], vi.fn()));
    await buttonNamed(container, "Add connection").click();
    const form = openForm();

    await field(form.content, "Name").type("local");
    await field(form.content, "Address").type("http://127.0.0.1:8080");
    await buttonNamed(form.content, "Save").click();

    expect(host.save).toHaveBeenCalledWith(expect.objectContaining({
      llm_profiles: { local: expect.objectContaining({ base_url: "http://127.0.0.1:8080" }) },
    }));
    expect(document.body.childElementCount).toBe(0);
  });

  it("with two connections, lists both by name", () => {
    const container = document.createElement("div");
    const profiles = {
      cloud: { base_url: "https://openrouter.ai/api/v1", model: "m", api_key: "${OR_KEY}" },
      local: { base_url: "http://127.0.0.1:8080" },
    };
    drawGroup(container, connectionGroup(documentWith(profiles), makeHost(), [], vi.fn()));

    expect(settingNamed(container, "cloud").nameEl.textContent).toBe("cloud");
    expect(settingNamed(container, "local").nameEl.textContent).toBe("local");
  });

  it("opening an existing connection fills its form with the name, address and model, under its name", async () => {
    const container = document.createElement("div");
    const profiles = { cloud: { base_url: "https://openrouter.ai/api/v1", model: "m", api_key: "${OR_KEY}" } };
    drawGroup(container, connectionGroup(documentWith(profiles), makeHost(), [], vi.fn()));

    await iconButton(container, "Edit cloud").click();

    const form = openForm();
    expect(form.title).toBe("Connection 'cloud'");
    expect(field(form.content, "Name").getValue()).toBe("cloud");
    expect(field(form.content, "Address").getValue()).toBe("https://openrouter.ai/api/v1");
    expect(field(form.content, "Model").getValue()).toBe("m");
  });

  it("removes a connection only after the question is confirmed, and drops it as the default too", async () => {
    const container = document.createElement("div");
    const host = makeHost();
    const profiles = { cloud: { base_url: "https://openrouter.ai/api/v1", model: "m" } };
    drawGroup(container, connectionGroup({ ...documentWith(profiles), values: { llm_profiles: profiles,
      default_llm_profile: "cloud" } }, host, [], vi.fn()));

    await iconButton(container, "Remove cloud").click();
    const question = document.body.lastElementChild as HTMLElement;
    expect(question.textContent).toContain("Remove cloud?");
    expect(host.save).not.toHaveBeenCalled();
    await buttonNamed(question, "Remove").click();

    await vi.waitFor(() => expect(host.save).toHaveBeenCalled());
    expect(host.save).toHaveBeenCalledWith(expect.objectContaining({
      llm_profiles: { cloud: null }, default_llm_profile: null,
    }));
  });

  it("removes nothing when the question is cancelled", async () => {
    const container = document.createElement("div");
    const host = makeHost();
    drawGroup(container, connectionGroup(documentWith({ cloud: { base_url: "https://x.example/v1" } }),
      host, [], vi.fn()));

    await iconButton(container, "Remove cloud").click();
    await buttonNamed(document.body.lastElementChild as HTMLElement, "Cancel").click();

    expect(host.save).not.toHaveBeenCalled();
  });

  it("offers a local server found that no connection uses, under its label, and adds it when its button is clicked", async () => {
    const container = document.createElement("div");
    const host = makeHost();
    const server: LocalServer = {
      port: 8080, baseUrl: "http://127.0.0.1:8080", model: "qwen", models: 1, kind: "llama.cpp", name: "local",
    };
    drawGroup(container, connectionGroup(documentWith({}), host, [server], vi.fn()));

    expect(settingNamed(container, `Found: ${serverLabel(server)}`).nameEl.textContent)
      .toBe("Found: llama.cpp on 127.0.0.1:8080");

    await buttonNamed(container, 'Add as "local"').click();
    expect(host.save).toHaveBeenCalledWith({
      llm_profiles: { local: { base_url: "http://127.0.0.1:8080" } },
      default_llm_profile: "local",
    });
  });
});

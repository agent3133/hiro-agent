// Ported from tests/test_tools_tasknotes.py — list_tasknotes and complete_tasknote (#80). Creating a task is #82.
import { describe, expect, it } from "vitest";

import { makeVault } from "../testing/vault";
import { TaskNotesSettings } from "./tasknotesTools";

/** TaskNotes' settings file, as write_settings writes it. */
const SETTINGS = {
  tasksFolder: "TaskNotes/Tasks",
  archiveFolder: "TaskNotes/Archive",
  taskTag: "task",
  defaultTaskStatus: "open",
  customStatuses: [{ value: "open", isCompleted: false }, { value: "in-progress", isCompleted: false },
                   { value: "done", isCompleted: true }, { value: "canceled", isCompleted: true }],
  fieldMapping: { title: "title", status: "status", due: "due", scheduled: "scheduled", priority: "priority",
                  projects: "projects", completedDate: "completedDate", recurrence: "recurrence", tags: "tags" },
};

/** `write_settings`: the settings file's path and text, with *overrides* on top. */
function settingsFile(overrides: Record<string, unknown> = {}): Record<string, string> {
  return { ".obsidian/plugins/tasknotes/data.json": JSON.stringify({ ...SETTINGS, ...overrides }) };
}

/** `write_task`: a task note's path and text; `folder` picks the folder, other fields go into the frontmatter. */
function taskNote(name: string, fields: Record<string, string> = {}): Record<string, string> {
  const { folder = "TaskNotes/Tasks", ...rest } = fields;
  const lines = ["---", `title: ${name}`, "tags: [task]", ...Object.entries(rest).map(([k, v]) => `${k}: ${v}`)];
  return { [`${folder}/${name}.md`]: `${lines.join("\n")}\n---\n` };
}

/** The Python `vault` fixture: settings, three tasks and a note with a checkbox task. */
const VAULT = {
  ...settingsFile(),
  ...taskNote("Choose CMS", { status: "open", priority: "high", due: "2026-09-16", projects: '["[[Website Relaunch]]"]' }),
  ...taskNote("Book moving company", { status: "done", projects: '["[[Office Move]]"]' }),
  ...taskNote("Water the plants", { status: "open", recurrence: "FREQ=WEEKLY" }),
  "Note.md": "- [ ] a checkbox task, not a task note\n",
};

describe("test_tools_tasknotes.py", () => {
  it("test_listing_reads_the_task_notes", async () => {
    const vault = await makeVault(VAULT);
    const listed = await vault.tool("list_tasknotes").run({ status: "open" });
    expect(listed).toContain("TaskNotes/Tasks/Choose CMS.md");
    expect(listed).toContain("due: 2026-09-16");
    expect(listed).not.toContain("Book moving company");
    expect(listed).not.toContain("checkbox");
  });

  it("test_completing_sets_the_vaults_completed_status_and_date", async () => {
    const vault = await makeVault(VAULT);
    const result = await vault.tool("complete_tasknote").run({ task: "Choose CMS" });
    const content = await vault.read("TaskNotes/Tasks/Choose CMS.md");
    expect(content).toContain("status: done");
    const d = new Date();
    const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    expect(content).toContain(`completedDate: ${today}`);
    expect(result.startsWith("Completed")).toBe(true);
    expect(result).toContain("status: done");
    const result2 = await vault.tool("complete_tasknote").run({ task: "Choose CMS" });
    expect(result2).toContain("already");
  });

  it("test_a_recurring_task_is_left_to_the_plugin", async () => {
    const vault = await makeVault(VAULT);
    const result = await vault.tool("complete_tasknote").run({ task: "Water the plants" });
    expect(result).toContain("recurring");
    expect(result).toContain("tick it off in Obsidian");
    const content = await vault.read("TaskNotes/Tasks/Water the plants.md");
    expect(content).toContain("status: open");
  });

  it("test_an_ambiguous_name_lists_the_candidates", async () => {
    const vault = await makeVault({ ...VAULT, ...taskNote("Choose CMS", { folder: "TaskNotes/Archive", status: "done" }) });
    const result = await vault.tool("complete_tasknote").run({ task: "Choose CMS" });
    expect(result).toContain("several tasks");
    expect(result).toContain("TaskNotes/Archive/Choose CMS.md");
    const result2 = await vault.tool("complete_tasknote").run({ task: "Nothing here" });
    expect(result2.startsWith("Error: no TaskNotes task")).toBe(true);
  });

  it("test_renamed_properties_and_custom_statuses_are_followed", async () => {
    const vault = await makeVault({
      ...settingsFile({
        tasksFolder: "Aufgaben",
        customStatuses: [
          { value: "offen", isCompleted: false },
          { value: "erledigt", isCompleted: true },
        ],
        fieldMapping: { ...SETTINGS.fieldMapping, due: "deadline", status: "status" },
      }),
      ...taskNote("Steuer", { folder: "Aufgaben", status: "offen", deadline: "2026-10-01" }),
    });
    const listed = await vault.tool("list_tasknotes").run({ status: "open" });
    expect(listed).toContain("Aufgaben/Steuer.md");
    expect(listed).toContain("due: 2026-10-01");
    const completed = await vault.tool("complete_tasknote").run({ task: "Steuer" });
    expect(completed).toContain("status: erledigt");
  });

  it("test_without_plugin_settings_the_defaults_apply", async () => {
    const vault = await makeVault({});
    const settings = await TaskNotesSettings.read(vault.vault);
    expect(settings.folder).toBe("TaskNotes/Tasks");
    expect(settings.tag).toBe("task");
    expect(settings.completedStatuses).toEqual(["done"]);
    expect(settings.name("due")).toBe("due");
  });

  it("test_list_tasknotes_says_what_its_filters_left_out", async () => {
    const vault = await makeVault(VAULT);
    const openOnly = await vault.tool("list_tasknotes").run({ project: "Office Move" });
    expect(openOnly).not.toContain("Book moving company");
    expect(openOnly).toContain("1 done task in this project not listed");
    expect(openOnly).toContain("in other projects not listed");
    expect(openOnly).not.toContain("status=all");

    const everything = await vault.tool("list_tasknotes").run({ project: "Office Move", status: "all" });
    expect(everything).toContain("Book moving company");
    expect(everything).not.toContain("done task");
  });

  it("test_list_tasknotes_caps_a_long_list", async () => {
    const notes: Record<string, string> = { ...settingsFile() };
    for (let number = 0; number < 40; number++) {
      Object.assign(notes, taskNote(`Task ${String(number).padStart(2, "0")}`, { status: "open", projects: '["[[Big]]"]' }));
    }
    const vault = await makeVault(notes);
    const answer = await vault.tool("list_tasknotes").run({});
    expect(answer.split("\n").length).toBe(31);
    expect(answer).toContain("10 more, narrow with project or status");
  });

  it("test_list_tasknotes_finds_the_tasks_with_no_project", async () => {
    const vault = await makeVault(VAULT);
    const unassigned = await vault.tool("list_tasknotes").run({ project: "none" });
    expect(unassigned).toContain("Water the plants");
    expect(unassigned).not.toContain("Choose CMS");
    expect(unassigned).toContain("that belong to a project not listed");
  });
});

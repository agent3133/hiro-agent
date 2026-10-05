import { describe, it, expect } from "vitest";
import { parse } from "yaml";
import { BASE_SYNTAX, embeddedBases, prepareBase, rowsTable, QUERY_VIEW_TYPE, PreparedBase } from "./baseDefinition";

describe("prepareBase and rowsTable", () => {
  // Behaviour 1: Two views "A" and "B"
  it("with no viewName, selects first view A with QUERY_VIEW_TYPE", () => {
    const def = `
filters:
  and:
    - file.hasTag("task")
formulas:
  done: this.file.day >= 2024-01-01
views:
  - name: A
    type: table
  - name: B
    type: cards
`;
    const result = prepareBase(def) as PreparedBase;
    const parsed = parse(result.yaml) as Record<string, unknown>;
    expect((result as PreparedBase).view).toBe("A");
    // filters preserved as-is (YAML parses the string expression)
    const filters = parsed.filters as Record<string, unknown>;
    expect((filters.and as string[])[0]).toBe('file.hasTag("task")');
    const views = parsed.views as Record<string, unknown>[];
    expect(views).toHaveLength(1);
    expect(views[0].type).toBe(QUERY_VIEW_TYPE);
    expect(views[0].name).toBe("A");
    // formulas preserved (the value is a string expression)
    expect((parsed.formulas as Record<string, unknown>)?.done).toBe("this.file.day >= 2024-01-01");
  });

  it("with viewName 'b' (case insensitive), selects view B", () => {
    const def = `
filters:
  and:
    - file.hasTag("task")
views:
  - name: A
    type: table
  - name: B
    type: cards
`;
    const result = prepareBase(def, "b") as PreparedBase;
    expect(result.view).toBe("B");
    const parsed = parse(result.yaml) as Record<string, unknown>;
    const views = parsed.views as Record<string, unknown>[];
    expect(views).toHaveLength(1);
    expect(views[0].name).toBe("B");
    expect(views[0].type).toBe(QUERY_VIEW_TYPE);
  });

  it("filters and formulas are kept unchanged", () => {
    const def = `
filters:
  and:
    - file.hasTag("task")
formulas:
  done: this.file.day >= 2024-01-01
views:
  - name: A
    type: table
`;
    const result = prepareBase(def) as PreparedBase;
    const parsed = parse(result.yaml) as Record<string, unknown>;
    const filters = parsed.filters as Record<string, unknown>;
    expect((filters.and as string[])[0]).toBe('file.hasTag("task")');
    expect((parsed.formulas as Record<string, unknown>)?.done).toBe("this.file.day >= 2024-01-01");
  });

  // Behaviour 2: viewName "Nope" and no views
  it('viewName "Nope" returns error listing views A, B', () => {
    const def = `
views:
  - name: A
    type: table
  - name: B
    type: cards
`;
    const result = prepareBase(def, "Nope") as string;
    expect(typeof result).toBe("string");
    expect(result.startsWith("Error: the Base has no view 'Nope'")).toBe(true);
    expect(result).toContain("A");
    expect(result).toContain("B");
  });

  it("definition without views gets one view named Query", () => {
    const def = `
filters:
  and:
    - file.hasTag("task")
`;
    const result = prepareBase(def) as PreparedBase;
    expect(result.view).toBe("Query");
    const parsed = parse(result.yaml) as Record<string, unknown>;
    const views = parsed.views as Record<string, unknown>[];
    expect(views).toHaveLength(1);
    expect(views[0].name).toBe("Query");
    expect(views[0].type).toBe(QUERY_VIEW_TYPE);
  });

  // Behaviour 3: fenced block
  it("fenced ```base block is read like YAML inside", () => {
    const def = "```base\nfilters:\n  and:\n    - file.hasTag(\"task\")\n```";
    const result = prepareBase(def) as PreparedBase;
    const parsed = parse(result.yaml) as Record<string, unknown>;
    const filters = parsed.filters as Record<string, unknown>;
    expect((filters.and as string[])[0]).toBe('file.hasTag("task")');
  });

  // Behaviour 4: this.file replacement
  it('with note "P/Plan.md", this.file becomes file("P/Plan.md") in filters and formulas', () => {
    const def = `
filters:
  and:
    - note.projects.contains(this.file.asLink())
formulas:
  link: this.file.asLink()
`;
    const result = prepareBase(def, "", "P/Plan.md") as PreparedBase;
    // Check raw yaml string for the replacement
    expect(result.yaml).toContain('file("P/Plan.md")');
    expect(result.yaml).toContain("asLink()");
  });

  it("without note, this.file stays as it was", () => {
    const def = `
filters:
  and:
    - note.projects.contains(this.file.asLink())
`;
    const result = prepareBase(def) as PreparedBase;
    expect(result.yaml).toContain("this.file");
  });

  it('"this.filed" is not changed', () => {
    const def = `
filters:
  and:
    - this.filed == 1
`;
    const result = prepareBase(def, "", "P/Plan.md") as PreparedBase;
    expect(result.yaml).toContain("this.filed");
    expect(result.yaml).not.toContain('file("P/Plan.md")');
  });

  // Behaviour 5: Broken YAML, plain list, rowsTable
  it("broken YAML returns error starting with 'Error: the Base's definition is not valid YAML'", () => {
    const result = prepareBase("{{invalid: yaml: [");
    expect(typeof result).toBe("string");
    expect(String(result).startsWith("Error: the Base's definition is not valid YAML")).toBe(true);
  });

  it("plain list returns error starting with 'Error: a Base's definition is YAML'", () => {
    const result = prepareBase("- a\n- b");
    expect(typeof result).toBe("string");
    expect(String(result).startsWith("Error: a Base's definition is YAML")).toBe(true);
  });

  it('rowsTable with 3 rows and limit 2 shows 2 rows and "[1 more rows not shown"', () => {
    const table = rowsTable(["file", "due"], [["A", "2024-01-01"], ["B", "2024-01-02"], ["C", "2024-01-03"]], 2);
    // header + sep + 2 data rows + blank line + ellipsis = 6 lines
    expect(table.split("\n").length).toBe(6);
    expect(table).toContain("[1 more rows not shown");
  });

  it("rowsTable escapes a | in a cell as \\|", () => {
    const table = rowsTable(["file", "due"], [["a|b", "2024-01-01"]], 1);
    expect(table).toContain("\\|");
  });

  it("the tool description's example definition parses, gets a view, and refers to its note", async () => {
    const specs = (await import("./tools/specs.json")).default as { name: string; description: string }[];
    const description = specs.find((spec) => spec.name === "query_base")!.description;
    const example = JSON.parse(/\{"definition".*\}/.exec(description)![0]) as { definition: string; note: string };
    const result = prepareBase(example.definition, "", example.note) as PreparedBase;
    expect(typeof result).toBe("object");
    const base = parse(result.yaml);
    expect(base.filters).toBe(`file.hasTag("task") && file.hasLink(file("${example.note}"))`);
    expect(base.views[0].type).toBe(QUERY_VIEW_TYPE);
  });

  it("a definition that does not parse, or is not a set of keys, comes with the filter syntax (#246)", () => {
    for (const broken of ["filters: [unclosed", "- just\n- a list\n"]) {
      const result = String(prepareBase(broken));
      expect(result.startsWith("Error:")).toBe(true);
      expect(result).toContain(BASE_SYNTAX);
    }
  });

  it("the filter syntax is itself a valid definition", () => {
    const example = BASE_SYNTAX.split("\n").filter((line) => !line.startsWith("A definition") && !line.startsWith("Use or"))
      .map((line) => line.replace(/\s+#.*$/, "")).join("\n");
    expect(typeof prepareBase(example)).toBe("object");
  });
});


describe("prepareBase's answers to the mistakes models make (#270)", () => {
  it("shows a definition sent with \\n for its line breaks as it was meant", () => {
    const sent = 'filters:\\n  and:\\n    - file.hasTag(\\"task\\")\\nviews:\\n  - type: table';
    const answer = prepareBase(sent) as string;
    expect(answer).toMatch(/^Error: the definition came as one line, with the characters \\n where its line breaks/);
    expect(answer.endsWith('filters:\n  and:\n    - file.hasTag("task")\nviews:\n  - type: table')).toBe(true);
  });

  it("puts a filter expression on its own under filters:", () => {
    const answer = prepareBase('file.hasTag("task") && status == \'open\'') as string;
    expect(answer).toContain("this is a filter expression on its own");
    expect(answer).toContain("filters: 'file.hasTag(\"task\") && status == ''open'''");
    expect(answer).toContain(BASE_SYNTAX);
  });

  it("runs a definition without views under the view name asked for", () => {
    for (const name of ["Query", "default"]) {
      const result = prepareBase('filters: file.hasTag("task")', name) as PreparedBase;
      expect(result.view).toBe(name);
      expect((parse(result.yaml).views as { type: string }[])[0].type).toBe(QUERY_VIEW_TYPE);
    }
  });

  it("still refuses an unknown view of a Base that has views, and a plain word as a definition", () => {
    expect(prepareBase("views:\n  - name: A\n    type: table", "B")).toBe("Error: the Base has no view 'B'; its views: 'A'");
    expect(prepareBase("recipes")).toMatch(/^Error: a Base's definition is YAML with keys/);
  });

  it("takes a view type for a view name when one view has that type, and lists the names otherwise", () => {
    const two = "views:\n  - name: Open\n    type: table\n  - name: Board\n    type: tasknotesKanban";
    expect((prepareBase(two, "table") as PreparedBase).view).toBe("Open");
    const tables = "views:\n  - name: Open\n    type: table\n  - name: Done\n    type: table";
    expect(prepareBase(tables, "table")).toBe("Error: the Base has no view 'table'; its views: 'Open', 'Done'");
  });
});

describe("embeddedBases: the Bases in a note (2026-10-05)", () => {
  it("finds the one Base of a project note, as its YAML", () => {
    const note = "---\ntags:\n  - project\n---\n# Office Move\n\n## Board\n\n```base\nfilters:\n  and:\n"
      + "    - file.hasTag(\"task\")\nviews:\n  - type: tasknotesKanban\n    name: Board\n```\n\nMore text.\n";
    const blocks = embeddedBases(note);
    expect(blocks).toEqual(["filters:\n  and:\n    - file.hasTag(\"task\")\nviews:\n  - type: tasknotesKanban\n    name: Board"]);
    expect(typeof prepareBase(blocks[0], "Board", "TaskNotes/Projects/Office Move.md")).toBe("object");
  });

  it("finds each of several, with Windows line endings and tilde fences, and none in other code blocks", () => {
    const note = "# Two\r\n\r\n```base\r\nfilters: file.hasTag(\"a\")\r\n```\r\n\r\n~~~base\nfilters: file.hasTag(\"b\")\n~~~\n"
      + "\n```yaml\nfilters: no\n```\n";
    expect(embeddedBases(note)).toEqual(['filters: file.hasTag("a")', 'filters: file.hasTag("b")']);
    expect(embeddedBases("# No Base\n\n```js\nconst base = 1;\n```\n")).toEqual([]);
  });
});

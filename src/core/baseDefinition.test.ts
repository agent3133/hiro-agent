import { describe, it, expect } from "vitest";
import { parse } from "yaml";
import {
  BASE_SYNTAX, embeddedBases, prepareBase, rowsTable, QUERY_VIEW_TYPE, PreparedBase,
  countTable, withColumn, bareStrings, filterHints,
} from "./baseDefinition";

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

describe("count_by (#267)", () => {
  // A row is [file cells, projects cells]: each cell a list of its items
  const cols = ["file", "projects"];
  const ids = ["file", "projects"];
  const dataRows = (table: string) => table.split("\n").slice(2).filter((line) => line.startsWith("| "));

  it("counts the rows per value, most first, with (empty) for a row with no value", () => {
    const cells = [
      [["a.md"], ["[[A]]"]],
      [["b.md"], ["[[B]]"]],
      [["c.md"], ["[[A]]"]],
      [["d.md"], []],
    ];
    const table = countTable(cols, ids, cells, "projects");
    expect(dataRows(table)).toEqual(["| [[A]] | 2 |", "| [[B]] | 1 |", "| (empty) | 1 |"]);
    expect(table.split("\n")[0]).toBe("| projects | rows |");
  });

  it("counts a row with two items once under each, and says so; without such a row it says nothing of it", () => {
    const several = [
      [["a.md"], ["[[A]]", "[[B]]"]],
      [["b.md"], ["[[A]]"]],
    ];
    const withSeveral = countTable(cols, ids, several, "projects");
    expect(withSeveral.endsWith("A row with several values is counted once under each of them.")).toBe(true);
    expect(dataRows(withSeveral)).toEqual(["| [[A]] | 2 |", "| [[B]] | 1 |"]);

    const single = [
      [["a.md"], ["[[A]]"]],
      [["b.md"], ["[[B]]"]],
    ];
    expect(countTable(cols, ids, single, "projects")).not.toContain("several values");
  });

  it("finds the column by its display name, ignoring a note. prefix on the request", () => {
    const displayCols = ["file", "Projects"];
    const cells = [
      [["a.md"], ["[[A]]"]],
      [["b.md"], ["[[A]]"]],
    ];
    const byPrefixed = countTable(displayCols, ids, cells, "note.projects");
    const byDisplay = countTable(displayCols, ids, cells, "Projects");
    expect(byPrefixed).toBe(byDisplay);
    expect(dataRows(byDisplay)).toEqual(["| [[A]] | 2 |"]);
    expect(byDisplay.split("\n")[0]).toBe("| Projects | rows |");
  });

  it("answers an error naming the columns when no column is the one asked for", () => {
    const result = countTable(cols, ids, [[["a.md"], ["[[A]]"]]], "owner");
    expect(result.startsWith("Error: the result has no column 'owner'")).toBe(true);
    expect(result).toContain("'file'");
    expect(result).toContain("'projects'");
  });

  it("adds the counted property to the view's order, or leaves the definition unchanged when it is shown", () => {
    const prepared = (prepareBase("views:\n  - type: table\n    name: T\n    order: [file.name, status]\n") as PreparedBase).yaml;
    const added = parse(withColumn(prepared, "projects")) as { views: { order: string[] }[] };
    expect(added.views[0].order).toEqual(["file.name", "status", "projects"]);
    expect(withColumn(prepared, "note.status")).toBe(prepared);
  });
});

describe("filter hints (#389)", () => {
  const none = () => new Map<string, number>();

  it("finds the quoted strings that stand as a condition of their own", () => {
    expect(bareStrings('file.hasTag("task") && "open"')).toEqual(["open"]);
    expect(bareStrings('file.hasTag("task")')).toEqual([]);
    expect(bareStrings('status == "open"')).toEqual([]);
    expect(bareStrings('("open") || x')).toEqual(["open"]);
  });

  it("says a bare string is a string on its own, and no values when the filters matched", () => {
    const hints = filterHints('filters: file.hasTag("task") && "open"', true, none);
    expect(hints).toContain('The filter "open" is a string on its own');
    expect(hints).not.toContain("takes these values");
    expect(hints).not.toContain("No note in the vault");
  });

  it("says a comparison written with one = should use ==", () => {
    const hints = filterHints('filters: status = "open"', true, none);
    expect(hints).toContain("Compare with ==, not =: 'status == \"open\"'.");
  });

  it("lists the values a compared property takes in the vault when nothing matched, and says so when none", () => {
    const values = (property: string) => {
      if (property === "status") {
        return new Map([["open", 60], ["in-progress", 25], ["done", 26]]);
      }
      return new Map<string, number>();
    };
    const hints = filterHints(
      'filters: file.frontmatter.status == "open" && priority == "high"', false, values);
    expect(hints).toContain('status takes these values in the vault (write it as status or note.status): '
      + '"open" (60), "done" (26), "in-progress" (25).');
    expect(hints).toContain("No note in the vault has a property priority.");
    expect(hints).not.toContain("priority takes these values");
    expect(hints).not.toContain("write it as priority");
  });

  it("lists the values of a compared property once, and never of a file property, when nothing matched", () => {
    const definition = "filters:\n  and:\n    - file.hasTag(\"task\")\n    - 'status == \"x\"'\n";
    const asked: string[] = [];
    const values = (property: string) => {
      asked.push(property);
      return new Map([["x", 3]]);
    };
    const hints = filterHints(definition, false, values);
    expect(hints.split("\n").filter((line) => line.startsWith("status takes these values"))).toHaveLength(1);
    expect(asked.some((property) => property.startsWith("file."))).toBe(false);
    expect(asked).toEqual(["status"]);

    const askedWhenMatched: string[] = [];
    const matchedHints = filterHints(definition, true, (property) => {
      askedWhenMatched.push(property);
      return new Map([["x", 3]]);
    });
    expect(matchedHints).not.toContain("takes these values");
    expect(askedWhenMatched).toEqual([]);
  });
});

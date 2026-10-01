import { describe, expect, it } from "vitest";

import { ArgumentError } from "../errors";
import { readArgs, type ToolSpec } from "./tool";
import specs from "./specs.json";

const listNotesSpec = (specs as unknown as ToolSpec[]).find((s) => s.name === "list_notes")!;
const readNotesSpec = (specs as unknown as ToolSpec[]).find((s) => s.name === "read_notes")!;

describe("readArgs — list_notes and read_notes", () => {
  it("list_notes defaults: path is '', recursive is false, limit is 100", () => {
    const args = readArgs(listNotesSpec, {});
    expect(args.path).toBe("");
    expect(args.recursive).toBe(false);
    expect(args.limit).toBe(100);
  });

  it("list_notes limit '5' is read as 5 and ' 7 ' as 7", () => {
    const args1 = readArgs(listNotesSpec, { limit: "5" });
    expect(args1.limit).toBe(5);  // the value itself: int() would turn "5" into 5 on its own

    const args2 = readArgs(listNotesSpec, { limit: " 7 " });
    expect(args2.limit).toBe(7);
  });

  it("list_notes limit '5.5' throws ArgumentError", () => {
    expect(() => readArgs(listNotesSpec, { limit: "5.5" })).toThrow(ArgumentError);
    expect(() => readArgs(listNotesSpec, { limit: "5.5" })).toThrow("argument 'limit' must be an integer");
  });

  it("list_notes limit 'many' throws ArgumentError", () => {
    expect(() => readArgs(listNotesSpec, { limit: "many" })).toThrow(ArgumentError);
    expect(() => readArgs(listNotesSpec, { limit: "many" })).toThrow("argument 'limit' must be an integer");
  });

  it("list_notes recursive 'true' is true", () => {
    const args = readArgs(listNotesSpec, { recursive: "true" });
    expect(args.recursive).toBe(true);
  });

  it("list_notes recursive 'True' is true", () => {
    const args = readArgs(listNotesSpec, { recursive: "True" });
    expect(args.recursive).toBe(true);
  });

  it("list_notes recursive 1 is true", () => {
    const args = readArgs(listNotesSpec, { recursive: 1 });
    expect(args.recursive).toBe(true);
  });

  it("list_notes recursive 'false' is false", () => {
    const args = readArgs(listNotesSpec, { recursive: "false" });
    expect(args.recursive).toBe(false);
  });

  it("list_notes recursive 'False' is false", () => {
    const args = readArgs(listNotesSpec, { recursive: "False" });
    expect(args.recursive).toBe(false);
  });

  it("list_notes recursive 0 is false", () => {
    const args = readArgs(listNotesSpec, { recursive: 0 });
    expect(args.recursive).toBe(false);
  });

  it("list_notes recursive 'yes' throws ArgumentError", () => {
    expect(() => readArgs(listNotesSpec, { recursive: "yes" })).toThrow(ArgumentError);
    expect(() => readArgs(listNotesSpec, { recursive: "yes" })).toThrow(
      "argument 'recursive' must be a boolean",
    );
  });

  it("read_notes absent paths throws ArgumentError", () => {
    expect(() => readArgs(readNotesSpec, {})).toThrow(ArgumentError);
    expect(() => readArgs(readNotesSpec, {})).toThrow("missing required argument 'paths'");
  });

  it("read_notes paths: null throws ArgumentError", () => {
    expect(() => readArgs(readNotesSpec, { paths: null })).toThrow(ArgumentError);
    expect(() => readArgs(readNotesSpec, { paths: null })).toThrow("missing required argument 'paths'");
  });

  it("read_notes paths: 'a.md' (string, not list) throws ArgumentError", () => {
    expect(() => readArgs(readNotesSpec, { paths: "a.md" })).toThrow(ArgumentError);
    expect(() => readArgs(readNotesSpec, { paths: "a.md" })).toThrow("argument 'paths' must be a list");
  });

  it("list_notes path: 42 is read as string '42' and int('limit') is 100 when limit is left out", () => {
    const args = readArgs(listNotesSpec, { path: 42 });
    expect(args.str("path")).toBe("42");
    expect(args.int("limit")).toBe(100);
  });
});

describe("an argument the tool does not take (#163)", () => {
  it("is an error naming the arguments the tool takes, not silently dropped", () => {
    expect(() => readArgs(listNotesSpec, { folder: "Inbox" }))
      .toThrow("list_notes has no argument 'folder'; it takes path, recursive, limit");
    expect(() => readArgs(listNotesSpec, { folder: "Inbox" })).toThrow(ArgumentError);
  });

  it("names every one it does not take", () => {
    expect(() => readArgs(readNotesSpec, { paths: ["a.md"], limit: 5, sort: "name" }))
      .toThrow("read_notes has no argument 'limit', 'sort'; it takes paths");
  });
});

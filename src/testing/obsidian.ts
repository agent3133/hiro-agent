/**
 * A stand-in for the `obsidian` module in Vitest (#368): vitest.config.ts aliases "obsidian" to this file, so the code
 * that imports it — the views, the settings tabs, vault/, inprocess/ — can have unit tests. The real module exists
 * only inside the app; its npm package holds types alone.
 *
 * - `App` works on a real temporary folder (`makeApp`): its vault indexes the files outside dot folders, as
 *   Obsidian does, and its adapter reaches all of them. Writes land on disk, so a test reads back what happened.
 * - `Modal`, `Setting` and `PluginSettingTab` build real elements under jsdom (`// @vitest-environment jsdom`):
 *   a test fills in a text field and clicks a button the way the user would. Obsidian's helpers on `HTMLElement`
 *   (`createEl`, `createDiv`, `empty`, `setText`, `addClass`, …) are installed when there is a DOM.
 * - `Notice` keeps what it said in `Notice.shown`; `requestUrl` answers what `stubRequestUrl` gives it, and
 *   `loadPdfJs` the fake PDF.js `stubPdfJs` gives it.
 *
 * Only what the plugin runs is here. A name the plugin imports only as a type needs nothing: it is gone once compiled.
 * Never imported by the plugin itself: ESLint and the build leave `src/**\/testing/**` out.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// Obsidian hands plugins the moment it bundles; the obsidian package depends on the same version (2.29.4)
export { default as moment } from "moment";

// -- the globals Obsidian's renderer has -------------------------------------------------------------------------------

const g = globalThis as Record<string, unknown>;
// The plugin calls window.setTimeout and reads activeDocument; under Node's environment neither exists
g.window ??= globalThis;
g.activeDocument ??= (g.document as Document | undefined) ?? { visibilityState: "visible" };
g.activeWindow ??= g.window;

// -- paths -----------------------------------------------------------------------------------------------------------

export function normalizePath(path: string): string {
  const cleaned = path.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\/|\/$/g, "").replace(/ | /g, " ");
  return cleaned === "" ? "/" : cleaned.normalize("NFC");
}

export function parseLinktext(linktext: string): { path: string; subpath: string } {
  const at = linktext.search(/[#^]/);
  return at < 0 ? { path: linktext, subpath: "" } : { path: linktext.slice(0, at), subpath: linktext.slice(at) };
}

export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  return Buffer.from(buffer).toString("base64");
}

export function htmlToMarkdown(html: string): string {
  return html.replace(/<[^>]+>/g, "").trim();
}

/** The tags of a file's cache, each with its "#": frontmatter `tags` and inline tags, as Obsidian gives them. */
export function getAllTags(cache: CachedMetadata | null): string[] | null {
  if (!cache) return null;
  const fromFrontmatter = cache.frontmatter?.tags;
  const listed = Array.isArray(fromFrontmatter) ? fromFrontmatter
    : typeof fromFrontmatter === "string" ? fromFrontmatter.split(/[\s,]+/) : [];
  return [...listed.filter(Boolean).map((tag) => `#${String(tag).replace(/^#/, "")}`), ...(cache.tags ?? []).map((t) => t.tag)];
}

interface LinkCache {
  link: string;
  original: string;
  displayText?: string;
  position: { start: { line: number; col: number; offset: number } };
}

export interface CachedMetadata {
  frontmatter?: Record<string, unknown>;
  links?: LinkCache[];
  embeds?: LinkCache[];
  frontmatterLinks?: { key: string; link: string; original: string }[];
  tags?: { tag: string; position: LinkCache["position"] }[];
  headings?: { heading: string; level: number; position: LinkCache["position"] }[];
  /** List items; `task` is the character between a task's brackets (" " open, "x" done), undefined for a plain item. */
  listItems?: { task?: string; parent: number; position: LinkCache["position"] }[];
}

/** A small YAML subset for frontmatter: `key: value`, `key: [a, b]` and `key:` followed by `- item` lines. */
function parseFrontmatter(text: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let listKey: string | null = null;
  const scalar = (raw: string): unknown => {
    const value = raw.trim().replace(/^["']|["']$/g, "");
    if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
    if (value === "true" || value === "false") return value === "true";
    return value;
  };
  for (const line of text.split("\n")) {
    const item = /^\s+-\s+(.*)$/.exec(line);
    if (item && listKey) {
      (out[listKey] as unknown[]).push(scalar(item[1]));
      continue;
    }
    const pair = /^([^:#\s][^:]*):\s*(.*)$/.exec(line);
    if (!pair) continue;
    const [, key, value] = pair;
    if (value === "") {
      listKey = key.trim();
      out[listKey] = [];
    } else {
      listKey = null;
      out[key.trim()] = /^\[.*\]$/.test(value.trim())
        ? value.trim().slice(1, -1).split(",").map((v) => scalar(v)).filter((v) => v !== "")
        : scalar(value);
    }
  }
  return out;
}

/** Obsidian's metadata cache, worked out from the files on disk whenever it is asked (#369). */
export class MetadataCache {
  constructor(private readonly vault: Vault) {}

  getFileCache(file: TFile | null): CachedMetadata | null {
    if (!file || file.extension !== "md") return null;
    let text: string;
    try {
      text = readFileSync(this.vault.adapter.full(file.path), "utf-8");
    } catch {
      return null;
    }
    const cache: CachedMetadata = { links: [], embeds: [], tags: [], headings: [], frontmatterLinks: [], listItems: [] };
    let body = text;
    let offset = 0;
    const front = /^---\n([\s\S]*?)\n---\n?/.exec(text);
    if (front) {
      cache.frontmatter = parseFrontmatter(front[1]);
      for (const [key, value] of Object.entries(cache.frontmatter)) {
        for (const v of Array.isArray(value) ? value : [value]) {
          const link = typeof v === "string" ? /^\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]$/.exec(v) : null;
          if (link) cache.frontmatterLinks!.push({ key, link: link[1], original: v as string });
        }
      }
      offset = front[0].length;
      body = text.slice(offset);
    }
    const lines = text.split("\n");
    const at = (index: number) => {
      const before = text.slice(0, index).split("\n");
      return { start: { line: before.length - 1, col: before[before.length - 1].length, offset: index } };
    };
    for (const match of body.matchAll(/(!?)\[\[([^\]|]+?)(?:\|([^\]]*))?\]\]/g)) {
      const entry: LinkCache = { link: match[2], original: match[0], displayText: match[3] ?? match[2],
                                 position: at(offset + match.index!) };
      (match[1] ? cache.embeds! : cache.links!).push(entry);
    }
    for (const match of body.matchAll(/(^|\s)#([\p{L}\p{N}_/-]+)/gu)) {
      if (/^\d+$/.test(match[2])) continue;
      cache.tags!.push({ tag: `#${match[2]}`, position: at(offset + match.index! + match[1].length) });
    }
    const bodyStart = front ? front[0].split("\n").length - 1 : 0;
    lines.forEach((line, index) => {
      const item = /^\s*(?:[-*+]|\d+[.)])\s+(?:\[(.)\]\s)?/.exec(line);
      if (item && index >= bodyStart) {
        cache.listItems!.push({ task: item[1], parent: -1, position: { start: { line: index, col: 0, offset: 0 } } });
      }
      const heading = /^(#{1,6})\s+(.*)$/.exec(line);
      if (heading && (!front || index > front[0].split("\n").length - 2)) {
        cache.headings!.push({ heading: heading[2].trim(), level: heading[1].length,
                               position: { start: { line: index, col: 0, offset: 0 } } });
      }
    });
    return cache;
  }

  /** The file *linkpath* names from *source*: a path, or a name — the nearest by folder, then the shortest path. */
  getFirstLinkpathDest(linkpath: string, source: string): TFile | null {
    const target = parseLinktext(linkpath).path;
    if (!target) return null;
    // A link is the end of a path, ".md" understood: [[Alpha]], [[Notes/Alpha]], [[pixel.png]]
    const lower = target.toLowerCase();
    const wanted = /\.[a-z0-9]+$/i.test(target) && !lower.endsWith(".md") ? lower : lower.replace(/(\.md)?$/, ".md");
    const matches = this.vault.getFiles().filter((f) => {
      const path = f.path.toLowerCase();
      return path === wanted || path.endsWith(`/${wanted}`);
    });
    if (!matches.length) return null;
    const folder = source.split("/").slice(0, -1).join("/");
    return matches.find((f) => f.path.split("/").slice(0, -1).join("/") === folder)
      ?? [...matches].sort((a, b) => a.path.length - b.path.length)[0];
  }

  private links(): { resolved: Record<string, Record<string, number>>; unresolved: Record<string, Record<string, number>> } {
    const resolved: Record<string, Record<string, number>> = {};
    const unresolved: Record<string, Record<string, number>> = {};
    for (const file of this.vault.getMarkdownFiles()) {
      const cache = this.getFileCache(file);
      resolved[file.path] = {};
      unresolved[file.path] = {};
      for (const link of [...(cache?.links ?? []), ...(cache?.embeds ?? []), ...(cache?.frontmatterLinks ?? [])]) {
        const dest = this.getFirstLinkpathDest(link.link, file.path);
        const into = dest ? resolved[file.path] : unresolved[file.path];
        const key = dest ? dest.path : parseLinktext(link.link).path;
        into[key] = (into[key] ?? 0) + 1;
      }
    }
    return { resolved, unresolved };
  }

  get resolvedLinks(): Record<string, Record<string, number>> {
    return this.links().resolved;
  }

  get unresolvedLinks(): Record<string, Record<string, number>> {
    return this.links().unresolved;
  }

  on(): unknown {
    return {};
  }

  offref(): void {}
}

export const Platform = { isDesktop: true, isDesktopApp: true, isMobile: false, isMobileApp: false, isWin: false,
                          isMacOS: false, isLinux: true };

export const Keymap = { isModEvent: (): boolean => false };

export function setIcon(el: HTMLElement, icon: string): void {
  el.setAttribute("data-icon", icon);
}

// -- the vault -------------------------------------------------------------------------------------------------------

export class TAbstractFile {
  constructor(public vault: Vault, public path: string) {}
  get name(): string {
    return this.path.split("/").pop() ?? this.path;
  }
  get parent(): TFolder | null {
    if (this.path === "/") return null;
    const up = this.path.split("/").slice(0, -1).join("/");
    return new TFolder(this.vault, up || "/");
  }
}

export class TFile extends TAbstractFile {
  get basename(): string {
    return this.name.replace(/\.[^.]*$/, "");
  }
  get extension(): string {
    return /\.([^.]*)$/.exec(this.name)?.[1] ?? "";
  }
  get stat(): { ctime: number; mtime: number; size: number } {
    const s = statSync(this.vault.adapter.full(this.path));
    return { ctime: s.ctimeMs, mtime: s.mtimeMs, size: s.size };
  }
}

export class TFolder extends TAbstractFile {
  isRoot(): boolean {
    return this.path === "/";
  }
  get children(): TAbstractFile[] {
    return this.vault.getAllLoadedFiles().filter((f) => f.parent?.path === this.path && f.path !== this.path);
  }
}

interface ListedFiles {
  files: string[];
  folders: string[];
}

/** The desktop adapter: the vault's folder on disk, every file in it, dot folders too. */
export class FileSystemAdapter {
  constructor(private readonly basePath: string) {}

  getBasePath(): string {
    return this.basePath;
  }

  full(path: string): string {
    const normalized = normalizePath(path);
    return normalized === "/" ? this.basePath : join(this.basePath, normalized);
  }

  async exists(path: string): Promise<boolean> {
    return existsSync(this.full(path));
  }

  async stat(path: string): Promise<{ type: "file" | "folder"; ctime: number; mtime: number; size: number } | null> {
    try {
      const s = await stat(this.full(path));
      return { type: s.isDirectory() ? "folder" : "file", ctime: s.ctimeMs, mtime: s.mtimeMs, size: s.size };
    } catch {
      return null;
    }
  }

  async list(path: string): Promise<ListedFiles> {
    const base = normalizePath(path);
    const prefix = base === "/" ? "" : `${base}/`;
    const listed: ListedFiles = { files: [], folders: [] };
    for (const entry of readdirSync(this.full(path), { withFileTypes: true })) {
      (entry.isDirectory() ? listed.folders : listed.files).push(prefix + entry.name);
    }
    return listed;
  }

  async read(path: string): Promise<string> {
    return readFile(this.full(path), "utf-8");
  }

  async readBinary(path: string): Promise<ArrayBuffer> {
    const data = await readFile(this.full(path));
    return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  }

  async write(path: string, text: string): Promise<void> {
    await mkdir(dirname(this.full(path)), { recursive: true });
    await writeFile(this.full(path), text, "utf-8");
  }

  async mkdir(path: string): Promise<void> {
    await mkdir(this.full(path), { recursive: true });
  }

  async remove(path: string): Promise<void> {
    await rm(this.full(path), { force: true });
  }

  async rename(from: string, to: string): Promise<void> {
    await mkdir(dirname(this.full(to)), { recursive: true });
    await rename(this.full(from), this.full(to));
  }

  /** The vault's own `.trash` folder. */
  async trashLocal(path: string): Promise<void> {
    await this.rename(path, `.trash/${normalizePath(path).split("/").pop()}`);
  }

  /** There is no system trash here: false, so the caller falls back to `.trash`, as Obsidian does without one. */
  async trashSystem(): Promise<boolean> {
    return false;
  }
}

export class Vault {
  configDir = ".obsidian";
  /** Settings a test sets, read through `getConfig` (`trashOption`: "system", "local" or "none"). */
  config: Record<string, unknown> = {};

  constructor(public adapter: FileSystemAdapter, private readonly name: string) {}

  getName(): string {
    return this.name;
  }

  getConfig(key: string): unknown {
    return this.config[key];
  }

  /** What Obsidian indexes: every file and folder outside dot folders, and the root. */
  getAllLoadedFiles(): TAbstractFile[] {
    const found: TAbstractFile[] = [new TFolder(this, "/")];
    const visit = (folder: string): void => {
      for (const entry of readdirSync(this.adapter.full(folder), { withFileTypes: true })) {
        if (entry.name.startsWith(".")) continue;
        const path = folder === "/" ? entry.name : `${folder}/${entry.name}`;
        if (entry.isDirectory()) {
          found.push(new TFolder(this, path));
          visit(path);
        } else {
          found.push(new TFile(this, path));
        }
      }
    };
    visit("/");
    return found;
  }

  getFiles(): TFile[] {
    return this.getAllLoadedFiles().filter((f): f is TFile => f instanceof TFile);
  }

  getMarkdownFiles(): TFile[] {
    return this.getFiles().filter((f) => f.extension === "md");
  }

  getAbstractFileByPath(path: string): TAbstractFile | null {
    const normalized = normalizePath(path);
    if (normalized === "/") return new TFolder(this, "/");
    if (normalized.split("/").some((part) => part.startsWith("."))) return null;  // not indexed
    const full = this.adapter.full(normalized);
    if (!existsSync(full)) return null;
    // The index holds names as they are on disk: not in another letter case, not a Windows short name (#393)
    let folder = "/";
    for (const part of normalized.split("/")) {
      if (!readdirSync(this.adapter.full(folder)).includes(part)) return null;
      folder = folder === "/" ? part : `${folder}/${part}`;
    }
    return statSync(full).isDirectory() ? new TFolder(this, normalized) : new TFile(this, normalized);
  }

  getFileByPath(path: string): TFile | null {
    const file = this.getAbstractFileByPath(path);
    return file instanceof TFile ? file : null;
  }

  async read(file: TFile): Promise<string> {
    return this.adapter.read(file.path);
  }

  async cachedRead(file: TFile): Promise<string> {
    return this.adapter.read(file.path);
  }

  async readBinary(file: TFile): Promise<ArrayBuffer> {
    return this.adapter.readBinary(file.path);
  }

  async createBinary(path: string, data: ArrayBuffer): Promise<TFile> {
    if (existsSync(this.adapter.full(path))) throw new Error("File already exists.");
    await mkdir(dirname(this.adapter.full(path)), { recursive: true });
    await writeFile(this.adapter.full(path), new Uint8Array(data));
    return new TFile(this, normalizePath(path));
  }

  async modify(file: TFile, text: string): Promise<void> {
    await this.adapter.write(file.path, text);
  }

  async process(file: TFile, change: (text: string) => string): Promise<string> {
    const after = change(await this.adapter.read(file.path));
    await this.adapter.write(file.path, after);
    return after;
  }

  async create(path: string, text: string): Promise<TFile> {
    if (existsSync(this.adapter.full(path))) throw new Error("File already exists.");
    await this.adapter.write(path, text);
    return new TFile(this, normalizePath(path));
  }

  async createFolder(path: string): Promise<TFolder> {
    await this.adapter.mkdir(path);
    return new TFolder(this, normalizePath(path));
  }

  async rename(file: TAbstractFile, to: string): Promise<void> {
    await this.adapter.rename(file.path, to);
  }
}

export class FileManager {
  constructor(private readonly vault: Vault) {}

  /** As the vault's `trashOption` says: "none" deletes, "local" (and here, "system") moves to `.trash`. */
  async trashFile(file: TAbstractFile): Promise<void> {
    if (this.vault.getConfig("trashOption") === "none") await rm(this.vault.adapter.full(file.path), { recursive: true });
    else await this.vault.adapter.trashLocal(file.path);
  }

  /** Where a new note goes: here always the vault's root, as Obsidian's default "Vault folder" setting says. */
  getNewFileParent(_sourcePath: string): TFolder {
    return new TFolder(this.vault, "/");
  }

  /** A move; links to it are not rewritten here (the Obsidian smoke suite tests that). */
  async renameFile(file: TAbstractFile, to: string): Promise<void> {
    await this.vault.adapter.rename(file.path, to);
  }

  async processFrontMatter(): Promise<void> {
    throw new Error("processFrontMatter is not in the obsidian stub");
  }
}

export class App {
  vault: Vault;
  fileManager: FileManager;
  metadataCache: MetadataCache;
  workspace = { getActiveFile: (): null => null, getActiveViewOfType: (): null => null, on: (): void => undefined,
                offref: (): void => undefined, getLeavesOfType: (): unknown[] => [], onLayoutReady: (cb: () => void) => cb() };
  private readonly storage = new Map<string, unknown>();
  /** Obsidian's keychain (Settings → Keychain): a test puts entries in `secrets`. */
  readonly secrets = new Map<string, string>();
  readonly secretStorage = {
    getSecret: (name: string): string | null => this.secrets.get(name) ?? null,
    setSecret: (name: string, value: string): void => void this.secrets.set(name, value),
    listSecrets: (): string[] => [...this.secrets.keys()],
  };

  constructor(basePath: string, name = "test-vault") {
    this.vault = new Vault(new FileSystemAdapter(basePath), name);
    this.fileManager = new FileManager(this.vault);
    this.metadataCache = new MetadataCache(this.vault);
  }

  loadLocalStorage(key: string): unknown {
    return this.storage.get(key) ?? null;
  }

  saveLocalStorage(key: string, value: unknown): void {
    if (value === null || value === undefined) this.storage.delete(key);
    else this.storage.set(key, value);
  }
}

export interface TestApp {
  app: App;
  /** The vault's folder on disk. */
  root: string;
  /** Remove the folder again. */
  cleanup(): Promise<void>;
}

/**
 * An App on a fresh temporary folder holding *files* (path → text), and *from* copied in first when given.
 * Call `cleanup()` after the test.
 */
export async function makeApp(files: Record<string, string> = {}, from?: string): Promise<TestApp> {
  const root = await mkdtemp(join(tmpdir(), "obsidian-stub-"));
  if (from) await cp(from, root, { recursive: true });
  const app = new App(root);
  for (const [path, text] of Object.entries(files)) await app.vault.adapter.write(path, text);
  return { app, root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

// -- PDF.js ----------------------------------------------------------------------------------------------------------

let pdfJs: unknown = null;

/** What `loadPdfJs` gives until the next call: a fake PDF.js (`{ getDocument }`); null, it throws (#379). */
export function stubPdfJs(fake: unknown): void {
  pdfJs = fake;
}

export async function loadPdfJs(): Promise<any> {  // eslint-disable-line @typescript-eslint/no-explicit-any
  if (!pdfJs) throw new Error("PDF.js is not in the obsidian stub: call stubPdfJs first");
  return pdfJs;
}

// -- requestUrl ------------------------------------------------------------------------------------------------------

export interface RequestUrlParam {
  url: string;
  method?: string;
  body?: string | ArrayBuffer;
  headers?: Record<string, string>;
  throw?: boolean;
}

export interface RequestUrlResponse {
  status: number;
  text: string;
  json: unknown;
  headers: Record<string, string>;
  arrayBuffer: ArrayBuffer;
}

type RequestUrlHandler = (request: RequestUrlParam) => Partial<RequestUrlResponse> | Promise<Partial<RequestUrlResponse>>;
let requestHandler: RequestUrlHandler | null = null;

/** What `requestUrl` answers until the next call; null: it throws, as an unreachable address does. */
export function stubRequestUrl(handler: RequestUrlHandler | null): void {
  requestHandler = handler;
}

export async function requestUrl(request: RequestUrlParam | string): Promise<RequestUrlResponse> {
  const param = typeof request === "string" ? { url: request } : request;
  if (!requestHandler) throw new Error(`net::ERR_CONNECTION_REFUSED (${param.url})`);
  const answer = await requestHandler(param);
  const text = answer.text ?? (answer.json === undefined ? "" : JSON.stringify(answer.json));
  const status = answer.status ?? 200;
  if (param.throw !== false && status >= 400) throw new Error(`Request failed, status ${status}`);
  return { status, text, json: answer.json ?? (text ? JSON.parse(text) : null), headers: answer.headers ?? {},
           arrayBuffer: answer.arrayBuffer ?? new ArrayBuffer(0) };
}

// -- the DOM helpers Obsidian adds to elements --------------------------------------------------------------------------

interface ElOptions {
  cls?: string | string[];
  text?: string;
  attr?: Record<string, string | number | boolean>;
  title?: string;
  type?: string;
  value?: string;
  placeholder?: string;
  href?: string;
}

type ElCallback = (el: HTMLElement) => void;

function makeEl(doc: Document, tag: string, o?: ElOptions | string, callback?: ElCallback): HTMLElement {
  const el = doc.createElement(tag);
  const options: ElOptions = typeof o === "string" ? { cls: o } : (o ?? {});
  if (options.cls) el.className = Array.isArray(options.cls) ? options.cls.join(" ") : options.cls;
  if (options.text !== undefined) el.textContent = options.text;
  if (options.title !== undefined) el.title = options.title;
  for (const [key, value] of Object.entries(options.attr ?? {})) el.setAttribute(key, String(value));
  for (const key of ["type", "value", "placeholder", "href"] as const) {
    if (options[key] !== undefined) (el as unknown as Record<string, string>)[key] = options[key];
  }
  callback?.(el);
  return el;
}

function installDomHelpers(): void {
  const proto = (g.HTMLElement as { prototype: Record<string, unknown> } | undefined)?.prototype;
  if (!proto || proto.createEl) return;
  const define = (name: string, fn: (this: HTMLElement, ...args: never[]) => unknown): void => {
    Object.defineProperty(proto, name, { value: fn, configurable: true, writable: true });
  };
  define("createEl", function (this: HTMLElement, tag: string, o?: ElOptions | string, cb?: ElCallback) {
    return this.appendChild(makeEl(this.ownerDocument, tag, o, cb));
  });
  define("createDiv", function (this: HTMLElement, o?: ElOptions | string, cb?: ElCallback) {
    return this.appendChild(makeEl(this.ownerDocument, "div", o, cb));
  });
  define("createSpan", function (this: HTMLElement, o?: ElOptions | string, cb?: ElCallback) {
    return this.appendChild(makeEl(this.ownerDocument, "span", o, cb));
  });
  define("empty", function (this: HTMLElement) {
    this.replaceChildren();
  });
  define("setText", function (this: HTMLElement, text: string) {
    this.textContent = text;
  });
  define("addClass", function (this: HTMLElement, ...cls: string[]) {
    this.classList.add(...cls);
  });
  define("removeClass", function (this: HTMLElement, ...cls: string[]) {
    this.classList.remove(...cls);
  });
  define("toggleClass", function (this: HTMLElement, cls: string, on: boolean) {
    this.classList.toggle(cls, on);
  });
  define("hasClass", function (this: HTMLElement, cls: string) {
    return this.classList.contains(cls);
  });
  define("setAttr", function (this: HTMLElement, name: string, value: string | number | boolean | null) {
    if (value === null) this.removeAttribute(name);
    else this.setAttribute(name, String(value));
  });
  define("show", function (this: HTMLElement) {
    this.style.display = "";
  });
  define("hide", function (this: HTMLElement) {
    this.style.display = "none";
  });
  define("toggle", function (this: HTMLElement, show: boolean) {
    this.style.display = show ? "" : "none";
  });
  // Obsidian's createFragment and the document-level createEl/createDiv
  g.createFragment ??= (cb?: (f: DocumentFragment) => void) => {
    const fragment = (g.document as Document).createDocumentFragment();
    cb?.(fragment);
    return fragment;
  };
  g.createEl ??= (tag: string, o?: ElOptions | string, cb?: ElCallback) => makeEl(g.document as Document, tag, o, cb);
  g.createDiv ??= (o?: ElOptions | string, cb?: ElCallback) => makeEl(g.document as Document, "div", o, cb);
  const fragmentProto = (g.DocumentFragment as { prototype: Record<string, unknown> } | undefined)?.prototype;
  if (fragmentProto && !fragmentProto.createEl) {
    for (const name of ["createEl", "createDiv", "createSpan"]) {
      Object.defineProperty(fragmentProto, name, { value: proto[name], configurable: true, writable: true });
    }
  }
}

installDomHelpers();

function doc(): Document {
  const d = g.document as Document | undefined;
  if (!d) throw new Error("this part of the obsidian stub needs a DOM: add `// @vitest-environment jsdom` to the test");
  return d;
}

// -- notices, modals, settings ---------------------------------------------------------------------------------------

export class Notice {
  /** Every notice shown since the test began; clear it in a beforeEach when a test counts them. */
  static shown: string[] = [];
  /** The notices themselves, newest last: a test clicks a button in one through its messageEl. */
  static all: Notice[] = [];
  noticeEl: HTMLElement | null = null;
  /** What the notice holds, as Obsidian's messageEl does: a fragment's buttons stay clickable. */
  messageEl: HTMLElement | null = typeof document === "undefined" ? null : document.createElement("div");
  message: string;
  hidden = false;

  constructor(message: string | DocumentFragment, public duration?: number) {
    this.message = this.fill(message);
    Notice.shown.push(this.message);
    Notice.all.push(this);
  }

  setMessage(message: string | DocumentFragment): this {
    this.message = this.fill(message);
    Notice.shown.push(this.message);
    return this;
  }

  hide(): void {
    this.hidden = true;
  }

  private fill(message: string | DocumentFragment): string {
    if (!this.messageEl) return typeof message === "string" ? message : (message.textContent ?? "");
    this.messageEl.replaceChildren();
    if (typeof message === "string") this.messageEl.textContent = message;
    else this.messageEl.append(message);
    return this.messageEl.textContent ?? "";
  }
}

export class Component {
  load(): void {}
  onload(): void {}
  unload(): void {}
  onunload(): void {}
  register(): void {}
  registerEvent(): void {}
  registerDomEvent(el: HTMLElement, type: string, listener: EventListener): void {
    el.addEventListener(type, listener);
  }
  registerInterval(id: number): number {
    return id;
  }
  addChild<T>(child: T): T {
    return child;
  }
}

export class Scope {
  register(): unknown {
    return {};
  }
  unregister(): void {}
}

export class Modal extends Component {
  modalEl: HTMLElement;
  titleEl: HTMLElement;
  contentEl: HTMLElement;
  containerEl: HTMLElement;
  scope = new Scope();
  /** Whether it is open: `open()` until `close()`. */
  isOpen = false;

  constructor(public app: App) {
    super();
    const d = doc();
    this.containerEl = d.createElement("div");
    this.modalEl = this.containerEl.appendChild(d.createElement("div"));
    this.titleEl = this.modalEl.appendChild(d.createElement("div"));
    this.contentEl = this.modalEl.appendChild(d.createElement("div"));
  }

  open(): void {
    this.isOpen = true;
    doc().body.appendChild(this.containerEl);
    void (this as unknown as { onOpen?: () => unknown }).onOpen?.();
  }

  close(): void {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.containerEl.remove();
    void (this as unknown as { onClose?: () => unknown }).onClose?.();
  }

  setTitle(title: string): this {
    this.titleEl.textContent = title;
    return this;
  }

  setContent(content: string): this {
    this.contentEl.textContent = content;
    return this;
  }
}

export class FuzzySuggestModal<T> extends Modal {
  setPlaceholder(): void {}
  setInstructions(): void {}
  /** For a test: choose *item* as a click on it would. */
  choose(item: T): void {
    (this as unknown as { onChooseItem(item: T, evt: Event): void }).onChooseItem(item, new Event("click"));
    this.close();
  }
}

abstract class ValueComponent<T> {
  protected handler: ((value: T) => unknown) | null = null;
  disabled = false;
  abstract getValue(): T;
  abstract setValue(value: T): this;
  onChange(handler: (value: T) => unknown): this {
    this.handler = handler;
    return this;
  }
  setDisabled(disabled: boolean): this {
    this.disabled = disabled;
    return this;
  }
  /** For a test: set the value as the user would, which calls `onChange`. */
  async type(value: T): Promise<void> {
    this.setValue(value);
    await this.handler?.(value);
  }
}

export class TextComponent extends ValueComponent<string> {
  inputEl: HTMLInputElement;
  constructor(containerEl: HTMLElement) {
    super();
    this.inputEl = containerEl.appendChild(containerEl.ownerDocument.createElement("input"));
    this.inputEl.type = "text";
    this.inputEl.addEventListener("input", () => void this.handler?.(this.inputEl.value));
  }
  getValue(): string {
    return this.inputEl.value;
  }
  setValue(value: string): this {
    this.inputEl.value = value;
    return this;
  }
  setPlaceholder(placeholder: string): this {
    this.inputEl.placeholder = placeholder;
    return this;
  }
}

export class TextAreaComponent extends ValueComponent<string> {
  inputEl: HTMLTextAreaElement;
  constructor(containerEl: HTMLElement) {
    super();
    this.inputEl = containerEl.appendChild(containerEl.ownerDocument.createElement("textarea"));
    this.inputEl.addEventListener("input", () => void this.handler?.(this.inputEl.value));
  }
  getValue(): string {
    return this.inputEl.value;
  }
  setValue(value: string): this {
    this.inputEl.value = value;
    return this;
  }
  setPlaceholder(placeholder: string): this {
    this.inputEl.placeholder = placeholder;
    return this;
  }
}

export class ToggleComponent extends ValueComponent<boolean> {
  toggleEl: HTMLInputElement;
  constructor(containerEl: HTMLElement) {
    super();
    this.toggleEl = containerEl.appendChild(containerEl.ownerDocument.createElement("input"));
    this.toggleEl.type = "checkbox";
    this.toggleEl.addEventListener("change", () => void this.handler?.(this.toggleEl.checked));
  }
  getValue(): boolean {
    return this.toggleEl.checked;
  }
  setValue(value: boolean): this {
    this.toggleEl.checked = value;
    return this;
  }
  setTooltip(): this {
    return this;
  }
}

export class DropdownComponent extends ValueComponent<string> {
  selectEl: HTMLSelectElement;
  constructor(containerEl: HTMLElement) {
    super();
    this.selectEl = containerEl.appendChild(containerEl.ownerDocument.createElement("select"));
    this.selectEl.addEventListener("change", () => void this.handler?.(this.selectEl.value));
  }
  addOption(value: string, display: string): this {
    const option = this.selectEl.appendChild(this.selectEl.ownerDocument.createElement("option"));
    option.value = value;
    option.textContent = display;
    return this;
  }
  addOptions(options: Record<string, string>): this {
    for (const [value, display] of Object.entries(options)) this.addOption(value, display);
    return this;
  }
  getValue(): string {
    return this.selectEl.value;
  }
  setValue(value: string): this {
    this.selectEl.value = value;
    return this;
  }
}

export class ButtonComponent {
  buttonEl: HTMLButtonElement;
  private handler: ((evt: MouseEvent) => unknown) | null = null;
  constructor(containerEl: HTMLElement) {
    this.buttonEl = containerEl.appendChild(containerEl.ownerDocument.createElement("button"));
    this.buttonEl.addEventListener("click", (evt) => void this.handler?.(evt));
  }
  setButtonText(text: string): this {
    this.buttonEl.textContent = text;
    return this;
  }
  setCta(): this {
    this.buttonEl.classList.add("mod-cta");
    return this;
  }
  setWarning(): this {
    this.buttonEl.classList.add("mod-warning");
    return this;
  }
  setDestructive(): this {
    this.buttonEl.classList.add("mod-destructive");
    return this;
  }
  setIcon(icon: string): this {
    this.buttonEl.setAttribute("data-icon", icon);
    return this;
  }
  setTooltip(tooltip: string): this {
    this.buttonEl.setAttribute("aria-label", tooltip);
    return this;
  }
  setDisabled(disabled: boolean): this {
    this.buttonEl.disabled = disabled;
    return this;
  }
  setClass(cls: string): this {
    this.buttonEl.classList.add(cls);
    return this;
  }
  onClick(handler: (evt: MouseEvent) => unknown): this {
    this.handler = handler;
    return this;
  }
  /** For a test: click it and wait for what the click started. */
  async click(): Promise<void> {
    await this.handler?.(new (g.MouseEvent as typeof MouseEvent)("click"));
  }
}

export class ExtraButtonComponent extends ButtonComponent {}

/** The keychain picker (Obsidian 1.11): here a text field holding the secret's name. */
export class SecretComponent extends TextComponent {
  constructor(_app: App, containerEl: HTMLElement) {
    super(containerEl);
  }
}

export class Setting {
  settingEl: HTMLElement;
  infoEl: HTMLElement;
  nameEl: HTMLElement;
  descEl: HTMLElement;
  controlEl: HTMLElement;
  /** Every control added, in order: a test finds a field by its setting's name and types into it. */
  components: unknown[] = [];

  constructor(containerEl: HTMLElement) {
    const d = containerEl.ownerDocument;
    this.settingEl = containerEl.appendChild(d.createElement("div"));
    this.settingEl.className = "setting-item";
    this.infoEl = this.settingEl.appendChild(d.createElement("div"));
    this.nameEl = this.infoEl.appendChild(d.createElement("div"));
    this.nameEl.className = "setting-item-name";
    this.descEl = this.infoEl.appendChild(d.createElement("div"));
    this.descEl.className = "setting-item-description";
    this.controlEl = this.settingEl.appendChild(d.createElement("div"));
    this.controlEl.className = "setting-item-control";
    settingsByElement.set(this.settingEl, this);
  }

  setName(name: string | DocumentFragment): this {
    this.nameEl.replaceChildren(typeof name === "string" ? name : name);
    return this;
  }
  setDesc(desc: string | DocumentFragment): this {
    this.descEl.replaceChildren(typeof desc === "string" ? desc : desc);
    return this;
  }
  setHeading(): this {
    this.settingEl.classList.add("setting-item-heading");
    return this;
  }
  setClass(cls: string): this {
    this.settingEl.classList.add(cls);
    return this;
  }
  setTooltip(): this {
    return this;
  }
  setDisabled(): this {
    return this;
  }
  then(cb: (setting: this) => void): this {
    cb(this);
    return this;
  }
  private add<C>(component: C, cb?: (component: C) => unknown): this {
    this.components.push(component);
    cb?.(component);
    return this;
  }
  addText(cb?: (component: TextComponent) => unknown): this {
    return this.add(new TextComponent(this.controlEl), cb);
  }
  addTextArea(cb?: (component: TextAreaComponent) => unknown): this {
    return this.add(new TextAreaComponent(this.controlEl), cb);
  }
  addSearch(cb?: (component: TextComponent) => unknown): this {
    return this.add(new TextComponent(this.controlEl), cb);
  }
  addToggle(cb?: (component: ToggleComponent) => unknown): this {
    return this.add(new ToggleComponent(this.controlEl), cb);
  }
  addDropdown(cb?: (component: DropdownComponent) => unknown): this {
    return this.add(new DropdownComponent(this.controlEl), cb);
  }
  addButton(cb?: (component: ButtonComponent) => unknown): this {
    return this.add(new ButtonComponent(this.controlEl), cb);
  }
  addExtraButton(cb?: (component: ExtraButtonComponent) => unknown): this {
    return this.add(new ExtraButtonComponent(this.controlEl), cb);
  }
  addComponent<C>(make: (el: HTMLElement) => C): this {
    return this.add(make(this.controlEl));
  }
}

const settingsByElement = new WeakMap<HTMLElement, Setting>();

/** For a test: the Settings under *container*, in order. */
export function settingsIn(container: HTMLElement): Setting[] {
  return [...container.querySelectorAll<HTMLElement>(".setting-item")]
    .map((el) => settingsByElement.get(el))
    .filter((s): s is Setting => s !== undefined);
}

/** For a test: the Setting under *container* whose name is *name*. */
export function settingNamed(container: HTMLElement, name: string): Setting {
  const found = settingsIn(container).find((s) => s.nameEl.textContent?.trim() === name);
  if (!found) {
    const names = settingsIn(container).map((s) => s.nameEl.textContent?.trim()).filter(Boolean);
    throw new Error(`no setting named '${name}' (there are: ${names.join(", ")})`);
  }
  return found;
}

/** A card of settings under a heading (1.11): `listEl` is where its Settings go. */
export class SettingGroup {
  groupEl: HTMLElement;
  headingEl: HTMLElement;
  listEl: HTMLElement;
  constructor(containerEl: HTMLElement) {
    const d = containerEl.ownerDocument;
    this.groupEl = containerEl.appendChild(d.createElement("div"));
    this.groupEl.className = "setting-group";
    this.headingEl = this.groupEl.appendChild(d.createElement("div"));
    this.listEl = this.groupEl.appendChild(d.createElement("div"));
  }
  setHeading(text: string): this {
    this.headingEl.textContent = text;
    return this;
  }
  addSetting(cb: (setting: Setting) => unknown): this {
    cb(new Setting(this.listEl));
    return this;
  }
}

/** For a test: the button labelled *text* among the Settings under *container* (the first, if several). */
export function buttonNamed(container: HTMLElement, text: string): ButtonComponent {
  for (const setting of settingsIn(container)) {
    for (const component of setting.components) {
      if (component instanceof ButtonComponent && component.buttonEl.textContent === text) return component;
    }
  }
  throw new Error(`no button '${text}'`);
}

export class Plugin extends Component {
  constructor(public app: App, public manifest: { id: string; version: string; dir?: string } = { id: "agent", version: "0.0.0" }) {
    super();
  }
  private data: unknown = null;
  async loadData(): Promise<unknown> {
    return this.data;
  }
  async saveData(data: unknown): Promise<void> {
    this.data = data;
  }
  addCommand(command: unknown): unknown {
    return command;
  }
  addRibbonIcon(): HTMLElement {
    return doc().createElement("div");
  }
  addSettingTab(): void {}
  addStatusBarItem(): HTMLElement {
    return doc().createElement("div");
  }
  registerView(): void {}
  registerObsidianProtocolHandler(): void {}
  registerCliHandler(): void {}
  registerEditorExtension(): void {}
  registerMarkdownCodeBlockProcessor(): void {}
  registerBasesView(): boolean {
    return true;
  }
  /** What `data.json` holds now; a test changes it as sync would, then calls `onExternalSettingsChange` (#396). */
  setStoredData(data: unknown): void {
    this.data = data;
  }
}

/** A page of a plugin's settings (Obsidian 1.13): what the plugin's own pages extend. */
export abstract class SettingPage {
  rootEl: HTMLElement = doc().createElement("div");
  titlebarEl: HTMLElement = doc().createElement("div");
  containerEl: HTMLElement = doc().createElement("div");
  title = "";
  display(): void {}
  hide(): void {}
}

export class PluginSettingTab {
  containerEl: HTMLElement;
  constructor(public app: App, public plugin: unknown) {
    this.containerEl = doc().createElement("div");
  }
  display(): void {}
  hide(): void {}
  /** Describe the settings anew (Obsidian 1.13's settings definitions). */
  update(): void {}
}

export class ItemView extends Component {
  containerEl: HTMLElement;
  contentEl: HTMLElement;
  app: App;
  constructor(public leaf: WorkspaceLeaf) {
    super();
    const d = doc();
    this.app = leaf.app;
    this.containerEl = d.createElement("div");
    this.containerEl.appendChild(d.createElement("div"));
    this.contentEl = this.containerEl.appendChild(d.createElement("div"));
  }
}

export class WorkspaceLeaf {
  constructor(public app: App) {}
}

export class MarkdownView {}

/** Bases (1.10): the view a Base hands its query's result to (vault/basesQuery.ts). */
export class BasesView extends Component {
  data: unknown = null;
  constructor(public controller: unknown) {
    super();
  }
}

export class QueryController {}
export class Menu {
  addItem(cb: (item: unknown) => unknown): this {
    const item = { setTitle: () => item, setIcon: () => item, onClick: () => item, setSection: () => item,
                   setChecked: () => item, setDisabled: () => item };
    cb(item);
    return this;
  }
  addSeparator(): this {
    return this;
  }
  showAtMouseEvent(): void {}
  showAtPosition(): void {}
}

export const MarkdownRenderer = {
  async render(_app: App, markdown: string, el: HTMLElement): Promise<void> {
    el.textContent = markdown;
  },
};

/**
 * Where Obsidian keeps the code-block processors plugins register, by language (not in its published types). A
 * test sets `codeBlockPostProcessors` to what an installed plugin would have registered (#395).
 */
export class MarkdownPreviewRenderer {
  static codeBlockPostProcessors: Record<string, unknown> | undefined = {};
}

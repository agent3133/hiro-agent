/**
 * An Obsidian canvas (`.canvas`, JSON Canvas) as text, read only (#214): its cards in reading order — top to
 * bottom, left to right — with the notes, files and links they point at, the groups they sit in, and the arrows
 * between them. Writing a canvas is not offered: there is a layout to keep, and a board to break.
 */

interface CanvasNode {
  id: string;
  type: "text" | "file" | "link" | "group" | string;
  text?: string;
  file?: string;
  url?: string;
  label?: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface CanvasEdge {
  fromNode: string;
  toNode: string;
  label?: string;
}

/** The canvas *shown*, from its JSON *text*, as Markdown; an "Error: …" line for one that cannot be read. */
export function canvasToMarkdown(shown: string, text: string): string {
  let data: unknown;
  try {
    data = JSON.parse(text || "{}");
  } catch {
    return `Error: '${shown}' is not a readable canvas (its JSON is broken)`;
  }
  // JSON that is not a canvas — null, a list, nodes that are no list — is said, not thrown (#385)
  const { nodes: rawNodes = [], edges: rawEdges = [] } = (data ?? {}) as { nodes?: unknown; edges?: unknown };
  if (typeof data !== "object" || data === null || Array.isArray(data) || !Array.isArray(rawNodes) || !Array.isArray(rawEdges)) {
    return `Error: '${shown}' is not a readable canvas (its JSON holds no list of cards)`;
  }
  const number0 = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);
  const nodes = (rawNodes as CanvasNode[]).filter((node) => node && typeof node === "object" && typeof node.id === "string")
    .map((node) => ({ ...node, x: number0(node.x), y: number0(node.y), width: number0(node.width), height: number0(node.height) }));
  const edges = (rawEdges as CanvasEdge[]).filter((edge) => edge && typeof edge === "object" && edge.fromNode && edge.toNode);
  const groups = nodes.filter((node) => node.type === "group");
  const cards = nodes.filter((node) => node.type !== "group")
    .sort((a, b) => (a.y - b.y) || (a.x - b.x));
  if (!cards.length && !groups.length) return `Canvas '${shown}' is empty`;

  const number = new Map(cards.map((card, index) => [card.id, index + 1]));
  const inside = (card: CanvasNode, group: CanvasNode): boolean => card.x >= group.x && card.y >= group.y
    && card.x + card.width <= group.x + group.width && card.y + card.height <= group.y + group.height;
  const describe = (card: CanvasNode): string => {
    if (card.type === "file") return `note ${card.file ?? ""}`.trim();
    if (card.type === "link") return `link ${card.url ?? ""}`.trim();
    const body = (card.text ?? "").trim();
    return body.includes("\n") ? `text:\n${body.split("\n").map((line) => `   ${line}`).join("\n")}` : `text: ${body}`;
  };

  const out: string[] = [`Canvas '${shown}' — ${cards.length} card${cards.length === 1 ? "" : "s"}, `
    + `${edges.length} connection${edges.length === 1 ? "" : "s"}${groups.length ? `, ${groups.length} group${groups.length === 1 ? "" : "s"}` : ""}`];
  out.push("", "## Cards", "", ...cards.map((card) => `${number.get(card.id)}. ${describe(card)}`));
  if (groups.length) {
    out.push("", "## Groups", "");
    for (const group of groups) {
      const members = cards.filter((card) => inside(card, group)).map((card) => number.get(card.id));
      out.push(`- ${group.label || "(unnamed group)"}: ${members.length ? `cards ${members.join(", ")}` : "empty"}`);
    }
  }
  if (edges.length) {
    out.push("", "## Connections", "");
    const name = (id: string): string => {
      const group = groups.find((g) => g.id === id);
      return group ? `group "${group.label ?? ""}"` : `${number.get(id) ?? "?"}`;
    };
    for (const edge of edges) out.push(`- ${name(edge.fromNode)} → ${name(edge.toNode)}${edge.label ? `: ${edge.label}` : ""}`);
  }
  return out.join("\n");
}

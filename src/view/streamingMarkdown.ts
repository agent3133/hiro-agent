/**
 * An answer as it is drawn while it still arrives (#189). A diagram can only be drawn from finished code: drawn
 * on every frame of a streamed answer, a Mermaid block was redrawn from half its code each time, and the chat
 * jittered. While streaming, such blocks show as code; the finished answer draws them once. No Obsidian in here.
 */

/** Fenced blocks drawn as pictures rather than shown as code. */
const DRAWN = ["mermaid"];

/** *text* with every drawn block's language changed, so a renderer shows it as plain code for now. */
export function asStreaming(text: string): string {
  return text.replace(/^([ \t]*)(`{3,}|~{3,})[ \t]*([\w-]+)/gm, (whole, indent: string, fence: string, language: string) =>
    (DRAWN.includes(language.toLowerCase()) ? `${indent}${fence}text` : whole));
}

/**
 * The parts of a zipped document — Office, OpenDocument, EPUB — as text, for the readers beside this file (#211).
 * Through fflate, and with the sizes the archive declares checked before anything is unpacked: a small file that
 * unpacks to gigabytes (a zip bomb) is refused rather than read.
 */

import { strFromU8, unzipSync } from "fflate";

/** The most a document's text parts may unpack to, together: far beyond any real document's XML. */
export const MAX_UNPACKED = 100_000_000;

export class DocumentError extends Error {}

/** The entries of *data* that *wanted* names, as text; a DocumentError for an archive that is not one, or too big. */
export function unzipText(data: Uint8Array, wanted: (name: string) => boolean,
                          limit = MAX_UNPACKED): Map<string, string> {
  let total = 0;
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(data, {
      filter: (file) => {
        if (!wanted(file.name)) return false;
        total += file.originalSize;
        if (total > limit) {
          throw new DocumentError(`the file unpacks to more than ${Math.round(limit / 1_000_000)} MB of text; it is not read`);
        }
        return true;
      },
    });
  } catch (error) {
    if (error instanceof DocumentError) throw error;
    throw new DocumentError(`not a readable document (${error instanceof Error ? error.message : String(error)})`);
  }
  const texts = new Map<string, string>();
  for (const [name, bytes] of Object.entries(entries)) texts.set(name, strFromU8(bytes));
  return texts;
}

/** *target* of a relationship, relative to the part *from* (`word/document.xml`), as a path inside the archive. */
export function resolvePart(from: string, target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  const parts = from.split("/").slice(0, -1);
  for (const piece of target.split("/")) {
    if (piece === "..") parts.pop();
    else if (piece && piece !== ".") parts.push(piece);
  }
  return parts.join("/");
}

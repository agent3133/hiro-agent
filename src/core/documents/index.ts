/**
 * Documents that are zipped XML, read as text for read_attachment: Word, Excel and PowerPoint (#211), OpenDocument
 * (#212), EPUB (#213). The old binary formats (.doc, .xls, .ppt) are not zip archives and would need a reader of
 * their own: they are named, with the way round.
 */

import { DOCX_PARTS, docxToMarkdown } from "./docx";
import { EPUB_PARTS, epubToMarkdown } from "./epub";
import { ODF_PARTS, odfToMarkdown } from "./odf";
import { PPTX_PARTS, pptxToMarkdown } from "./pptx";
import { XLSX_PARTS, xlsxToMarkdown } from "./xlsx";
import { DocumentError, unzipText } from "./zip";

const READERS: Record<string, { parts: (name: string) => boolean; read: (parts: Map<string, string>, pages: string) => string;
                                 what: string }> = {
  docx: { parts: DOCX_PARTS, read: (parts) => docxToMarkdown(parts), what: "Word document" },
  docm: { parts: DOCX_PARTS, read: (parts) => docxToMarkdown(parts), what: "Word document" },
  xlsx: { parts: XLSX_PARTS, read: xlsxToMarkdown, what: "Excel workbook" },
  xlsm: { parts: XLSX_PARTS, read: xlsxToMarkdown, what: "Excel workbook" },
  pptx: { parts: PPTX_PARTS, read: pptxToMarkdown, what: "PowerPoint deck" },
  pptm: { parts: PPTX_PARTS, read: pptxToMarkdown, what: "PowerPoint deck" },
  // LibreOffice's formats (#212) and books (#213)
  odt: { parts: ODF_PARTS, read: (parts) => odfToMarkdown("odt", parts), what: "OpenDocument text" },
  ods: { parts: ODF_PARTS, read: (parts, pages) => odfToMarkdown("ods", parts, pages), what: "OpenDocument spreadsheet" },
  odp: { parts: ODF_PARTS, read: (parts, pages) => odfToMarkdown("odp", parts, pages), what: "OpenDocument presentation" },
  epub: { parts: EPUB_PARTS, read: epubToMarkdown, what: "EPUB book" },
};

/** The old binary formats, and what they are saved as to be read. */
const LEGACY: Record<string, string> = { doc: "docx", xls: "xlsx", ppt: "pptx" };

export const DOCUMENT_EXTENSIONS = [...Object.keys(READERS), ...Object.keys(LEGACY)];

/**
 * The document *shown* (its path, as the model gave it), read from *bytes*, as Markdown headed with what it is;
 * an "Error: …" line when it cannot be read. *pages* picks sheets or slides.
 */
export function readDocument(extension: string, bytes: Uint8Array, shown: string, pages = ""): string {
  const legacy = LEGACY[extension];
  if (legacy) {
    return `Error: '${shown}' is in the old binary .${extension} format, which cannot be read. Ask the user to save it `
      + `as .${legacy} and read that.`;
  }
  const reader = READERS[extension];
  if (!reader) return `Error: '${shown}' is not a document type this tool reads`;
  try {
    const text = reader.read(unzipText(bytes, reader.parts), pages);
    // A wrong sheet or slide number answers as an error, not as the document's text
    if (text.startsWith("Error:")) return text;
    // Macros in .docm/.xlsm/.pptm are never run: only the text is read
    return `${reader.what} '${shown}':\n\n${text || "(no text)"}`;
  } catch (error) {
    if (error instanceof DocumentError) return `Error: could not read '${shown}': ${error.message}`;
    throw error;
  }
}

/**
 * What an image file holds, by its first bytes rather than its name (#380): the model server takes PNG, JPEG, GIF and
 * WebP — hosted APIs nothing else — and a TIFF or an empty file made the llama-server refuse the whole request
 * ("HTTP 400: Failed to load image"), which failed the message.
 */

export type ImageKind = "png" | "jpeg" | "gif" | "webp" | "bmp" | "ico" | "avif" | "heic" | "tiff" | "svg";

/** The formats every model server takes, as they are sent. */
export const SENDABLE: Partial<Record<ImageKind, string>> = {
  png: "image/png", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
};

const ascii = (bytes: Uint8Array, from: number, to: number): string => String.fromCharCode(...bytes.subarray(from, to));

/** The image format of *bytes*, by their signature; null when they are none this knows. */
export function imageKind(bytes: Uint8Array): ImageKind | null {
  if (bytes.length < 4) return null;
  if (bytes[0] === 0x89 && ascii(bytes, 1, 4) === "PNG") return "png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  if (ascii(bytes, 0, 4) === "GIF8") return "gif";
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP") return "webp";
  if (ascii(bytes, 0, 2) === "BM") return "bmp";
  if (bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 1 && bytes[3] === 0) return "ico";
  if (ascii(bytes, 0, 4) === "II*\u0000" || ascii(bytes, 0, 4) === "MM\u0000*") return "tiff";
  if (ascii(bytes, 4, 8) === "ftyp") {
    const brand = ascii(bytes, 8, 12);
    if (brand === "avif" || brand === "avis") return "avif";
    if (["heic", "heix", "heim", "heis", "hevc", "hevx", "mif1", "msf1"].includes(brand)) return "heic";
  }
  // An SVG is XML text: its start, after a byte-order mark, a declaration or comments, names the svg element
  // (TextDecoder drops a UTF-8 byte-order mark by itself)
  const start = new TextDecoder().decode(bytes.subarray(0, 2048)).trimStart();
  if (start.startsWith("<") && /<svg[\s>]/i.test(start)) return "svg";
  return null;
}

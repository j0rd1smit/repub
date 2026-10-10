const signatures: [string, (bytes: Uint8Array) => boolean][] = [
  ["image/png", (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e],
  ["image/jpeg", (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
  ["image/gif", (b) => b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46],
  [
    "image/webp",
    (b) => ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 12) === "WEBP",
  ],
  [
    "image/avif",
    (b) => ascii(b, 4, 8) === "ftyp" && /^avi[fs]$/.test(ascii(b, 8, 12)),
  ],
  ["image/bmp", (b) => b[0] === 0x42 && b[1] === 0x4d],
];

function ascii(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.subarray(start, end));
}

/**
 * the image type of `bytes`, or `declared` if we can't tell
 *
 * Servers often send images as `application/octet-stream`, or with no type at
 * all, so this trusts the bytes over the label.
 */
export function sniffImageMime(bytes: Uint8Array, declared: string): string {
  for (const [mime, matches] of signatures) {
    if (matches(bytes)) return mime;
  }
  if (!declared.startsWith("image/")) {
    const head = new TextDecoder().decode(bytes.subarray(0, 512));
    if (/^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(head)) {
      return "image/svg+xml";
    }
  }
  return declared;
}

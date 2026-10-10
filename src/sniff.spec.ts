import { expect, test } from "bun:test";
import { sniffImageMime } from "./sniff";

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
const enc = new TextEncoder();

test("sniffImageMime() trusts the bytes over an octet-stream label", () => {
  expect(sniffImageMime(png, "application/octet-stream")).toBe("image/png");
  expect(sniffImageMime(jpeg, "")).toBe("image/jpeg");
  expect(sniffImageMime(enc.encode("GIF89a"), "text/plain")).toBe("image/gif");
});

test("sniffImageMime() recognizes webp and avif containers", () => {
  expect(sniffImageMime(enc.encode("RIFF\0\0\0\0WEBPVP8 "), "")).toBe(
    "image/webp",
  );
  expect(sniffImageMime(enc.encode("\0\0\0\x1cftypavif"), "")).toBe(
    "image/avif",
  );
});

test("sniffImageMime() recognizes unlabeled svgs", () => {
  const svg = enc.encode(
    '<?xml version="1.0"?>\n<!-- logo --><svg xmlns="http://www.w3.org/2000/svg"></svg>',
  );
  expect(sniffImageMime(svg, "text/plain")).toBe("image/svg+xml");
});

test("sniffImageMime() keeps the label when the bytes are unknown", () => {
  expect(sniffImageMime(enc.encode("<html>"), "text/html")).toBe("text/html");
  expect(sniffImageMime(enc.encode("??"), "image/x-icon")).toBe("image/x-icon");
});

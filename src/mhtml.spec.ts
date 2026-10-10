import { expect, test } from "bun:test";
import { toMhtmlBytes } from "./mhtml";
import { type Asset, parse } from "./parse";

test("toMhtmlBytes() round trips through parse()", async () => {
  const html = "<!DOCTYPE html><html><body><p>héllo</p></body></html>";
  const image = new Uint8Array([1, 2, 3, 250]);
  const mhtml = toMhtmlBytes(
    "https://example.com/page",
    html,
    [
      { url: "https://example.com/a.png", mime: "image/png", content: image },
      // duplicates and the page itself are only written once
      { url: "https://example.com/a.png", mime: "image/png", content: image },
      { url: "https://example.com/page", mime: "image/png", content: image },
    ],
    "A\nmultiline   title",
  );
  const parsed = await parse(mhtml);
  expect(parsed.href).toBe("https://example.com/page");
  expect(parsed.title).toBe("A multiline title");
  expect(parsed.content).toBe(html);
  const assets: Asset[] = [];
  for await (const asset of parsed.assets) {
    assets.push(asset);
  }
  expect(assets.map(({ href }) => href)).toEqual(["https://example.com/a.png"]);
  expect(assets[0]?.contentType).toBe("image/png");
  expect([...(assets[0]?.content ?? [])]).toEqual([...image]);
});

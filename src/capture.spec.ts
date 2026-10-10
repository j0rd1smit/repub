import { afterEach, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { decodeDataUrl, resolveImages, snapshot } from "./capture";

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

test("decodeDataUrl() decodes base64 and percent encoded urls", () => {
  expect(decodeDataUrl("data:image/png;base64,iVBORw0KGgo=")).toEqual({
    mime: "image/png",
    content: png,
  });
  const svg = decodeDataUrl("data:image/svg+xml;charset=utf-8,%3Csvg%3E");
  expect(svg?.mime).toBe("image/svg+xml");
  expect(new TextDecoder().decode(svg?.content)).toBe("<svg>");
  expect(decodeDataUrl("data:,hi")?.mime).toBe("application/octet-stream");
  expect(decodeDataUrl("https://example.com")).toBeNull();
});

test("resolveImages() falls back for images the page couldn't fetch", async () => {
  const fetched: string[] = [];
  const assets = await resolveImages(
    [
      ["https://a.com/page.png", "data:image/png;base64,iVBORw0KGgo="],
      ["https://b.com/cross.png", null],
      ["https://b.com/gone.png", null],
      ["https://a.com/not-image", "data:text/html;base64,PGh0bWw+"],
    ],
    (href) => {
      fetched.push(href);
      return Promise.resolve(
        href.endsWith("cross.png")
          ? { content: png, mime: "application/octet-stream" }
          : null,
      );
    },
  );
  expect(fetched).toEqual([
    "https://b.com/cross.png",
    "https://b.com/gone.png",
  ]);
  expect(assets).toEqual([
    { url: "https://a.com/page.png", mime: "image/png", content: png },
    { url: "https://b.com/cross.png", mime: "image/png", content: png },
  ]);
});

const saved = new Map<string, unknown>();
const globals = [
  "document",
  "DOMParser",
  "HTMLImageElement",
  "FileReader",
  "fetch",
];

function installDom(html: string, url: string): JSDOM {
  // browsers parse noscript as text when scripting is on, as it is for pages
  const dom = new JSDOM(html, { url, runScripts: "outside-only" });
  const { window } = dom;
  const fetched = new Set(["https://example.com/post/img/a.png"]);
  const replacements: Record<string, unknown> = {
    document: window.document,
    DOMParser: window.DOMParser,
    HTMLImageElement: window.HTMLImageElement,
    FileReader: window.FileReader,
    fetch: (href: string) =>
      Promise.resolve(
        fetched.has(href)
          ? {
              ok: true,
              blob: () =>
                Promise.resolve(new window.Blob([png], { type: "image/png" })),
            }
          : { ok: false },
      ),
  };
  for (const name of globals) {
    saved.set(name, (globalThis as Record<string, unknown>)[name]);
    (globalThis as Record<string, unknown>)[name] = replacements[name];
  }
  return dom;
}

afterEach(() => {
  for (const [name, value] of saved) {
    (globalThis as Record<string, unknown>)[name] = value;
  }
  saved.clear();
});

test("snapshot() makes image urls absolute and fetches them", async () => {
  installDom(
    `<!doctype html><html><head><title>Page</title>
    <meta property="og:image" content="/cover.png"></head><body>
    <img id="plain" src="img/a.png">
    <img id="native" loading="lazy" src="img/n.png" resource="/wiki/File:n.png">
    <img id="set" srcset="img/s,w_400.png 400w, img/s,w_800.png 800w">
    <img id="lazy" src="data:image/gif;base64,R0lGOD" data-src="img/lazy.png">
    <picture><source srcset="img/pic.webp 1x"><img src="img/pic.png"></picture>
    <noscript><img src="img/ns.png"></noscript>
    <script>var secret = 1;</script>
    </body></html>`,
    "https://example.com/post/",
  );
  const snap = await snapshot(100, 1000, 10_000);
  expect(snap.url).toBe("https://example.com/post/");
  expect(snap.title).toBe("Page");
  expect(snap.html.startsWith("<!DOCTYPE html>")).toBe(true);
  expect(snap.html).not.toContain("secret");

  const doc = new JSDOM(snap.html).window.document;
  expect(doc.getElementById("plain")?.getAttribute("src")).toBe(
    "https://example.com/post/img/a.png",
  );
  // so defuddle doesn't take the resource for the image
  expect(doc.getElementById("native")?.hasAttribute("loading")).toBe(false);
  // commas inside urls don't split candidates
  expect(doc.getElementById("set")?.getAttribute("srcset")).toBe(
    "https://example.com/post/img/s,w_400.png 400w, https://example.com/post/img/s,w_800.png 800w",
  );
  expect(doc.getElementById("lazy")?.getAttribute("data-src")).toBe(
    "https://example.com/post/img/lazy.png",
  );
  expect(doc.querySelector("source")?.getAttribute("srcset")).toBe(
    "https://example.com/post/img/pic.webp 1x",
  );
  expect(doc.querySelector("noscript img")?.getAttribute("src")).toBe(
    "https://example.com/post/img/ns.png",
  );
  expect(
    doc.querySelector(`meta[property="og:image"]`)?.getAttribute("content"),
  ).toBe("https://example.com/cover.png");

  const images = new Map(snap.images);
  expect([...images.keys()].sort()).toEqual(
    [
      "https://example.com/post/img/a.png",
      "https://example.com/post/img/n.png",
      // the widest srcset candidate, since nothing was displayed
      "https://example.com/post/img/s,w_800.png",
      // the lazy source rather than its placeholder
      "https://example.com/post/img/lazy.png",
      "https://example.com/post/img/pic.png",
      "https://example.com/post/img/ns.png",
      "https://example.com/cover.png",
    ].sort(),
  );
  expect(images.get("https://example.com/post/img/a.png")).toStartWith(
    "data:image/png;base64,",
  );
  expect(images.get("https://example.com/cover.png")).toBeNull();
});

test("snapshot() leaves images to the extension once out of time", async () => {
  installDom(
    `<!doctype html><body><img src="/post/img/a.png"></body>`,
    "https://example.com/",
  );
  const snap = await snapshot(100, 1000, 0);
  expect(snap.images).toEqual([["https://example.com/post/img/a.png", null]]);
});

test("snapshot() stops collecting images at the limit", async () => {
  installDom(
    `<!doctype html><body><img src="/1.png"><img src="/2.png"><img src="/3.png"></body>`,
    "https://example.com/",
  );
  const snap = await snapshot(2, 1000, 10_000);
  expect(snap.images.map(([href]) => href).sort()).toEqual([
    "https://example.com/1.png",
    "https://example.com/2.png",
  ]);
});

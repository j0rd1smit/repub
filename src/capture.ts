import { toByteArray } from "base64-js";
import { type MhtmlAsset, toMhtmlBytes } from "./mhtml";
import { sniffImageMime } from "./sniff";

/** a page snapshot taken from inside the tab */
export interface Snapshot {
  url: string;
  title: string;
  contentType: string;
  html: string;
  /** every image the html refers to, with its data url if the page could fetch it */
  images: [string, string | null][];
}

/** what capturing a tab produced */
export type Capture =
  | { type: "html"; mhtml: Uint8Array; title: string }
  | { type: "pdf"; pdf: Uint8Array; title: string };

/**
 * snapshot the page's dom and fetch its images from inside the page
 *
 * This runs in the tab via `scripting.executeScript`, so it must be entirely
 * self contained: it can't reference anything outside of its own body.
 *
 * The html is a serialized clone of the live dom with every image reference
 * made absolute, so it lines up with the urls of the images we fetch. Each img
 * also gets the source the browser actually displayed, since that's the one
 * that's cached and the one the reader saw.
 */
export async function snapshot(
  maxImages: number,
  timeoutMs: number,
  budgetMs: number,
): Promise<Snapshot> {
  // past this, images are left to the extension so the page answers in time
  const deadline = Date.now() + budgetMs;
  const base = document.baseURI;
  const resolve = (value: string | null | undefined): string | null => {
    if (!value?.trim()) return null;
    try {
      const url = new URL(value.trim(), base);
      return url.protocol === "http:" || url.protocol === "https:"
        ? url.href
        : null;
    } catch {
      return null;
    }
  };
  // a srcset tokenizer after the html spec: urls may contain commas, so a
  // candidate only ends at a comma after whitespace or at the url's own end
  const parseSrcset = (srcset: string | null): [string, string][] => {
    const value = srcset ?? "";
    const parsed: [string, string][] = [];
    let pos = 0;
    while (pos < value.length) {
      while (pos < value.length && /[\s,]/.test(value[pos] ?? "")) pos++;
      if (pos >= value.length) break;
      const start = pos;
      while (pos < value.length && !/\s/.test(value[pos] ?? "")) pos++;
      let href = value.slice(start, pos);
      let descriptor = "";
      if (href.endsWith(",")) {
        href = href.replace(/,+$/, "");
      } else {
        const end = value.indexOf(",", pos);
        const stop = end === -1 ? value.length : end;
        descriptor = value.slice(pos, stop).trim();
        pos = stop + 1;
      }
      if (href) parsed.push([href, descriptor]);
    }
    return parsed;
  };
  const rewriteSrcset = (srcset: string): string =>
    parseSrcset(srcset)
      .map(([href, descriptor]) =>
        [resolve(href) ?? href, descriptor].filter((part) => part).join(" "),
      )
      .join(", ");
  // the widest (or densest) candidate, since we're filling a whole screen
  const largest = (srcset: string | null): string | null => {
    let best: string | null = null;
    let bestSize = -1;
    for (const [href, descriptor] of parseSrcset(srcset)) {
      const resolved = resolve(href);
      const size = Number.parseFloat(descriptor) || 1;
      if (resolved && size > bestSize) {
        best = resolved;
        bestSize = size;
      }
    }
    return best;
  };

  const wanted = new Set<string>();
  const want = (href: string | null) => {
    if (href && wanted.size < maxImages) wanted.add(href);
  };

  const srcAttrs = ["src", "data-src", "data-lazy-src", "data-original"];
  const srcsetAttrs = ["srcset", "data-srcset"];
  const absolutize = (elem: Element) => {
    for (const attr of srcAttrs) {
      const href = resolve(elem.getAttribute(attr));
      if (href) elem.setAttribute(attr, href);
    }
    for (const attr of srcsetAttrs) {
      const value = elem.getAttribute(attr);
      if (value) elem.setAttribute(attr, rewriteSrcset(value));
    }
  };

  const root = document.documentElement.cloneNode(true) as HTMLElement;
  const liveImgs = [...document.querySelectorAll("img")];
  const cloneImgs = [...root.querySelectorAll("img")];
  for (const [index, img] of cloneImgs.entries()) {
    const live = liveImgs[index];
    absolutize(img);
    const displayed = resolve(live?.currentSrc);
    if (displayed) {
      img.setAttribute("src", displayed);
      want(displayed);
    } else {
      // never displayed, likely lazy, so get the best source it declares
      want(
        resolve(img.getAttribute("src")) ?? largest(img.getAttribute("srcset")),
      );
    }
    for (const attr of ["data-src", "data-lazy-src", "data-original"]) {
      want(resolve(img.getAttribute(attr)));
    }
    // natively lazy images already have their real src, but defuddle treats
    // them like script lazy loaders and swaps in any url-like attribute, such
    // as the file page wikipedia puts in `resource`
    if (resolve(img.getAttribute("src"))) {
      img.removeAttribute("loading");
    }
    want(largest(img.getAttribute("data-srcset")));
  }
  for (const source of root.querySelectorAll("source")) {
    absolutize(source);
  }
  // noscript holds the real images of many lazy loaders, but it's text here and
  // will be parsed as html later, so fix it up the same way
  for (const noscript of root.querySelectorAll("noscript")) {
    const inner = new DOMParser().parseFromString(
      noscript.textContent ?? "",
      "text/html",
    );
    const imgs = inner.querySelectorAll("img, source");
    if (imgs.length) {
      for (const img of imgs) {
        absolutize(img);
        if (img instanceof HTMLImageElement) {
          want(
            resolve(img.getAttribute("src")) ??
              largest(img.getAttribute("srcset")),
          );
        }
      }
      noscript.textContent = inner.body.innerHTML;
    }
  }
  for (const meta of root.querySelectorAll(
    `meta[property="og:image"], meta[property="og:image:url"], meta[property="twitter:image"], meta[name="twitter:image"]`,
  )) {
    const href = resolve(meta.getAttribute("content"));
    if (href) {
      meta.setAttribute("content", href);
      want(href);
    }
  }
  // scripts are inert later, so they're just weight
  for (const script of root.querySelectorAll("script")) {
    script.remove();
  }

  const toDataUrl = (blob: Blob): Promise<string> =>
    new Promise((res, rej) => {
      const reader = new FileReader();
      reader.onload = () => {
        res(reader.result as string);
      };
      reader.onerror = () => {
        rej(reader.error ?? new Error("couldn't read image"));
      };
      reader.readAsDataURL(blob);
    });
  const load = async (href: string): Promise<string | null> => {
    const remaining = Math.min(timeoutMs, deadline - Date.now());
    if (remaining <= 0) return null;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, remaining);
    try {
      const resp = await fetch(href, {
        cache: "force-cache",
        signal: controller.signal,
      });
      return resp.ok ? await toDataUrl(await resp.blob()) : null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  };

  // fetch a few at a time so a gallery doesn't swamp the page
  const queue = [...wanted];
  const images: [string, string | null][] = [];
  const workers = Array.from({ length: 6 }, async () => {
    for (let href = queue.shift(); href; href = queue.shift()) {
      images.push([href, await load(href)]);
    }
  });
  await Promise.all(workers);

  const doctype = document.doctype ? "<!DOCTYPE html>" : "";
  return {
    url: document.URL,
    title: document.title,
    contentType: document.contentType,
    html: `${doctype}${root.outerHTML}`,
    images,
  };
}

const MAX_IMAGES = 500;
const IMAGE_TIMEOUT_MS = 30_000;
// how long the page spends fetching images before handing the rest over
const PAGE_BUDGET_MS = 60_000;
// a snapshot that takes much longer than its budget isn't coming back
const SNAPSHOT_TIMEOUT_MS = PAGE_BUDGET_MS + 30_000;

/** fetch a resource from the extension, which has broader host access */
async function fetchBytes(
  href: string,
): Promise<{ content: Uint8Array; mime: string } | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, IMAGE_TIMEOUT_MS);
  try {
    const resp = await fetch(href, {
      cache: "force-cache",
      signal: controller.signal,
    });
    if (!resp.ok) return null;
    const blob = await resp.blob();
    return {
      content: new Uint8Array(await blob.arrayBuffer()),
      mime: blob.type,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** decode a `data:` url into its mime type and bytes */
export function decodeDataUrl(
  url: string,
): { mime: string; content: Uint8Array } | null {
  const match = /^data:([^,]*?)(;base64)?,(.*)$/s.exec(url);
  if (!match) return null;
  const [, meta = "", base64, data = ""] = match;
  const mime = meta.split(";")[0]?.trim() || "application/octet-stream";
  const content = base64
    ? toByteArray(data)
    : new TextEncoder().encode(decodeURIComponent(data));
  return { mime, content };
}

/**
 * turn the images a snapshot found into mhtml assets
 *
 * Images the page couldn't fetch are retried from the extension, whose host
 * permissions get around CORS. Anything that still doesn't look like an image
 * is dropped.
 */
export async function resolveImages(
  images: readonly (readonly [string, string | null])[],
  fallback: typeof fetchBytes = fetchBytes,
): Promise<MhtmlAsset[]> {
  const loaded = await Promise.all(
    images.map(async ([url, dataUrl]) => {
      const decoded =
        (dataUrl === null ? null : decodeDataUrl(dataUrl)) ??
        (await fallback(url));
      if (!decoded) {
        console.warn(`couldn't fetch image ${url}`);
        return null;
      }
      const mime = sniffImageMime(decoded.content, decoded.mime);
      return mime.startsWith("image/")
        ? { url, mime, content: decoded.content }
        : null;
    }),
  );
  return loaded.filter((asset) => asset !== null);
}

function looksLikePdf(content: Uint8Array): boolean {
  // %PDF-
  return (
    content[0] === 0x25 &&
    content[1] === 0x50 &&
    content[2] === 0x44 &&
    content[3] === 0x46
  );
}

/** the name a pdf at `url` should go by when its tab has no better title */
function pdfTitle(tabTitle: string | undefined, url: string): string {
  if (tabTitle?.trim() && tabTitle !== url) {
    return tabTitle.replace(/\.pdf$/i, "").trim();
  }
  try {
    const name = decodeURIComponent(
      new URL(url).pathname.split("/").at(-1) ?? "",
    );
    return name.replace(/\.pdf$/i, "") || "missing title";
  } catch {
    return "missing title";
  }
}

/** capture a pdf tab by fetching the document it's showing */
async function capturePdf(tab: browser.tabs.Tab): Promise<Capture | null> {
  const url = tab.url;
  if (!url || !/^(https?|file):/.test(url)) return null;
  const fetched = await fetchBytes(url);
  if (
    !fetched ||
    !(fetched.mime === "application/pdf" || looksLikePdf(fetched.content))
  ) {
    return null;
  }
  return { type: "pdf", pdf: fetched.content, title: pdfTitle(tab.title, url) };
}

/**
 * capture the current page
 *
 * Html pages are snapshot from inside the tab and packaged as mhtml so they go
 * through the same rendering as uploaded mhtml files. Firefox shows pdfs in its
 * own viewer, which extensions can't script, so those are fetched directly.
 */
/**
 * run the snapshot in the tab
 *
 * A tab that navigates away mid snapshot never answers, so this gives up as
 * soon as the tab starts loading something else, or after a generous timeout.
 */
async function takeSnapshot(
  tabId: number,
): Promise<browser.scripting.InjectionResult[]> {
  let abandon = (_: Error) => {};
  const abandoned = new Promise<never>((_, reject) => {
    abandon = reject;
  });
  const onUpdated = (
    updated: number,
    { status }: browser.tabs._OnUpdatedChangeInfo,
  ) => {
    if (updated === tabId && status === "loading") {
      abandon(new Error("the page navigated away while it was captured"));
    }
  };
  browser.tabs.onUpdated.addListener(onUpdated, { properties: ["status"] });
  const timer = setTimeout(() => {
    abandon(new Error("the page took too long to capture"));
  }, SNAPSHOT_TIMEOUT_MS);
  try {
    return await Promise.race([
      browser.scripting.executeScript({
        target: { tabId },
        func: snapshot,
        args: [MAX_IMAGES, IMAGE_TIMEOUT_MS, PAGE_BUDGET_MS],
      }),
      abandoned,
    ]);
  } finally {
    clearTimeout(timer);
    browser.tabs.onUpdated.removeListener(onUpdated);
  }
}

export async function pageCapture(tabId: number): Promise<Capture> {
  const tab = await browser.tabs.get(tabId);
  let snap: Snapshot | undefined;
  let failure: unknown;
  try {
    const [result] = await takeSnapshot(tabId);
    if (result?.error !== undefined) {
      failure = result.error;
    } else {
      snap = result?.result as Snapshot | undefined;
    }
  } catch (ex) {
    failure = ex;
  }

  if (snap === undefined || snap.contentType === "application/pdf") {
    const pdf = await capturePdf(tab);
    if (pdf) return pdf;
  }
  if (snap === undefined) {
    const message =
      failure instanceof Error ? failure.message : String(failure);
    throw new Error(`couldn't capture this page: ${message}`);
  }

  const assets = await resolveImages(snap.images);
  const mhtml = toMhtmlBytes(snap.url, snap.html, assets, snap.title);
  return { type: "html", mhtml, title: snap.title };
}

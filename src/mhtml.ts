import { fromByteArray } from "base64-js";
import { v4 as uuidv4 } from "uuid";

/** a resource to bundle alongside the page */
export interface MhtmlAsset {
  readonly url: string;
  readonly mime: string;
  readonly content: Uint8Array;
}

async function loadImage(url: string): Promise<MhtmlAsset | null> {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      console.log(`Failed to load image from ${url}: ${response.statusText}`);
      return null;
    }
    const blob = await response.blob();
    const arrayBuffer = await blob.arrayBuffer();
    return { url, mime: blob.type, content: new Uint8Array(arrayBuffer) };
  } catch (ex: unknown) {
    console.error("failed to load resource", ex);
    return null;
  }
}

function encodePart(
  content: Uint8Array,
  mime: string,
  url: string,
  boundary: string,
): string[] {
  const encoded = fromByteArray(content);
  const lines = [
    `------MultipartBoundary--${boundary}----`,
    `Content-Type: ${mime}`,
    "Content-Transfer-Encoding: base64",
    `Content-Location: ${url}`,
    "",
  ];
  const chunkSize = 76;
  for (let i = 0; i < encoded.length; i += chunkSize) {
    lines.push(encoded.slice(i, i + chunkSize));
  }
  return lines;
}

/** bundle an html page and its already loaded assets as mhtml */
export function toMhtmlBytes(
  fileName: string,
  html: string,
  assets: readonly MhtmlAsset[],
  subject: string = fileName,
): Uint8Array {
  const boundary = uuidv4();

  const lines = [
    "From: <Created by rePub>",
    `Snapshot-Content-Location: ${fileName}`,
    // headers are a single line
    `Subject: ${subject.replace(/\s+/g, " ")}`,
    `Date: ${new Date().toDateString()}`,
    "MIME-Version: 1.0",
    "Content-Type: multipart/related;",
    '  type="text/html";',
    `  boundary="----MultipartBoundary--${boundary}----"`,
    "",
    "",
  ];
  const enc = new TextEncoder();
  lines.push(...encodePart(enc.encode(html), "text/html", fileName, boundary));

  const included = new Set<string>([fileName]);
  for (const { url, mime, content } of assets) {
    if (!included.has(url)) {
      included.add(url);
      lines.push(...encodePart(content, mime, url, boundary));
    }
  }

  // footer for completion
  lines.push(`------MultipartBoundary--${boundary}------`);
  return enc.encode(lines.join("\r\n"));
}

/** bundle an html page as mhtml, fetching the images it links to */
export async function toMhtml(
  fileName: string,
  html: string,
  images: string[],
): Promise<Uint8Array> {
  const loaded = await Promise.all(images.map(loadImage));
  return toMhtmlBytes(
    fileName,
    html,
    loaded.filter((d) => d !== null),
  );
}

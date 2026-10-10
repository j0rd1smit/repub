import { brighten } from "./image";
import { generate } from "./lib";
import type { EpubOptions } from "./options";

/**
 * render an mhtml page as an epub
 *
 * Firefox's background page, like the options page, has a full dom, so this
 * runs wherever it's called rather than off in a separate document.
 */
export async function render(
  mhtml: Uint8Array | ArrayBuffer,
  opts: EpubOptions,
  title?: string,
  author?: string,
  summarize: boolean = true,
): Promise<{ epub: Uint8Array; title?: string }> {
  const bright = (buffer: Uint8Array, mime: string) =>
    brighten(buffer, mime, opts.imageBrightness, false, opts.imageShrink);
  const { epub, title: parsedTitle } = await generate(
    mhtml instanceof Uint8Array ? mhtml : new Uint8Array(mhtml),
    bright,
    opts,
    summarize,
    title,
    author,
  );
  return { epub, title: parsedTitle };
}

import type { PutOptions } from "rmapi-js";
import { pageCapture } from "./capture";
import type { TitleRequest } from "./messages";
import { getOptions, type Options } from "./options";
import { analyzePdfMargins } from "./pdf-trim";
import { render } from "./render";
import { getTab } from "./status";
import { uploadEpub, uploadPdf } from "./upload";
import { safeFilename, sleep } from "./utils";

/**
 * keep the event page alive while `work` runs
 *
 * Firefox suspends an idle background page after about thirty seconds, and a
 * long fetch to reMarkable doesn't count as activity, while an extension api
 * call does.
 */
async function keepAlive<T>(work: () => Promise<T>): Promise<T> {
  const timer = setInterval(() => {
    browser.runtime.getPlatformInfo().catch(() => {
      // only here to reset the idle timer
    });
  }, 20_000);
  try {
    return await work();
  } finally {
    clearInterval(timer);
  }
}

/** save `content` to the downloads folder */
async function download(
  content: Uint8Array,
  filename: string,
  type: string,
  saveAs: boolean,
): Promise<void> {
  const url = URL.createObjectURL(new Blob([content as BlobPart], { type }));
  const revoke = () => {
    URL.revokeObjectURL(url);
  };
  let id: number;
  try {
    id = await browser.downloads.download({ filename, url, saveAs });
  } catch (ex) {
    revoke();
    throw ex;
  }
  // the blob has to outlive the download, but not much longer
  const listener = ({
    id: changed,
    state,
  }: browser.downloads._OnChangedDownloadDelta) => {
    if (changed === id && state?.current && state.current !== "in_progress") {
      browser.downloads.onChanged.removeListener(listener);
      revoke();
    }
  };
  browser.downloads.onChanged.addListener(listener);
}

async function sendPdf(
  pdf: Uint8Array,
  title: string,
  { outputStyle, downloadAsk, deviceToken, ...opts }: Options,
): Promise<void> {
  if (outputStyle === "download") {
    await download(
      pdf,
      `${safeFilename(title)}.pdf`,
      "application/pdf",
      downloadAsk,
    );
  } else {
    let zoom: Partial<PutOptions> = {};
    if (opts.trimPdf) {
      try {
        zoom = await analyzePdfMargins(pdf, opts.device);
      } catch (ex) {
        console.error("failed to analyze pdf margins", ex);
      }
    }
    await uploadPdf(pdf, title, deviceToken, opts, zoom);
  }
}

function requireAuth({ outputStyle, deviceToken }: Options): void {
  if (outputStyle !== "download" && !deviceToken) {
    browser.runtime.openOptionsPage().catch((ex: unknown) => {
      const message = ex instanceof Error ? ex.message : "unknown error";
      console.error(`couldn't open option page: ${message}`);
    });
    throw new Error("must be authenticated to upload documents to reMarkable");
  }
}

/**
 * create and upload epub
 */
async function rePub(
  tabId: number,
  initTitle?: string,
  initAuthor?: string,
): Promise<void> {
  // get active state for clearing badge with navigation
  const tab = getTab(tabId);
  try {
    await tab.init();

    const options = await getOptions();
    requireAuth(options);
    const { deviceToken, outputStyle, downloadAsk, ...opts } = options;
    await tab.progress(25);

    const capture = await pageCapture(tabId);
    await tab.progress(50);

    if (capture.type === "pdf") {
      await tab.progress(75);
      await sendPdf(capture.pdf, initTitle ?? capture.title, options);
    } else {
      const { epub, title = capture.title || "missing title" } = await render(
        capture.mhtml,
        opts,
        initTitle,
        initAuthor,
      );
      await tab.progress(75);

      if (outputStyle === "download") {
        await download(
          epub,
          `${safeFilename(title)}.epub`,
          "application/epub+zip",
          downloadAsk,
        );
      } else {
        await uploadEpub(epub, title, deviceToken, opts);
      }
    }

    await tab.complete(outputStyle === "download" ? "done" : "sent");
  } catch (ex) {
    const msg = ex instanceof Error ? ex.toString() : "unknown error";
    await Promise.all([
      browser.notifications
        .create({
          type: "basic",
          iconUrl: "images/repub_128.png",
          title: "Conversion to epub failed",
          message: msg,
        })
        .catch(() => {
          // the badge still shows the error
        }),
      tab.error(),
    ]);
    throw ex;
  } finally {
    await tab.done();
    // NOTE leave progress around to see
    await sleep(500);
    await tab.drop();
  }
}

/**
 * show the title prompt instead of capturing straight away, if asked to
 *
 * With a popup set, clicking the button opens it rather than firing `onClicked`,
 * so this is kept in step with the option.
 */
async function syncPopup(promptTitle?: boolean): Promise<void> {
  const prompt = promptTitle ?? (await getOptions()).promptTitle;
  await browser.action.setPopup({ popup: prompt ? "popup.html" : "" });
}

// watch for clicks
browser.action.onClicked.addListener((tab) => {
  if (tab.id === undefined) return;
  const tabId = tab.id;
  keepAlive(async () => {
    const { promptTitle } = await getOptions();
    if (promptTitle) {
      // the popup wasn't set yet, so set it and try to show it now
      await syncPopup(true);
      await browser.action.openPopup().catch(() => {
        // the next click will open it
      });
    } else {
      await rePub(tabId);
    }
  }).catch((ex: unknown) => {
    console.error(ex);
  });
});

// watch for messages from popup
browser.runtime.onMessage.addListener((message: unknown) => {
  const { tabId, title, author } = message as TitleRequest;
  keepAlive(() => rePub(tabId, title, author)).catch((ex: unknown) => {
    console.error(ex);
  });
  return Promise.resolve();
});

browser.storage.local.onChanged.addListener((changes) => {
  // biome-ignore lint/complexity/useLiteralKeys: changes is an index signature
  const change = changes["promptTitle"];
  if (change) {
    syncPopup(!!change.newValue).catch((ex: unknown) => {
      console.error("couldn't set popup", ex);
    });
  }
});

syncPopup().catch((ex: unknown) => {
  console.error("couldn't set popup", ex);
});

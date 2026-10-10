// store active state for navigation
const activeTabs = new Map<number, Tab>();

/**
 * note tabs that navigate away mid conversion
 *
 * Firefox clears a tab's badge when it navigates, but the rest of a conversion
 * would set it again on the new page, so the tab clears it once it's done. This
 * only listens while converting, so navigation doesn't wake the background.
 */
function onUpdated(
  tabId: number,
  { status }: browser.tabs._OnUpdatedChangeInfo,
): void {
  const active = activeTabs.get(tabId);
  if (status === "loading" && active?.precount) {
    active.nav = true;
  }
}

class Tab {
  #tabId: number;
  nav: boolean = false;
  precount: number = 1;
  count: number = 1;

  constructor(tabId: number) {
    this.#tabId = tabId;
  }

  async init(): Promise<void> {
    try {
      await browser.action.setBadgeBackgroundColor({
        tabId: this.#tabId,
        color: "#000000",
      });
      await browser.action.setBadgeText({
        tabId: this.#tabId,
        text: "0%",
      });
    } catch {
      // ignore
    }
  }

  async progress(perc: number): Promise<void> {
    try {
      await browser.action.setBadgeText({
        tabId: this.#tabId,
        text: `${perc.toFixed()}%`,
      });
    } catch {
      // ignore
    }
  }

  async complete(message: string): Promise<void> {
    try {
      await browser.action.setBadgeText({
        tabId: this.#tabId,
        text: message,
      });
    } catch {
      // ignore
    }
  }

  async error(): Promise<void> {
    try {
      await Promise.all([
        browser.action.setBadgeText({
          tabId: this.#tabId,
          text: "err",
        }),
        browser.action.setBadgeBackgroundColor({
          tabId: this.#tabId,
          color: "#d62626",
        }),
      ]);
    } catch {
      // ignore
    }
  }

  async done(): Promise<void> {
    this.precount -= 1;
    if (!this.precount && this.nav) {
      try {
        await browser.action.setBadgeText({
          tabId: this.#tabId,
          text: "",
        });
      } catch {
        // ignore
      }
    }
  }

  async drop(): Promise<void> {
    this.count -= 1;
    if (!this.count) {
      activeTabs.delete(this.#tabId);
      if (!activeTabs.size) {
        browser.tabs.onUpdated.removeListener(onUpdated);
      }
      if (this.nav) {
        try {
          await browser.action.setBadgeText({
            tabId: this.#tabId,
            text: "",
          });
        } catch {
          // ignore
        }
      }
    }
  }
}

export function getTab(tabId: number): Tab {
  const tab = activeTabs.get(tabId);
  if (tab) {
    tab.nav = false;
    tab.count += 1;
    tab.precount += 1;
    return tab;
  } else {
    const newTab = new Tab(tabId);
    if (!activeTabs.size) {
      browser.tabs.onUpdated.addListener(onUpdated, { properties: ["status"] });
    }
    activeTabs.set(tabId, newTab);
    return newTab;
  }
}

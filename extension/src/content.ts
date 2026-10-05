/// <reference types="@taisan11/vite-plugin-webext/types" />

type PageMetadataMessage = {
  type: "PAGE_METADATA";
  url: string;
  title: string;
  favicon: string;
  navigation: boolean;
};

// Observe only metadata-bearing elements. Watching the whole head subtree can
// be noisy on pages that frequently update unrelated meta/style elements.
let lastSent: Omit<PageMetadataMessage, "type"> | undefined;
let pendingNavigation = false;
let timer: ReturnType<typeof setTimeout> | undefined;

function currentFavicon(): string {
  const link = document.querySelector<HTMLLinkElement>(
    'link[rel~="icon" i], link[rel="shortcut icon" i]',
  );
  return link?.href ?? "";
}

function sendMetadata(): void {
  timer = undefined;
  const metadata: Omit<PageMetadataMessage, "type"> = {
    url: location.href,
    title: document.title.trim(),
    favicon: currentFavicon(),
    navigation: pendingNavigation,
  };
  pendingNavigation = false;

  const unchanged =
    lastSent?.url === metadata.url &&
    lastSent?.title === metadata.title &&
    lastSent?.favicon === metadata.favicon &&
    !metadata.navigation;
  if (unchanged) return;
  lastSent = metadata;
  void browser.runtime
    .sendMessage({ type: "PAGE_METADATA", ...metadata } satisfies PageMetadataMessage)
    .catch(() => {
      // The background service worker may be restarting or the page may be
      // closing. Metadata will be sent again on the next meaningful change.
    });
}

function scheduleMetadata(navigation = false): void {
  if (navigation) pendingNavigation = true;
  if (timer) clearTimeout(timer);
  // Route transitions often update the title a tick after pushState. A short
  // debounce lets us send the final title while keeping SPA chatter low.
  timer = setTimeout(sendMetadata, navigation ? 100 : 40);
}

function onHistoryChange(): void {
  if (location.href !== lastSent?.url) scheduleMetadata(true);
  else scheduleMetadata();
}

for (const method of ["pushState", "replaceState"] as const) {
  const original = history[method];
  history[method] = function (...args) {
    const result = original.apply(this, args);
    onHistoryChange();
    return result;
  };
}

window.addEventListener("popstate", onHistoryChange, { passive: true });
window.addEventListener("hashchange", onHistoryChange, { passive: true });

function isFaviconLink(node: Element): node is HTMLLinkElement {
  if (node.tagName !== "LINK") return false;
  const rel = node.getAttribute("rel")?.toLowerCase().split(/\s+/) ?? [];
  return rel.includes("icon") || (rel.includes("shortcut") && rel.includes("icon"));
}

let observedHead: HTMLHeadElement | null = null;
const metadataObserver = new MutationObserver(() => scheduleMetadata());
const headObserver = new MutationObserver((records) => {
  // Direct head children are enough to discover titles and link elements.
  const changed = records.flatMap((record) => [...record.addedNodes, ...record.removedNodes]);
  if (changed.some((node) => node instanceof Element && (node.tagName === "TITLE" || node.tagName === "LINK"))) {
    observeMetadataElements();
    if (changed.some((node) => node instanceof Element && (node.tagName === "TITLE" || isFaviconLink(node)))) {
      scheduleMetadata();
    }
  }
});
const linkObserver = new MutationObserver((records) => {
  if (
    records.some(
      (record) =>
        (record.attributeName === "href" && isFaviconLink(record.target as Element)) ||
        (record.attributeName === "rel" &&
          (isFaviconLink(record.target as Element) ||
            /(?:^|\s)(?:shortcut\s+)?icon(?:\s|$)/i.test(record.oldValue ?? ""))),
    )
  ) {
    scheduleMetadata();
  }
});

function observeMetadataElements(): void {
  const head = document.head;
  if (!head) return;
  if (observedHead !== head) {
    headObserver.disconnect();
    observedHead = head;
    headObserver.observe(head, { childList: true });
  }

  // Rebinding is cheap and only occurs when relevant direct children change.
  metadataObserver.disconnect();
  linkObserver.disconnect();
  const title = head.querySelector("title");
  if (title) {
    metadataObserver.observe(title, {
      subtree: true,
      childList: true,
      characterData: true,
    });
  }
  for (const link of head.querySelectorAll("link")) {
    linkObserver.observe(link, {
      attributes: true,
      attributeFilter: ["href", "rel"],
      attributeOldValue: true,
    });
  }
}

if (document.head) {
  observeMetadataElements();
} else {
  // document_start can run before <head> exists. Watch only until it appears,
  // then switch to the focused observers above.
  const rootObserver = new MutationObserver(() => {
    if (!document.head) return;
    rootObserver.disconnect();
    observeMetadataElements();
  });
  rootObserver.observe(document, { childList: true });
}

// Start immediately so titles from the initial render are captured; the
// observer handles frameworks that populate document.title asynchronously.
scheduleMetadata();

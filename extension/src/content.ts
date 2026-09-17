/// <reference types="@taisan11/vite-plugin-webext/types" />

type PageMetadataMessage = {
  type: "PAGE_METADATA";
  url: string;
  title: string;
  favicon: string;
  navigation: boolean;
};

// Keep the observer deliberately small: one title/head observer and one
// debounced message per meaningful change. This covers frameworks that update
// document.title asynchronously without polling the DOM.
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

const observeOptions: MutationObserverInit = {
  subtree: true,
  childList: true,
  characterData: true,
};
const titleObserver = new MutationObserver(() => scheduleMetadata());
if (document.head) {
  titleObserver.observe(document.head, observeOptions);
} else {
  // document_start can run before <head> exists. Watch only document-level
  // insertion until it does, then switch to the much smaller head subtree.
  const rootObserver = new MutationObserver(() => {
    if (!document.head) return;
    rootObserver.disconnect();
    titleObserver.observe(document.head, observeOptions);
  });
  rootObserver.observe(document, { childList: true });
}

// Start immediately so titles from the initial render are captured; the
// observer handles frameworks that populate document.title asynchronously.
scheduleMetadata();

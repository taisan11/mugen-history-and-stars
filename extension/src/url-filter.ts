const GOOGLE_URL_FILTER_KEY = "googleUrlFilterEnabled";

// Keep parameters that affect the search itself; drop Google navigation and
// analytics parameters such as source, client, and session identifiers.
const GOOGLE_SEARCH_PARAMS = new Set([
  "q",
  "tbm",
  "start",
  "num",
  "udm",
  "tbs",
  "hl",
  "lr",
  "cr",
  "gl",
  "safe",
  "filter",
  "nfpr",
  "as_q",
  "as_epq",
  "as_oq",
  "as_sitesearch",
  "as_filetype",
  "as_rights",
  "as_occt",
  "as_dt",
]);

let enabledPromise: Promise<boolean> | undefined;

export function getGoogleUrlFilterEnabled(): Promise<boolean> {
  if (!enabledPromise) {
    enabledPromise = browser.storage.local
      .get(GOOGLE_URL_FILTER_KEY)
      .then((data) => (data as Record<string, unknown>)[GOOGLE_URL_FILTER_KEY] !== false)
      .catch((error: unknown) => {
        enabledPromise = undefined;
        throw error;
      });
  }
  return enabledPromise;
}

export function filterGoogleUrl(value: string, enabled: boolean): string {
  if (!enabled) return value;
  try {
    const url = new URL(value);
    if (url.hostname.toLowerCase() !== "www.google.com") return value;

    const params = [...url.searchParams.entries()]
      .filter(([key]) => GOOGLE_SEARCH_PARAMS.has(key))
      .sort(([keyA, valueA], [keyB, valueB]) =>
        keyA.localeCompare(keyB) || valueA.localeCompare(valueB),
      );
    url.search = "";
    for (const [key, paramValue] of params) url.searchParams.append(key, paramValue);
    return url.toString();
  } catch {
    return value;
  }
}

browser.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "local" && GOOGLE_URL_FILTER_KEY in changes) enabledPromise = undefined;
});

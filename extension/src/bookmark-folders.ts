// import { extensionApi } from "./extension-api.ts";

const FOLDERS_KEY = "bookmarkFolders";

export async function getBookmarkFolders(): Promise<string[]> {
  const data = (await browser.storage.local.get(FOLDERS_KEY)) as { bookmarkFolders?: unknown };
  if (!Array.isArray(data.bookmarkFolders)) return [];
  return data.bookmarkFolders.filter(
    (folder): folder is string => typeof folder === "string" && folder.length > 0,
  );
}

export async function saveBookmarkFolders(folders: string[]): Promise<void> {
  await browser.storage.local.set({
    [FOLDERS_KEY]: [...new Set(folders)].sort((a, b) => a.localeCompare(b, "ja")),
  });
}

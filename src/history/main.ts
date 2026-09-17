/// <reference types="@taisan11/vite-plugin-webext/types" />
import "./style.css";
import {
  getVisitsPage,
  searchVisitsPage,
  deleteVisit,
  clearAllVisits,
  type HistoryEntry,
} from "../db.ts";
import { requestSync } from "../sync.ts";
// import { extensionApi } from "../extension-api.ts";

const DEFAULT_PER_PAGE = 200;
const MAX_PER_PAGE = 2_000;

const app = document.querySelector<HTMLDivElement>("#app")!;

let currentPage = 0;
let perPage = DEFAULT_PER_PAGE;
let totalCount = 0;
let searchQuery = "";
let currentItems: HistoryEntry[] = [];

type HistoryRow =
  | { kind: "date"; key: string; date: string; count: number }
  | { kind: "visit"; key: string; entry: HistoryEntry };

function formatDate(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const diff = now.getTime() - d.getTime();
  const mins = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);

  if (mins < 1) return "たった今";
  if (mins < 60) return `${mins}分前`;
  if (hours < 24) return `${hours}時間前`;
  if (days < 7) return `${days}日前`;

  return d.toLocaleDateString("ja-JP", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function groupByDate(entries: HistoryEntry[]): Map<string, HistoryEntry[]> {
  const groups = new Map<string, HistoryEntry[]>();
  for (const entry of entries) {
    const d = new Date(entry.visitedAt);
    const key = d.toLocaleDateString("ja-JP", {
      year: "numeric",
      month: "long",
      day: "numeric",
      weekday: "long",
    });
    const arr = groups.get(key) ?? [];
    arr.push(entry);
    groups.set(key, arr);
  }
  return groups;
}

function getDomain(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function escapeHtml(s: string): string {
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}

function buildHistoryRows(entries: HistoryEntry[]): HistoryRow[] {
  const rows: HistoryRow[] = [];
  for (const [date, dateEntries] of groupByDate(entries)) {
    rows.push({ kind: "date", key: `date:${date}`, date, count: dateEntries.length });
    for (const entry of dateEntries) {
      rows.push({
        kind: "visit",
        key: `visit:${entry.id ?? `${entry.url}:${entry.visitedAt}`}`,
        entry,
      });
    }
  }
  return rows;
}

function renderHistoryRow(row: HistoryRow): string {
  if (row.kind === "date") {
    return `
      <div class="date-group">
        <div class="date-header">${escapeHtml(row.date)} (${row.count})</div>
      </div>
    `;
  }

  const entry = row.entry;
  return `
    <div class="visit-item" data-id="${entry.id}">
      <div class="visit-info">
        <a class="visit-title" href="${escapeHtml(entry.url)}" target="_blank">${escapeHtml(entry.title || getDomain(entry.url))}</a>
        <div class="visit-meta">
          <span class="visit-domain">${escapeHtml(getDomain(entry.url))}</span>
          <span class="visit-time">${formatDate(entry.visitedAt)}</span>
        </div>
      </div>
      <button class="delete-btn" data-id="${entry.id}" title="削除">×</button>
    </div>
  `;
}

function render() {
  const totalPages = Math.ceil(totalCount / perPage);
  const rows = buildHistoryRows(currentItems);

  let paginationHtml = "";
  if (totalPages > 1) {
    const pages: string[] = [];
    pages.push(
      `<button class="page-btn" data-page="${currentPage - 1}" ${currentPage === 0 ? "disabled" : ""}>←</button>`,
    );
    for (let i = 0; i < totalPages; i++) {
      if (i === 0 || i === totalPages - 1 || Math.abs(i - currentPage) <= 2) {
        pages.push(
          `<button class="page-btn ${i === currentPage ? "active" : ""}" data-page="${i}">${i + 1}</button>`,
        );
      } else if (Math.abs(i - currentPage) === 3) {
        pages.push(`<span class="page-ellipsis">...</span>`);
      }
    }
    pages.push(
      `<button class="page-btn" data-page="${currentPage + 1}" ${currentPage >= totalPages - 1 ? "disabled" : ""}>→</button>`,
    );
    paginationHtml = `<div class="pagination">${pages.join("")}</div>`;
  }

  app.innerHTML = `
    <header>
      <h1>無限の歴史と星々</h1>
      <div class="stats">${totalCount.toLocaleString()} 件の履歴</div>
      <a class="nav-link" href="/bookmarks/index.html">ブックマーク</a>
    </header>
    <div class="toolbar">
      <input type="search" id="search" placeholder="URL・タイトルで検索..." value="${escapeHtml(searchQuery)}" autofocus />
      <button id="clear-all" class="danger">全削除</button>
    </div>
    <div class="results-count">${totalCount === 0 ? "0" : `${currentPage * perPage + 1}〜${Math.min((currentPage + 1) * perPage, totalCount)}`} / ${totalCount.toLocaleString()} 件</div>
    <div id="history-list"></div>
    ${paginationHtml}
  `;

  document.querySelector<HTMLInputElement>("#search")!.addEventListener("input", onSearch);
  document.querySelector<HTMLButtonElement>("#clear-all")!.addEventListener("click", onClearAll);
  const list = document.querySelector<HTMLDivElement>("#history-list")!;
  if (currentItems.length === 0) {
    list.innerHTML = `<div class="empty">${searchQuery ? "検索結果がありません" : "履歴がまだありません"}</div>`;
  } else {
    list.addEventListener("click", onDelete);
    list.innerHTML = rows.map(renderHistoryRow).join("");
  }
  document.querySelectorAll<HTMLButtonElement>(".page-btn").forEach((btn) => {
    btn.addEventListener("click", onPageChange);
  });
}

let searchTimer: ReturnType<typeof setTimeout>;
function onSearch(e: Event) {
  searchQuery = (e.target as HTMLInputElement).value;
  currentPage = 0;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(loadPage, 200);
}

function onPageChange(e: Event) {
  const btn = e.currentTarget as HTMLButtonElement;
  const page = Number(btn.dataset.page);
  if (isNaN(page)) return;
  currentPage = page;
  loadPage();
}

async function onDelete(e: Event) {
  const target = e.target as HTMLElement;
  const btn = target.closest<HTMLButtonElement>(".delete-btn");
  if (!btn) return;
  const id = Number(btn.dataset.id);
  if (!Number.isSafeInteger(id)) return;
  await deleteVisit(id);
  void requestSync().catch((error: unknown) => console.error("Sync failed", error));
  loadPage();
}

async function onClearAll() {
  if (!confirm("本当にすべての履歴を削除しますか？")) return;
  await clearAllVisits();
  void requestSync().catch((error: unknown) => console.error("Sync failed", error));
  currentPage = 0;
  loadPage();
}

async function loadPage() {
  let result: { items: HistoryEntry[]; total: number };
  if (searchQuery) {
    result = await searchVisitsPage(searchQuery, currentPage, perPage);
  } else {
    result = await getVisitsPage(currentPage, perPage);
  }
  currentItems = result.items;
  totalCount = result.total;
  render();
}

async function getPerPage(): Promise<number> {
  const data = (await browser.storage.local.get("perPage")) as { perPage?: number };
  const value = Number.isFinite(data.perPage) ? data.perPage! : DEFAULT_PER_PAGE;
  return Math.max(10, Math.min(MAX_PER_PAGE, value));
}

async function init() {
  perPage = await getPerPage();
  await loadPage();
  document.title = `履歴 (${totalCount.toLocaleString()})`;
}

init();

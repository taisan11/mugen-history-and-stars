/// <reference types="@taisan11/vite-plugin-webext/types" />
import './style.css'
import { getVisitsPage, searchVisitsPage, deleteVisit, clearAllVisits, type HistoryEntry } from '../db.ts'
import { requestSync } from '../sync.ts'

const DEFAULT_PER_PAGE = 500

const app = document.querySelector<HTMLDivElement>('#app')!

let currentPage = 0
let perPage = DEFAULT_PER_PAGE
let totalCount = 0
let searchQuery = ''
let currentItems: HistoryEntry[] = []

function formatDate(ts: number): string {
  const d = new Date(ts)
  const now = new Date()
  const diff = now.getTime() - d.getTime()
  const mins = Math.floor(diff / 60000)
  const hours = Math.floor(diff / 3600000)
  const days = Math.floor(diff / 86400000)

  if (mins < 1) return 'たった今'
  if (mins < 60) return `${mins}分前`
  if (hours < 24) return `${hours}時間前`
  if (days < 7) return `${days}日前`

  return d.toLocaleDateString('ja-JP', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function groupByDate(entries: HistoryEntry[]): Map<string, HistoryEntry[]> {
  const groups = new Map<string, HistoryEntry[]>()
  for (const entry of entries) {
    const d = new Date(entry.visitedAt)
    const key = d.toLocaleDateString('ja-JP', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' })
    const arr = groups.get(key) ?? []
    arr.push(entry)
    groups.set(key, arr)
  }
  return groups
}

function getDomain(url: string): string {
  try { return new URL(url).hostname } catch { return url }
}

function escapeHtml(s: string): string {
  const div = document.createElement('div')
  div.textContent = s
  return div.innerHTML
}

function render() {
  const totalPages = Math.ceil(totalCount / perPage)
  const groups = groupByDate(currentItems)

  let groupsHtml = ''
  for (const [date, entries] of groups) {
    const items = entries.map(e => `
      <div class="visit-item" data-id="${e.id}">
        <div class="visit-info">
          <a class="visit-title" href="${escapeHtml(e.url)}" target="_blank">${escapeHtml(e.title || getDomain(e.url))}</a>
          <div class="visit-meta">
            <span class="visit-domain">${escapeHtml(getDomain(e.url))}</span>
            <span class="visit-time">${formatDate(e.visitedAt)}</span>
          </div>
        </div>
        <button class="delete-btn" data-id="${e.id}" title="削除">×</button>
      </div>
    `).join('')

    groupsHtml += `
      <div class="date-group">
        <div class="date-header">${date} (${entries.length})</div>
        ${items}
      </div>
    `
  }

  if (currentItems.length === 0) {
    groupsHtml = `<div class="empty">${searchQuery ? '検索結果がありません' : '履歴がまだありません'}</div>`
  }

  let paginationHtml = ''
  if (totalPages > 1) {
    const pages: string[] = []
    pages.push(`<button class="page-btn" data-page="${currentPage - 1}" ${currentPage === 0 ? 'disabled' : ''}>←</button>`)
    for (let i = 0; i < totalPages; i++) {
      if (i === 0 || i === totalPages - 1 || Math.abs(i - currentPage) <= 2) {
        pages.push(`<button class="page-btn ${i === currentPage ? 'active' : ''}" data-page="${i}">${i + 1}</button>`)
      } else if (Math.abs(i - currentPage) === 3) {
        pages.push(`<span class="page-ellipsis">...</span>`)
      }
    }
    pages.push(`<button class="page-btn" data-page="${currentPage + 1}" ${currentPage >= totalPages - 1 ? 'disabled' : ''}>→</button>`)
    paginationHtml = `<div class="pagination">${pages.join('')}</div>`
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
    <div class="results-count">${currentPage * perPage + 1}〜${Math.min((currentPage + 1) * perPage, totalCount)} / ${totalCount.toLocaleString()} 件</div>
    <div id="history-list">${groupsHtml}</div>
    ${paginationHtml}
  `

  document.querySelector<HTMLInputElement>('#search')!.addEventListener('input', onSearch)
  document.querySelector<HTMLButtonElement>('#clear-all')!.addEventListener('click', onClearAll)
  document.querySelectorAll<HTMLButtonElement>('.delete-btn').forEach(btn => {
    btn.addEventListener('click', onDelete)
  })
  document.querySelectorAll<HTMLButtonElement>('.page-btn').forEach(btn => {
    btn.addEventListener('click', onPageChange)
  })
}

let searchTimer: ReturnType<typeof setTimeout>
function onSearch(e: Event) {
  searchQuery = (e.target as HTMLInputElement).value
  currentPage = 0
  clearTimeout(searchTimer)
  searchTimer = setTimeout(loadPage, 200)
}

function onPageChange(e: Event) {
  const btn = e.currentTarget as HTMLButtonElement
  const page = Number(btn.dataset.page)
  if (isNaN(page)) return
  currentPage = page
  loadPage()
}

async function onDelete(e: Event) {
  const btn = e.currentTarget as HTMLButtonElement
  const id = Number(btn.dataset.id)
  await deleteVisit(id)
  void requestSync().catch((error: unknown) => console.error('Sync failed', error))
  loadPage()
}

async function onClearAll() {
  if (!confirm('本当にすべての履歴を削除しますか？')) return
  await clearAllVisits()
  void requestSync().catch((error: unknown) => console.error('Sync failed', error))
  currentPage = 0
  loadPage()
}

async function loadPage() {
  let result: { items: HistoryEntry[]; total: number }
  if (searchQuery) {
    result = await searchVisitsPage(searchQuery, currentPage, perPage)
  } else {
    result = await getVisitsPage(currentPage, perPage)
  }
  currentItems = result.items
  totalCount = result.total
  render()
}

async function getPerPage(): Promise<number> {
  return new Promise((resolve) => {
    browser.storage.local.get('perPage').then((data) => {
      resolve((data as { perPage?: number }).perPage ?? DEFAULT_PER_PAGE)
    })
  })
}

async function init() {
  perPage = await getPerPage()
  await loadPage()
  document.title = `履歴 (${totalCount.toLocaleString()})`
}

init()

/// <reference types="@taisan11/vite-plugin-webext/types" />
import { getAllBookmarks, updateBookmark, removeBookmark, type BookmarkEntry } from '../db.ts'
import { requestSync } from '../sync.ts'
import './style.css'

const app = document.querySelector<HTMLDivElement>('#app')!

let bookmarks: BookmarkEntry[] = []
let editingId: number | null = null
let searchQuery = ''
let searchTimer: ReturnType<typeof setTimeout>

function escapeHtml(s: string): string {
  const div = document.createElement('div')
  div.textContent = s
  return div.innerHTML
}

function getDomain(url: string): string {
  try { return new URL(url).hostname } catch { return url }
}

function getVisibleBookmarks(): BookmarkEntry[] {
  const query = searchQuery.trim().toLowerCase()
  if (!query) return bookmarks
  return bookmarks.filter((bookmark) =>
    bookmark.name.toLowerCase().includes(query) || bookmark.url.toLowerCase().includes(query),
  )
}

function render() {
  const visibleBookmarks = getVisibleBookmarks()
  let listHtml = ''
  for (const b of visibleBookmarks) {
    if (editingId === b.id) {
      listHtml += `
        <div class="bookmark-item editing" data-id="${b.id}">
          <div class="edit-form">
            <input type="text" class="edit-name" value="${escapeHtml(b.name)}" placeholder="名前" />
            <input type="url" class="edit-url" value="${escapeHtml(b.url)}" placeholder="URL" />
            <div class="edit-actions">
              <button class="save-btn" data-id="${b.id}">保存</button>
              <button class="cancel-btn" data-id="${b.id}">キャンセル</button>
            </div>
          </div>
        </div>
      `
    } else {
      listHtml += `
        <div class="bookmark-item" data-id="${b.id}">
          <div class="bookmark-info">
            <a class="bookmark-name" href="${escapeHtml(b.url)}" target="_blank">${escapeHtml(b.name)}</a>
            <div class="bookmark-meta">
              <span class="bookmark-domain">${escapeHtml(getDomain(b.url))}</span>
            </div>
          </div>
          <div class="bookmark-actions">
            <button class="edit-btn" data-id="${b.id}" title="編集">✎</button>
            <button class="delete-btn" data-id="${b.id}" title="削除">×</button>
          </div>
        </div>
      `
    }
  }

  if (visibleBookmarks.length === 0) {
    listHtml = `<div class="empty">${searchQuery ? '検索結果がありません' : 'ブックマークがまだありません'}</div>`
  }

  app.innerHTML = `
    <header>
      <h1>ブックマーク</h1>
      <div class="stats">${searchQuery ? `${visibleBookmarks.length} / ${bookmarks.length}` : bookmarks.length} 件</div>
      <a class="nav-link" href="../history/index.html">履歴</a>
    </header>
    <div class="toolbar">
      <input type="search" id="search" placeholder="URL・タイトルで検索..." value="${escapeHtml(searchQuery)}" autofocus />
    </div>
    <div class="results-count">${visibleBookmarks.length.toLocaleString()} 件</div>
    <div id="bookmark-list">${listHtml}</div>
  `

  document.querySelector<HTMLInputElement>('#search')!.addEventListener('input', onSearch)
  document.querySelectorAll<HTMLButtonElement>('.edit-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      editingId = Number((e.currentTarget as HTMLButtonElement).dataset.id)
      render()
    })
  })
  document.querySelectorAll<HTMLButtonElement>('.delete-btn').forEach(btn => {
    btn.addEventListener('click', onDelete)
  })
  document.querySelectorAll<HTMLButtonElement>('.save-btn').forEach(btn => {
    btn.addEventListener('click', onSave)
  })
  document.querySelectorAll<HTMLButtonElement>('.cancel-btn').forEach(btn => {
    btn.addEventListener('click', () => { editingId = null; render() })
  })
}

function onSearch(e: Event) {
  searchQuery = (e.target as HTMLInputElement).value
  clearTimeout(searchTimer)
  searchTimer = setTimeout(() => {
    render()
    const input = document.querySelector<HTMLInputElement>('#search')
    input?.focus()
    input?.setSelectionRange(searchQuery.length, searchQuery.length)
  }, 200)
}

async function onDelete(e: Event) {
  const id = Number((e.currentTarget as HTMLButtonElement).dataset.id)
  await removeBookmark(id)
  void requestSync().catch((error: unknown) => console.error('Sync failed', error))
  bookmarks = await getAllBookmarks()
  render()
}

async function onSave(e: Event) {
  const id = Number((e.currentTarget as HTMLButtonElement).dataset.id)
  const item = document.querySelector<HTMLDivElement>(`.bookmark-item[data-id="${id}"]`)!
  const name = (item.querySelector('.edit-name') as HTMLInputElement).value.trim()
  const url = (item.querySelector('.edit-url') as HTMLInputElement).value.trim()
  if (!name || !url) return
  await updateBookmark(id, { name, url })
  void requestSync().catch((error: unknown) => console.error('Sync failed', error))
  editingId = null
  bookmarks = await getAllBookmarks()
  render()
}

async function init() {
  bookmarks = await getAllBookmarks()
  render()
}

init()

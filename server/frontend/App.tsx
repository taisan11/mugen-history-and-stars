import { createSignal, Show } from "solid-js";

export function App() {
  const [copied, setCopied] = createSignal(false);

  const copyEndpoint = async () => {
    await navigator.clipboard.writeText(`${window.location.origin}/v1/sync`);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2_000);
  };

  return (
    <main class="page-shell">
      <section class="hero-card">
        <div class="eyebrow">MUGEN HISTORY AND STARS</div>
        <h1>履歴とブックマークを、<span>どこでも同期。</span></h1>
        <p class="lead">
          ブラウザ拡張機能のデータを安全に同期するためのサーバーです。
          このページは Cloudflare Workers 上で動く Solid SPA です。
        </p>
        <div class="actions">
          <button type="button" onClick={copyEndpoint}>
            {copied() ? "コピーしました" : "同期エンドポイントをコピー"}
          </button>
          <a href="/health">API ヘルスチェック</a>
        </div>
      </section>
      <section class="status-card" aria-label="サービス状態">
        <div class="status-dot" />
        <div>
          <strong>Sync service online</strong>
          <p>同期 API は <code>/v1/sync</code> で利用できます。</p>
        </div>
        <Show when={copied()}>
          <small>URL はクリップボードに保存されました。</small>
        </Show>
      </section>
    </main>
  );
}

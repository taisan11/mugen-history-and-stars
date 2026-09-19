import { Avatar } from "@ark-ui/solid/avatar";
import { Clipboard } from "@ark-ui/solid/clipboard";
import { Field } from "@ark-ui/solid/field";
import { Show, createSignal, onMount } from "solid-js";

type User = { id: string; email: string | null; displayName: string; status: "active" | "disabled"; plan: { id: string; maxDevices?: number }; deviceCount: number; };
type Page = "dashboard" | "account";
const api = async (path: string, init: RequestInit = {}) => {
  const response = await fetch(path, { ...init, credentials: "include", headers: { "Content-Type": "application/json", ...(init.headers ?? {}) } });
  const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) throw new Error(typeof json.error === "string" ? json.error : `Request failed: ${response.status}`);
  return json;
};

function Login(props: { onLogin: (user: User) => void }) {
  const [email, setEmail] = createSignal("");
  const [password, setPassword] = createSignal("");
  const [error, setError] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const authorize = new URLSearchParams(location.search).get("authorize") === "1";
  const submit = async (event: SubmitEvent) => {
    event.preventDefault(); setBusy(true); setError("");
    try {
      const result = await api("/v1/auth/login", { method: "POST", body: JSON.stringify({ email: email(), password: password(), client: "web" }) });
      props.onLogin(result.user as User);
      if (authorize) {
        const params = new URLSearchParams(location.search);
        const approved = await api("/v1/auth/authorize/approve", { method: "POST", body: JSON.stringify({ clientId: params.get("client_id"), redirectUri: params.get("redirect_uri"), codeChallenge: params.get("code_challenge"), state: params.get("state") }) });
        location.href = approved.redirect as string;
      }
    } catch (failure) { setError(failure instanceof Error ? "メールアドレスまたはパスワードが正しくありません" : "ログインに失敗しました"); } finally { setBusy(false); }
  };
  return <main class="auth-shell"><form class="panel auth-card" onSubmit={submit}><div class="brand auth-brand"><span class="brand-mark">✦</span><span><strong>Mugen</strong><small>History &amp; Stars</small></span></div><span class="eyebrow">{authorize ? "EXTENSION LOGIN" : "WELCOME BACK"}</span><h1>ログイン</h1><p>管理者から発行されたアカウントでログインしてください。</p><Field.Root class="field-root" required><Field.Label>メールアドレス</Field.Label><Field.Input type="email" value={email()} onInput={(event) => setEmail(event.currentTarget.value)} /></Field.Root><Field.Root class="field-root" required><Field.Label>パスワード</Field.Label><Field.Input type="password" value={password()} onInput={(event) => setPassword(event.currentTarget.value)} /></Field.Root><Show when={error()}><div class="error-message">{error()}</div></Show><button class="primary-button auth-submit" disabled={busy()}>{busy() ? "ログイン中…" : "ログイン"}</button></form></main>;
}

function Sidebar(props: { page: Page; user: User; onLogout: () => void; onNavigate: (page: Page) => void }) {
  return <aside class="sidebar"><a class="brand" href="#dashboard" onClick={() => props.onNavigate("dashboard")}><span class="brand-mark">✦</span><span><strong>Mugen</strong><small>History &amp; Stars</small></span></a><nav><a classList={{ "nav-item": true, active: props.page === "dashboard" }} href="#dashboard" onClick={() => props.onNavigate("dashboard")}><span>⌂</span>ダッシュボード</a><a classList={{ "nav-item": true, active: props.page === "account" }} href="#account" onClick={() => props.onNavigate("account")}><span>◉</span>アカウント管理</a></nav><div class="sidebar-footer"><a href="/health" target="_blank">API ステータス ↗</a><a href="/admin-sasisuseso.html">管理コンソール ↗</a><button class="sidebar-logout" onClick={props.onLogout}>ログアウト</button></div></aside>;
}

function Header(props: { page: Page; user: User }) { return <header class="topbar"><div><span class="breadcrumb">Workspace / </span><strong>{props.page === "dashboard" ? "Dashboard" : "Account"}</strong></div><div class="user-chip"><Avatar.Root class="avatar"><Avatar.Fallback>{props.user.displayName.slice(0, 2)}</Avatar.Fallback></Avatar.Root><span>{props.user.displayName}</span></div></header>; }
function MetricCard(props: { label: string; value: string; note: string; tone?: string }) { return <article class={`metric-card ${props.tone ?? ""}`}><span class="metric-label">{props.label}</span><strong>{props.value}</strong><small>{props.note}</small></article>; }

function Dashboard(props: { user: User }) {
  const [health, setHealth] = createSignal("確認中");
  const [overview, setOverview] = createSignal<{ bookmarkCount: number; historyCount: number }>();
  onMount(() => { void fetch("/health").then((response) => setHealth(response.ok ? "オンライン" : "オフライン"), () => setHealth("オフライン")); void api("/v1/account/overview").then((result) => setOverview(result as { bookmarkCount: number; historyCount: number })).catch(() => undefined); });
  return <><div class="page-heading"><div><span class="eyebrow">OVERVIEW</span><h1>おかえりなさい、{props.user.displayName}。</h1><p>同期サービスの状態とアカウント利用状況を確認できます。</p></div><Clipboard.Root class="copy-server-url" value={location.origin}><Clipboard.Trigger class="primary-button">サーバーURLをコピー</Clipboard.Trigger></Clipboard.Root></div><section class="metrics-grid"><MetricCard label="プラン" value={props.user.plan.id} note="現在のプラン" tone="mint" /><MetricCard label="デバイス" value={`${props.user.deviceCount} / ${props.user.plan.maxDevices ?? "∞"}`} note="登録済みデバイス" /><MetricCard label="ブックマーク" value={String(overview()?.bookmarkCount ?? "—")} note="アカウントの保存数" /><MetricCard label="履歴" value={String(overview()?.historyCount ?? "—")} note="アカウントの保存数" /></section><section class="content-grid"><article class="panel sync-panel"><div class="panel-heading"><div><span class="eyebrow">SERVICE</span><h2>同期サービス</h2></div><span class={`status-pill ${health() === "オンライン" ? "online" : "checking"}`}>{health()}</span></div><p>ブラウザ拡張機能から送信された履歴とブックマークを、アカウント単位で同期します。</p><Clipboard.Root class="endpoint" value={location.origin}><Clipboard.ValueText /><Clipboard.Trigger class="icon-button" aria-label="サーバーURLをコピー">⧉</Clipboard.Trigger></Clipboard.Root><div class="last-sync"><span class="status-dot" /> 認証済みアカウントで接続中</div></article><article class="panel activity-panel"><div class="panel-heading"><div><span class="eyebrow">ACCOUNT</span><h2>アカウント概要</h2></div></div><div class="activity-row"><span class="activity-icon">✓</span><div><strong>{props.user.email}</strong><small>ログイン中のアカウント</small></div></div><div class="activity-row"><span class="activity-icon">◇</span><div><strong>{props.user.plan.id} プラン</strong><small>デバイス上限を管理者に確認できます</small></div></div><a class="text-link" href="#account">アカウント設定を確認 →</a></article></section></>;
}

function Account(props: { user: User; onUpdate: (user: User) => void }) {
  const [name, setName] = createSignal(props.user.displayName);
  const [email, setEmail] = createSignal(props.user.email ?? "");
  const [saved, setSaved] = createSignal("");
  const save = async (event: SubmitEvent) => { event.preventDefault(); setSaved(""); try { const result = await api("/v1/account", { method: "PATCH", body: JSON.stringify({ displayName: name(), email: email() }) }); props.onUpdate(result.user as User); setSaved("保存しました"); } catch (failure) { setSaved(failure instanceof Error ? failure.message : "保存に失敗しました"); } };
  return <><div class="page-heading"><div><span class="eyebrow">ACCOUNT</span><h1>アカウント管理</h1><p>プロフィール情報を更新できます。</p></div></div><form class="panel account-form" onSubmit={save}><div class="panel-heading"><div><span class="eyebrow">PROFILE</span><h2>プロフィール</h2></div></div><Field.Root class="field-root" required><Field.Label>表示名</Field.Label><Field.Input value={name()} onInput={(event) => setName(event.currentTarget.value)} /></Field.Root><Field.Root class="field-root" required><Field.Label>メールアドレス</Field.Label><Field.Input type="email" value={email()} onInput={(event) => setEmail(event.currentTarget.value)} /></Field.Root><div class="form-actions"><button class="primary-button">変更を保存</button></div><Show when={saved()}><p class="form-hint">{saved()}</p></Show></form><section class="content-grid account-grid"><article class="panel"><div class="panel-heading"><div><span class="eyebrow">SYNC SETTINGS</span><h2>同期設定</h2></div></div><Field.Root class="field-root" readOnly><Field.Label>サーバーURL</Field.Label><Field.Input value={location.origin} readonly /></Field.Root><p class="form-hint">このURLを拡張機能のサーバーURLに設定してログインしてください。</p></article><article class="panel danger-panel"><div class="panel-heading"><div><span class="eyebrow">ACCOUNT STATUS</span><h2>アカウント状態</h2></div></div><p>状態: <strong>{props.user.status === "active" ? "有効" : "無効"}</strong></p><p>プラン変更やパスワード再設定は管理者に依頼してください。</p></article></section></>;
}

export function App() {
  const [user, setUser] = createSignal<User>();
  const [loading, setLoading] = createSignal(true);
  const [page, setPage] = createSignal<Page>(location.hash === "#account" ? "account" : "dashboard");
  onMount(() => { const update = () => setPage(location.hash === "#account" ? "account" : "dashboard"); addEventListener("hashchange", update); void api("/v1/auth/me").then((result) => setUser(result.user as User)).catch(() => undefined).finally(() => setLoading(false)); return () => removeEventListener("hashchange", update); });
  const logout = async () => { await api("/v1/auth/logout", { method: "POST" }).catch(() => undefined); setUser(undefined); };
  return <Show when={!loading()} fallback={<main class="auth-shell"><p>読み込み中…</p></main>}>{user() ? <div class="app-shell"><Sidebar page={page()} user={user()!} onLogout={logout} onNavigate={setPage} /><div class="main-shell"><Header page={page()} user={user()!} /><main class="content-shell"><Show when={page() === "dashboard"} fallback={<Account user={user()!} onUpdate={setUser} />}><Dashboard user={user()!} /></Show></main></div></div> : <Login onLogin={setUser} />}</Show>;
}

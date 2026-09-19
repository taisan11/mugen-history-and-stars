import { Avatar } from "@ark-ui/solid/avatar";
import { Dialog } from "@ark-ui/solid/dialog";
import { Field } from "@ark-ui/solid/field";
import { Select, createListCollection } from "@ark-ui/solid/select";
import { For, Show, createSignal, onMount } from "solid-js";
import { Portal } from "solid-js/web";

type AdminUser = { id: string; email: string | null; displayName: string; planId: string; status: "active" | "disabled"; deviceCount: number; registeredAt: number; lastLoginAt: number | null };
type Page = "overview" | "users" | "plans";

const api = async (path: string, init: RequestInit = {}) => {
  const response = await fetch(path, { ...init, credentials: "include", headers: { "Content-Type": "application/json", ...(init.headers ?? {}) } });
  const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) throw new Error(typeof json.error === "string" ? json.error : `Request failed: ${response.status}`);
  return json;
};

const planCollection = createListCollection({ items: [{ label: "Free", value: "free" }, { label: "Pro", value: "pro" }] });

function AdminLogin(props: { onLogin: () => void }) {
  const [password, setPassword] = createSignal("");
  const [error, setError] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const submit = async (event: SubmitEvent) => {
    event.preventDefault(); setBusy(true); setError("");
    try { await api("/v1/admin/login", { method: "POST", body: JSON.stringify({ password: password() }) }); props.onLogin(); }
    catch { setError("管理者パスワードが正しくありません"); }
    finally { setBusy(false); }
  };
  return <main class="auth-shell"><form class="panel auth-card" onSubmit={submit}><div class="brand auth-brand"><span class="brand-mark admin-mark">✦</span><span><strong>Mugen</strong><small>Admin Console</small></span></div><span class="eyebrow">RESTRICTED AREA</span><h1>管理者ログイン</h1><p>管理者パスワードを入力してください。</p><Field.Root class="field-root" required><Field.Label>パスワード</Field.Label><Field.Input type="password" value={password()} onInput={(event) => setPassword(event.currentTarget.value)} /></Field.Root><Show when={error()}><div class="error-message">{error()}</div></Show><button class="primary-button auth-submit" disabled={busy()}>{busy() ? "確認中…" : "ログイン"}</button></form></main>;
}

function Sidebar(props: { page: Page; navigate: (page: Page) => void; logout: () => void }) {
  const items: Array<{ id: Page; label: string; icon: string }> = [{ id: "overview", label: "Overview", icon: "▦" }, { id: "users", label: "Users", icon: "♙" }, { id: "plans", label: "Plans & limits", icon: "◇" }];
  return <aside class="sidebar admin-sidebar"><a class="brand" href="#overview" onClick={() => props.navigate("overview")}><span class="brand-mark admin-mark">✦</span><span><strong>Mugen</strong><small>Admin Console</small></span></a><div class="admin-label">CONTROL CENTER</div><nav><For each={items}>{(item) => <a classList={{ "nav-item": true, active: props.page === item.id }} href={`#${item.id}`} onClick={() => props.navigate(item.id)}><span>{item.icon}</span>{item.label}</a>}</For></nav><div class="sidebar-footer"><a href="/">← User dashboard</a><button class="sidebar-logout" onClick={props.logout}>ログアウト</button></div></aside>;
}

function Overview() {
  const [data, setData] = createSignal<{ users: number; activeUsers: number; devices: number; activeSessions: number }>();
  onMount(() => { void api("/v1/admin/overview").then((result) => setData(result as typeof data extends () => infer T ? T : never)); });
  const bars = [42, 58, 47, 71, 64, 88, 77, 94, 72, 82, 91, 84];
  return <><div class="page-heading"><div><span class="eyebrow">ADMIN / OVERVIEW</span><h1>サービス概況</h1><p>同期サービス全体の利用状況を確認します。</p></div><span class="status-pill online">システム正常</span></div><section class="metrics-grid"><Metric label="登録ユーザー" value={String(data()?.users ?? "—")} note={`${data()?.activeUsers ?? "—"} active`} tone="mint" /><Metric label="アクティブデバイス" value={String(data()?.devices ?? "—")} note="全ユーザー合計" /><Metric label="有効セッション" value={String(data()?.activeSessions ?? "—")} note="access token" /><Metric label="API" value="正常" note="/health" /></section><section class="content-grid"><article class="panel chart-panel"><div class="panel-heading"><div><span class="eyebrow">TRAFFIC</span><h2>同期トラフィック</h2></div><span class="range-chip">API接続済み</span></div><div class="fake-chart"><div class="chart-bars"><For each={bars}>{(height) => <span style={{ height: `${height}%` }} />}</For></div><div class="chart-axis"><span>recent</span><span>active</span><span>users</span><span>now</span></div></div></article><article class="panel"><div class="panel-heading"><div><span class="eyebrow">HEALTH</span><h2>サービス状態</h2></div></div><div class="health-item"><span class="status-dot" /><div><strong>Sync API</strong><small>Worker endpoint</small></div><b>正常</b></div><div class="health-item"><span class="status-dot" /><div><strong>Database</strong><small>D1 · primary</small></div><b>正常</b></div></article></section></>;
}

function Metric(props: { label: string; value: string; note: string; tone?: string }) { return <article class={`metric-card ${props.tone ?? ""}`}><span class="metric-label">{props.label}</span><strong>{props.value}</strong><small>{props.note}</small></article>; }

function PlanSelect(props: { value: string; onChange: (value: string) => void }) {
  return <Select.Root class="select-root" collection={planCollection} value={[props.value]} onValueChange={(details) => { const value = details.value[0]; if (value) props.onChange(value); }}><Select.Label>プラン</Select.Label><Select.Control><Select.Trigger class="select-trigger"><Select.ValueText placeholder="プランを選択" /><Select.Indicator>⌄</Select.Indicator></Select.Trigger></Select.Control><Portal><Select.Positioner><Select.Content class="select-content"><For each={planCollection.items}>{(item) => <Select.Item class="select-item" item={item}><Select.ItemText>{item.label}</Select.ItemText><Select.ItemIndicator>✓</Select.ItemIndicator></Select.Item>}</For></Select.Content></Select.Positioner></Portal><Select.HiddenSelect /></Select.Root>;
}

function Users() {
  const [users, setUsers] = createSignal<AdminUser[]>([]);
  const [error, setError] = createSignal("");
  const [showCreate, setShowCreate] = createSignal(false);
  const [createPlan, setCreatePlan] = createSignal("free");
  const load = () => { void api("/v1/admin/users").then((result) => setUsers(result.users as AdminUser[])).catch((failure) => setError(failure instanceof Error ? failure.message : "読み込みに失敗しました")); };
  onMount(load);
  const createUser = async (event: SubmitEvent) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget as HTMLFormElement);
    try { await api("/v1/admin/users", { method: "POST", body: JSON.stringify({ email: form.get("email"), displayName: form.get("displayName"), password: form.get("password"), planId: createPlan() }) }); setShowCreate(false); load(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "作成に失敗しました"); }
  };
  const toggle = async (user: AdminUser) => { await api(`/v1/admin/users/${user.id}`, { method: "PATCH", body: JSON.stringify({ status: user.status === "active" ? "disabled" : "active" }) }); load(); };
  const changePlan = async (user: AdminUser, planId: string) => { await api(`/v1/admin/users/${user.id}`, { method: "PATCH", body: JSON.stringify({ planId }) }); load(); };
  const resetPassword = async (user: AdminUser) => { const password = prompt(`${user.displayName} の新しいパスワード（12文字以上）`); if (!password) return; try { await api(`/v1/admin/users/${user.id}/password-reset`, { method: "POST", body: JSON.stringify({ password }) }); setError("パスワードを再設定しました"); } catch (failure) { setError(failure instanceof Error ? failure.message : "再設定に失敗しました"); } };
  return <><div class="page-heading"><div><span class="eyebrow">ADMIN / USERS</span><h1>ユーザー</h1><p>登録ユーザーとプランの利用状況です。</p></div><Dialog.Root open={showCreate()} onOpenChange={(details) => { setShowCreate(details.open); if (details.open) setCreatePlan("free"); }} lazyMount><Dialog.Trigger class="primary-button">ユーザーを作成</Dialog.Trigger><Portal><Dialog.Backdrop /><Dialog.Positioner><Dialog.Content class="dialog-content"><Dialog.Title>新しいユーザー</Dialog.Title><Dialog.Description>ユーザーのアカウントと利用プランを設定します。</Dialog.Description><form onSubmit={createUser}><Field.Root class="field-root" required><Field.Label>メール</Field.Label><Field.Input name="email" type="email" /></Field.Root><Field.Root class="field-root" required><Field.Label>表示名</Field.Label><Field.Input name="displayName" /></Field.Root><Field.Root class="field-root" required><Field.Label>初期パスワード</Field.Label><Field.Input name="password" type="password" minlength="12" /></Field.Root><PlanSelect value={createPlan()} onChange={setCreatePlan} /><div class="dialog-actions"><Dialog.CloseTrigger class="secondary-button">キャンセル</Dialog.CloseTrigger><button class="primary-button" type="submit">作成</button></div></form></Dialog.Content></Dialog.Positioner></Portal></Dialog.Root></div><Show when={error()}><div class="error-message">{error()}</div></Show><section class="panel table-panel"><div class="table-toolbar"><span>{users().length} users</span></div><div class="table-scroll"><table><thead><tr><th>ユーザー</th><th>プラン</th><th>デバイス</th><th>最終ログイン</th><th>状態</th><th /></tr></thead><tbody><For each={users()}>{(user) => <tr><td><strong>{user.displayName}</strong><small>{user.email}<br /><code>{user.id}</code></small></td><td><PlanSelect value={user.planId} onChange={(planId) => void changePlan(user, planId)} /></td><td>{user.deviceCount}</td><td>{user.lastLoginAt ? new Date(user.lastLoginAt).toLocaleString("ja-JP") : "未ログイン"}</td><td><span class={`user-status ${user.status}`}>{user.status === "active" ? "Active" : "Disabled"}</span></td><td><button class="secondary-button" onClick={() => void toggle(user)}>{user.status === "active" ? "無効化" : "有効化"}</button><button class="secondary-button" onClick={() => void resetPassword(user)}>PW再設定</button></td></tr>}</For></tbody></table></div></section></>;
}

function Plans() { return <><div class="page-heading"><div><span class="eyebrow">ADMIN / PLANS</span><h1>プランと制限</h1><p>プラン設定はユーザー作成時とユーザー編集APIから適用されます。</p></div></div><section class="plan-grid"><article class="panel plan-card"><span class="eyebrow">PLAN</span><h2>Free</h2><ul><li>✓ ブックマーク 500件</li><li>✓ 履歴 10,000件</li><li>✓ デバイス 3台</li></ul></article><article class="panel plan-card mint"><span class="eyebrow">PLAN</span><h2>Pro</h2><ul><li>✓ ブックマーク 10,000件</li><li>✓ 履歴 100,000件</li><li>✓ デバイス 10台</li></ul></article></section></>; }

export function AdminApp() {
  const [authenticated, setAuthenticated] = createSignal<boolean>();
  const [page, setPage] = createSignal<Page>(location.hash === "#users" ? "users" : location.hash === "#plans" ? "plans" : "overview");
  onMount(() => { void api("/v1/admin/me").then(() => setAuthenticated(true)).catch(() => setAuthenticated(false)); const update = () => setPage(location.hash === "#users" ? "users" : location.hash === "#plans" ? "plans" : "overview"); addEventListener("hashchange", update); return () => removeEventListener("hashchange", update); });
  const logout = async () => { await api("/v1/admin/logout", { method: "POST" }).catch(() => undefined); setAuthenticated(false); };
  return <Show when={authenticated() !== undefined} fallback={<main class="auth-shell"><p>読み込み中…</p></main>}>{authenticated() ? <div class="app-shell"><Sidebar page={page()} navigate={setPage} logout={logout} /><div class="main-shell"><header class="topbar"><div><span class="breadcrumb">Admin Console / </span><strong>{page()}</strong></div><div class="user-chip"><Avatar.Root class="avatar admin-avatar"><Avatar.Fallback>AD</Avatar.Fallback></Avatar.Root><span>Administrator</span></div></header><main class="content-shell">{page() === "overview" ? <Overview /> : page() === "users" ? <Users /> : <Plans />}</main></div></div> : <AdminLogin onLogin={() => setAuthenticated(true)} />}</Show>;
}

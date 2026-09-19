const status = document.querySelector<HTMLParagraphElement>("#status")!;
const params = new URLSearchParams(location.search);
const code = params.get("code");
const state = params.get("state");

if (!code || !state) {
  status.textContent = "認証情報が不足しています。このページを閉じて再試行してください。";
} else {
  void browser.runtime.sendMessage({ type: "AUTH_CALLBACK", code, state }).then(
    (result: { ok?: boolean; error?: string }) => { status.textContent = result?.error ? result.error : "ログインしました。このページを閉じてください。"; },
    (error: unknown) => { status.textContent = error instanceof Error ? error.message : "ログインに失敗しました。"; },
  );
}

(function () {
  const API = ""; // 同一オリジン配信前提。別ホストで動かす場合はここにbase URLを設定。
  const TOKEN_KEY = "aerosocial_token"; // app.js と同じキー。共有することで、
  // AeroSocial本体に既にログイン済み（Googleでも可）ならこのページでも
  // 自動的にログイン状態として扱える。

  const loginForm = document.getElementById("login-form");
  const settingsPanel = document.getElementById("settings-panel");
  const loginMsg = document.getElementById("login-msg");
  const settingsMsg = document.getElementById("settings-msg");
  const toggle = document.getElementById("toggle");
  const googleBtn = document.getElementById("google-login-btn");
  const pilotIdInput = document.getElementById("pilot-id");
  const pilotIdSaveBtn = document.getElementById("pilot-id-save-btn");
  const pilotIdMsg = document.getElementById("pilot-id-msg");

  function setMsg(el, text, kind) {
    el.textContent = text || "";
    el.className = "msg" + (kind ? " " + kind : "");
  }

  function getToken() {
    return localStorage.getItem(TOKEN_KEY);
  }
  function setToken(token) {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  }

  function showSettings() {
    loginForm.classList.add("hidden");
    settingsPanel.classList.remove("hidden");
  }
  function showLogin() {
    settingsPanel.classList.add("hidden");
    loginForm.classList.remove("hidden");
  }

  async function api(path, opts = {}) {
    const token = getToken();
    const headers = Object.assign({}, opts.headers, token ? { Authorization: "Bearer " + token } : {});
    if (opts.body) headers["Content-Type"] = "application/json";
    const res = await fetch(API + path, Object.assign({}, opts, { headers }));
    let data = null;
    try { data = await res.json(); } catch { /* empty body */ }
    if (!res.ok) throw new Error((data && (data.error || data.message)) || ("HTTP " + res.status));
    return data;
  }

  // 既にAeroSocial本体（同じブラウザ）にログイン済みならそのトークンを流用し、
  // このページ単独でのログイン操作を省略する。
  async function tryExistingLogin() {
    if (!getToken()) { showLogin(); return; }
    try {
      await api("/api/users/me"); // トークンが有効か確認するだけ
      setMsg(loginMsg, "");
      showSettings();
      await loadPilotId();
      await loadSetting();
    } catch {
      setToken(null);
      showLogin();
    }
  }

  document.getElementById("login-btn").addEventListener("click", async () => {
    const callsign = document.getElementById("callsign").value.trim();
    const password = document.getElementById("password").value;
    if (!callsign || !password) { setMsg(loginMsg, "コールサインとパスワードを入力してください。", "error"); return; }

    setMsg(loginMsg, "ログイン中...");
    try {
      const data = await api("/api/auth/login", { method: "POST", body: JSON.stringify({ callsign, password }) });
      setToken(data.token);
      setMsg(loginMsg, "");
      showSettings();
      await loadPilotId();
      await loadSetting();
    } catch (err) {
      setMsg(loginMsg, "ログインに失敗しました: " + err.message, "error");
    }
  });

  // Googleでログイン: このページではOAuthのやり取りを完結させず、AeroSocial
  // 本体（/）を別タブで開いてそちらでログインしてもらう。本体とこのページは
  // 同じ localStorage の "aerosocial_token" を共有しているため、別タブで
  // ログインが完了すると storage イベント経由でこのページにも自動反映される。
  if (googleBtn) {
    googleBtn.addEventListener("click", () => {
      window.open("/", "_blank", "noopener");
      setMsg(loginMsg, "新しいタブでログインを完了すると、自動的にこのページにも反映されます。");
    });
  }

  window.addEventListener("storage", (e) => {
    if (e.key === TOKEN_KEY) tryExistingLogin();
  });

  document.getElementById("logout-btn").addEventListener("click", () => {
    // 注意: トークンはAeroSocial本体と共有しているため、ここでログアウトすると
    // 同じブラウザの本体側のログインも解除される。
    setToken(null);
    showLogin();
    document.getElementById("password").value = "";
    setMsg(settingsMsg, "");
  });

  async function loadPilotId() {
    try {
      const data = await api("/api/settings/fsa-pilot-id");
      pilotIdInput.value = data.pilotId || "";
    } catch (err) {
      setMsg(pilotIdMsg, "パイロットIDの取得に失敗しました: " + err.message, "error");
    }
  }

  pilotIdSaveBtn.addEventListener("click", async () => {
    const pilotId = pilotIdInput.value.trim();
    pilotIdSaveBtn.disabled = true;
    setMsg(pilotIdMsg, "保存中...");
    try {
      const data = await api("/api/settings/fsa-pilot-id", {
        method: "PATCH",
        body: JSON.stringify({ pilotId: pilotId || null }),
      });
      pilotIdInput.value = data.pilotId || "";
      setMsg(pilotIdMsg, pilotId ? "パイロットIDを保存しました。" : "パイロットIDの登録を解除しました。", "ok");
    } catch (err) {
      setMsg(pilotIdMsg, "保存に失敗しました: " + err.message, "error");
    } finally {
      pilotIdSaveBtn.disabled = false;
    }
  });

  async function loadSetting() {
    try {
      const data = await api("/api/settings/fsa-auto-post");
      toggle.checked = !!data.enabled;
    } catch (err) {
      setMsg(settingsMsg, "設定の取得に失敗しました: " + err.message, "error");
    }
  }

  toggle.addEventListener("change", async () => {
    const enabled = toggle.checked;
    toggle.disabled = true;
    setMsg(settingsMsg, "保存中...");
    try {
      await api("/api/settings/fsa-auto-post", { method: "PATCH", body: JSON.stringify({ enabled }) });
      setMsg(settingsMsg, enabled ? "自動投稿はONです。" : "自動投稿はOFFです。", "ok");
    } catch (err) {
      toggle.checked = !enabled;
      setMsg(settingsMsg, "保存に失敗しました: " + err.message, "error");
    } finally {
      toggle.disabled = false;
    }
  });

  tryExistingLogin();
})();

export const adminPage = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="dark">
  <title>bundle-1688-temu 控制台</title>
  <style>
    :root {
      color: #f5f5f3;
      background: #090a09;
      font-family: "Segoe UI Variable", "Microsoft YaHei", sans-serif;
      font-size: 14px;
      --bg: #090a09;
      --panel: #151614;
      --panel-deep: #0e0f0e;
      --line: #343530;
      --line-soft: #292a27;
      --text: #f5f5f3;
      --muted: #a6a59d;
      --quiet: #74756f;
      --orange: #ff6938;
      --orange-hover: #ff7d51;
      --cyan: #45d5ff;
      --green: #45dc9b;
      --red: #ff6b70;
      --yellow: #e8ba58;
    }
    * { box-sizing: border-box; }
    html { min-width: 320px; background: var(--bg); }
    body { min-height: 100dvh; margin: 0; background: var(--bg); }
    button, input, textarea { font: inherit; letter-spacing: 0; }
    button { color: inherit; }
    .hidden { display: none !important; }
    .login-shell { display: grid; min-height: 100dvh; place-items: center; padding: 24px; }
    .login-panel { width: min(420px, 100%); overflow: hidden; border: 1px solid var(--line); border-radius: 8px; background: var(--panel); box-shadow: inset 0 1px rgba(255,255,255,.025); }
    .login-heading { padding: 26px 28px 20px; border-bottom: 1px solid var(--line-soft); }
    .login-heading .kicker { margin-bottom: 8px; }
    .login-heading h1 { margin: 0; font-size: 22px; line-height: 1.25; font-weight: 650; }
    .login-heading p { margin: 8px 0 0; color: var(--muted); font-size: 13px; line-height: 1.6; }
    .login-body { display: grid; gap: 12px; padding: 24px 28px 28px; }
    .kicker { color: var(--cyan); font-family: Consolas, "Courier New", monospace; font-size: 10px; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; }
    .field { display: grid; min-width: 0; gap: 7px; }
    .field label { color: var(--muted); font-size: 12px; }
    input, textarea { width: 100%; border: 1px solid var(--line); border-radius: 6px; outline: none; background: var(--panel-deep); color: var(--text); transition: border-color 240ms cubic-bezier(.2,.8,.2,1), box-shadow 240ms cubic-bezier(.2,.8,.2,1); }
    input { min-height: 41px; padding: 9px 11px; }
    textarea { min-height: 410px; resize: vertical; padding: 14px; color: #d5e7ee; font-family: Consolas, "Courier New", monospace; font-size: 12px; line-height: 1.65; tab-size: 2; }
    input::placeholder, textarea::placeholder { color: #666760; }
    input:focus, textarea:focus { border-color: #73746e; box-shadow: 0 0 0 3px rgba(255,255,255,.045); }
    button { min-height: 36px; border: 1px solid var(--line); border-radius: 6px; padding: 8px 12px; background: #222320; cursor: pointer; transition: transform 220ms cubic-bezier(.2,.8,.2,1), border-color 220ms cubic-bezier(.2,.8,.2,1), background 220ms cubic-bezier(.2,.8,.2,1), color 220ms cubic-bezier(.2,.8,.2,1); }
    button:hover { border-color: #555650; background: #292a27; }
    button:active { transform: scale(.975); }
    button:focus-visible { outline: 2px solid var(--cyan); outline-offset: 2px; }
    button:disabled { cursor: wait; opacity: .55; }
    button.primary { border-color: var(--orange); background: var(--orange); color: #160b07; font-weight: 700; }
    button.primary:hover { border-color: var(--orange-hover); background: var(--orange-hover); }
    button.danger { border-color: rgba(255,107,112,.55); background: rgba(255,107,112,.045); color: var(--red); }
    button.danger:hover { border-color: var(--red); background: rgba(255,107,112,.1); }
    button.compact { min-height: 30px; padding: 5px 9px; font-size: 12px; }
    button.icon-button { width: 36px; padding: 0; font-size: 18px; line-height: 1; }
    button.full { width: 100%; }
    .app-shell { width: min(1280px, calc(100% - 40px)); margin: 0 auto; padding: 18px 0 42px; }
    .topbar { display: flex; min-height: 50px; align-items: center; justify-content: space-between; gap: 18px; border-bottom: 1px solid var(--line-soft); }
    .brand { display: flex; min-width: 0; align-items: center; gap: 12px; }
    .brand-mark { width: 9px; height: 9px; flex: 0 0 auto; border-radius: 2px; background: var(--orange); box-shadow: 13px 0 0 var(--cyan); }
    .brand h1 { margin: 0; overflow: hidden; font-size: 15px; font-weight: 650; text-overflow: ellipsis; white-space: nowrap; }
    .brand span { color: var(--quiet); font-family: Consolas, "Courier New", monospace; font-size: 11px; }
    .admin-tools { display: flex; align-items: center; gap: 8px; }
    .admin-identity { margin-right: 4px; color: var(--muted); font-size: 12px; }
    .admin-identity strong { color: var(--cyan); font-weight: 650; }
    .hero-line { display: flex; align-items: flex-end; justify-content: space-between; gap: 24px; padding: 30px 0 20px; }
    .hero-line h2 { margin: 0; font-size: clamp(22px, 3vw, 32px); line-height: 1.2; font-weight: 650; }
    .hero-line p { max-width: 590px; margin: 7px 0 0; color: var(--muted); line-height: 1.65; }
    .sync-note { color: var(--quiet); font-family: Consolas, "Courier New", monospace; font-size: 11px; text-align: right; }
    .stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); overflow: hidden; border: 1px solid var(--line); border-radius: 8px; background: var(--panel); }
    .stat { min-width: 0; padding: 17px 18px; border-right: 1px solid var(--line); }
    .stat:last-child { border-right: 0; }
    .stat-label { color: #b5a99d; font-family: Consolas, "Courier New", monospace; font-size: 9px; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; }
    .stat-value { margin-top: 7px; overflow: hidden; color: var(--cyan); font-size: 20px; font-weight: 700; text-overflow: ellipsis; white-space: nowrap; }
    .workspace { display: grid; grid-template-columns: minmax(0, 1.68fr) minmax(340px, 1fr); gap: 18px; margin-top: 18px; align-items: start; }
    .column { display: grid; min-width: 0; gap: 18px; }
    .panel { min-width: 0; overflow: hidden; border: 1px solid var(--line); border-radius: 8px; background: var(--panel); box-shadow: inset 0 1px rgba(255,255,255,.025); }
    .panel-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; padding: 18px 19px 15px; }
    .panel-header h3 { margin: 0; font-size: 17px; line-height: 1.3; font-weight: 650; }
    .panel-header p { margin: 5px 0 0; color: var(--muted); font-size: 12px; line-height: 1.55; }
    .panel-body { padding: 0 19px 19px; }
    .create-form { display: grid; grid-template-columns: minmax(130px, .9fr) minmax(160px, 1.3fr) auto; gap: 9px; align-items: end; margin-bottom: 18px; padding: 13px; border: 1px solid var(--line-soft); border-radius: 7px; background: var(--panel-deep); }
    .table-head, .account-row { display: grid; grid-template-columns: minmax(110px, 1fr) minmax(160px, 1.35fr) minmax(230px, 1.7fr); gap: 14px; align-items: center; }
    .table-head { padding: 9px 8px; color: var(--quiet); font-size: 10px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
    .account-row { padding: 13px 8px; border-top: 1px solid var(--line-soft); }
    .account-name { min-width: 0; }
    .account-name strong { display: block; overflow: hidden; font-size: 13px; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
    .account-name span { display: block; margin-top: 4px; overflow: hidden; color: var(--quiet); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
    .account-state { display: flex; flex-wrap: wrap; gap: 6px; }
    .badge { display: inline-flex; min-height: 23px; align-items: center; border-radius: 99px; padding: 3px 8px; font-size: 11px; white-space: nowrap; }
    .badge.enabled { color: var(--green); background: rgba(69,220,155,.1); }
    .badge.disabled { color: var(--red); background: rgba(255,107,112,.1); }
    .badge.bound { color: var(--cyan); background: rgba(69,213,255,.1); }
    .badge.unbound { color: var(--yellow); background: rgba(232,186,88,.1); }
    .badge.grant { color: var(--orange); background: rgba(255,105,56,.1); }
    .badge.current { color: var(--text); background: rgba(255,255,255,.08); }
    .badge.test { color: var(--yellow); background: rgba(232,186,88,.14); }
    .account-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 6px; }
    .config-meta { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 10px; color: var(--muted); font-size: 12px; }
    .config-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; margin-top: 11px; }
    .audit-list { max-height: 770px; overflow: auto; scrollbar-color: #494a45 transparent; scrollbar-width: thin; }
    .audit-row { display: grid; grid-template-columns: minmax(88px, .8fr) minmax(120px, 1.15fr) auto; gap: 10px; align-items: start; padding: 12px 0; border-top: 1px solid var(--line-soft); }
    .audit-row:first-child { border-top: 0; }
    .audit-main { min-width: 0; }
    .audit-main strong { display: block; overflow: hidden; color: var(--cyan); font-size: 12px; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
    .audit-main span, .audit-time span { display: block; margin-top: 4px; overflow: hidden; color: var(--quiet); font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
    .audit-time { min-width: 0; color: var(--text); font-family: Consolas, "Courier New", monospace; font-size: 11px; }
    .outcome { display: inline-flex; align-items: center; gap: 6px; font-size: 11px; white-space: nowrap; }
    .outcome::before { width: 7px; height: 7px; border-radius: 50%; background: currentColor; content: ""; }
    .outcome.success { color: var(--green); }
    .outcome.failed { color: var(--red); }
    .empty { padding: 34px 14px; border-top: 1px solid var(--line-soft); color: var(--quiet); text-align: center; }
    .status { min-height: 18px; margin: 8px 0 0; color: var(--muted); font-size: 12px; line-height: 1.5; word-break: break-word; }
    .status.error { color: var(--red); }
    .status.success { color: var(--green); }
    .access-code { position: fixed; right: 24px; bottom: 24px; z-index: 20; width: min(440px, calc(100% - 48px)); border: 1px solid #6b4a36; border-radius: 8px; padding: 15px; background: #1c1714; box-shadow: 0 18px 60px rgba(0,0,0,.36); transform: translateY(14px); opacity: 0; pointer-events: none; transition: transform 360ms cubic-bezier(.2,.8,.2,1), opacity 360ms cubic-bezier(.2,.8,.2,1); }
    .access-code.visible { transform: translateY(0); opacity: 1; pointer-events: auto; }
    .access-code-header { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
    .access-code h4 { margin: 0; font-size: 14px; }
    .access-code p { margin: 7px 0 12px; color: var(--muted); font-size: 12px; }
    .code-line { display: flex; gap: 8px; }
    .code-line code { display: flex; min-width: 0; flex: 1; align-items: center; overflow: hidden; border: 1px solid var(--line); border-radius: 6px; padding: 0 11px; background: var(--panel-deep); color: var(--cyan); font-family: Consolas, "Courier New", monospace; text-overflow: ellipsis; white-space: nowrap; }
    @media (max-width: 980px) { .workspace { grid-template-columns: 1fr; } .audit-list { max-height: 430px; } }
    @media (max-width: 720px) {
      .app-shell { width: calc(100% - 24px); padding-top: 10px; }
      .topbar { align-items: flex-start; padding: 8px 0 12px; }
      .brand span, .admin-identity { display: none; }
      .hero-line { display: block; padding: 24px 0 18px; }
      .sync-note { margin-top: 12px; text-align: left; }
      .stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .stat:nth-child(2) { border-right: 0; }
      .stat:nth-child(-n+2) { border-bottom: 1px solid var(--line); }
      .create-form { grid-template-columns: 1fr; }
      .table-head { display: none; }
      .account-row { grid-template-columns: 1fr; gap: 10px; padding: 16px 4px; }
      .account-actions { justify-content: flex-start; }
      textarea { min-height: 330px; }
    }
    @media (prefers-reduced-motion: reduce) { *, *::before, *::after { scroll-behavior: auto !important; transition-duration: .01ms !important; } }
  </style>
</head>
<body>
  <div id="login" class="login-shell">
    <section class="login-panel">
      <div class="login-heading">
        <div class="kicker">Secure control plane</div>
        <h1>授权控制台</h1>
        <p>管理访问账号、设备绑定与服务器配置版本。</p>
      </div>
      <div class="login-body">
        <div class="field"><label for="username">管理员账号</label><input id="username" type="text" value="root" placeholder="输入管理员账号" autocomplete="username"></div>
        <div class="field"><label for="password">管理员密码</label><input id="password" type="password" placeholder="输入管理员密码" autocomplete="current-password"></div>
        <button id="loginButton" class="primary full" type="button">登录</button>
        <p id="loginStatus" class="status" aria-live="polite"></p>
      </div>
    </section>
  </div>
  <div id="dashboard" class="hidden">
    <div class="app-shell">
      <header class="topbar">
        <div class="brand"><span class="brand-mark" aria-hidden="true"></span><h1>bundle-1688-temu</h1><span>AUTH CONSOLE</span></div>
        <div class="admin-tools"><span class="admin-identity">管理员&nbsp; <strong>root</strong></span><button id="refreshButton" class="icon-button" type="button" title="刷新数据" aria-label="刷新数据">↻</button><button id="logoutButton" type="button">退出</button></div>
      </header>
      <div class="hero-line">
        <div><div class="kicker">Cloudflare authorization</div><h2>访问与配置中心</h2><p>访问码只在生成时显示。客户端启动后验证设备，并按版本号拉取最新 config.json。</p></div>
        <div id="lastRefresh" class="sync-note">尚未同步</div>
      </div>
      <section class="stats" aria-label="系统概览">
        <div class="stat"><div class="stat-label">Accounts</div><div id="accountCount" class="stat-value">0</div></div>
        <div class="stat"><div class="stat-label">Enabled</div><div id="enabledCount" class="stat-value">0</div></div>
        <div class="stat"><div class="stat-label">MAC Bound</div><div id="boundCount" class="stat-value">0</div></div>
        <div class="stat"><div class="stat-label">Config Version</div><div id="configVersion" class="stat-value">0</div></div>
      </section>
      <main class="workspace">
        <div class="column">
          <section class="panel">
            <div class="panel-header"><div><h3>账号数据库</h3><p>创建访问账号，控制启用状态和设备绑定。</p></div></div>
            <div class="panel-body">
              <div class="create-form">
                <div class="field"><label for="accountName">账号名</label><input id="accountName" placeholder="例如：运营电脑"></div>
                <div class="field"><label for="accountNote">备注</label><input id="accountNote" placeholder="用途或负责人"></div>
                <button id="createAccountButton" class="primary" type="button">新增账号</button>
              </div>
              <p id="accountStatus" class="status" aria-live="polite"></p>
              <div class="table-head"><span>账号</span><span>状态</span><span style="text-align:right">操作</span></div>
              <div id="accounts"></div>
            </div>
          </section>
          <section class="panel">
            <div class="panel-header"><div><h3>发布 config.json</h3><p>只校验 JSON 格式；发布后版本号自动递增。</p></div></div>
            <div class="panel-body">
              <div class="config-meta"><span id="configUpdatedAt">当前没有发布时间</span><span id="configStatus" class="status" aria-live="polite"></span></div>
              <textarea id="configText" spellcheck="false" placeholder="{ }"></textarea>
              <div class="config-actions"><button id="rollbackConfigButton" type="button">回滚上一版</button><button id="publishConfigButton" class="primary" type="button">发布新版本</button></div>
            </div>
          </section>
          <section class="panel">
            <div class="panel-header"><div><h3>测试 config.json</h3><p>只下发给标记为测试配置的账号；确认无误后再发布到正式。</p></div></div>
            <div class="panel-body">
              <div class="config-meta"><span id="testConfigUpdatedAt">当前没有测试配置</span><span id="testConfigStatus" class="status" aria-live="polite"></span></div>
              <textarea id="testConfigText" spellcheck="false" placeholder="{ }"></textarea>
              <div class="config-actions"><button id="copyCurrentToTestButton" type="button">复制正式配置</button><button id="promoteTestConfigButton" type="button">发布到正式</button><button id="saveTestConfigButton" class="primary" type="button">保存测试版本</button></div>
            </div>
          </section>
        </div>
        <aside class="column">
          <section class="panel">
            <div class="panel-header"><div><h3>访问审计</h3><p>最近 120 条管理和客户端验证记录。</p></div></div>
            <div class="panel-body"><div id="audit" class="audit-list"></div></div>
          </section>
        </aside>
      </main>
    </div>
  </div>
  <aside id="accessCodeToast" class="access-code" aria-live="polite">
    <div class="access-code-header"><h4>一次性访问码已生成</h4><button id="closeAccessCodeButton" class="compact" type="button">关闭</button></div>
    <p>请立即交给用户，服务器不会保存明文。</p>
    <div class="code-line"><code id="accessCodeValue"></code><button id="copyAccessCodeButton" class="primary compact" type="button">复制</button></div>
  </aside>
  <script>
    const TOKEN_KEY = "bundle-1688-temu.admin-token";
    const state = { token: localStorage.getItem(TOKEN_KEY) || "", accounts: [], config: null, testConfig: null, loginBusy: false, loginLockedUntil: 0, loginTimer: null };

    /** Return one DOM node by id. */
    function byId(id) { return document.getElementById(id); }

    /** Update one status line with success or error styling. */
    function setStatus(id, text, type) { const node = byId(id); node.textContent = text || ""; node.className = "status " + (type || ""); }

    /** Return one localized date string or a readable fallback. */
    function formatDate(value) { if (!value) return "无记录"; const date = new Date(value); return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString("zh-CN", { hour12: false }); }

    /** Return one short label for an audit action path. */
    function auditActionLabel(value) {
      const action = String(value || "");
      if (action.indexOf("/api/user/config") >= 0) return "客户端验证";
      if (action.indexOf("/api/admin/login") >= 0) return "管理员登录";
      if (action.indexOf("reset-code") >= 0) return "重置访问码";
      if (action.indexOf("unbind-mac") >= 0) return "解绑设备";
      if (action.indexOf("grant-mac-missing") >= 0) return "临时授权";
      if (action.indexOf("/api/admin/test-config/copy-current") >= 0) return "复制测试配置";
      if (action.indexOf("/api/admin/test-config/promote") >= 0) return "测试发布正式";
      if (action.indexOf("/api/admin/test-config") >= 0) return "保存测试配置";
      if (action.indexOf("/api/admin/config") >= 0) return "发布配置";
      if (action.indexOf("/api/admin/rollback") >= 0) return "回滚配置";
      if (action.indexOf("/api/admin/accounts") >= 0) return "账号操作";
      if (action.indexOf("/api/admin/state") >= 0) return "刷新控制台";
      return action || "系统操作";
    }

    /** Send one authenticated JSON request to the Worker API. */
    async function api(pathname, options) {
      const response = await fetch(pathname, { method: options && options.method || "GET", headers: { "Content-Type": "application/json", "Authorization": state.token ? "Bearer " + state.token : "" }, body: options && options.body ? JSON.stringify(options.body) : undefined });
      /** Ignore non-JSON error bodies and let the HTTP status drive the message. */
      const payload = await response.json().catch(function ignoreInvalidJson() { return null; });
      if (!response.ok || !payload || payload.ok === false) {
        const error = new Error(payload && payload.error || "请求失败。");
        error.data = payload && payload.data || {};
        error.status = response.status;
        throw error;
      }
      return payload.data || payload;
    }

    /** Toggle between login and dashboard views. */
    function renderShell(authenticated) {
      byId("login").classList.toggle("hidden", authenticated);
      byId("dashboard").classList.toggle("hidden", !authenticated);
      if (!authenticated) window.setTimeout(function focusLoginInput() { byId("username").focus(); }, 50);
    }

    /** Return the remaining seconds for the current browser-side login lock. */
    function loginLockSeconds() {
      return Math.max(0, Math.ceil((state.loginLockedUntil - Date.now()) / 1000));
    }

    /** Render disabled login controls and the server-directed lock countdown. */
    function renderLoginControls() {
      const remainingSeconds = loginLockSeconds();
      const locked = remainingSeconds > 0;
      byId("username").disabled = locked || state.loginBusy;
      byId("password").disabled = locked || state.loginBusy;
      byId("loginButton").disabled = locked || state.loginBusy;
      byId("loginButton").textContent = locked ? remainingSeconds + " 秒后重试" : state.loginBusy ? "正在验证" : "登录";
      if (locked) {
        setStatus("loginStatus", "连续失败次数过多，请在 " + remainingSeconds + " 秒后重试。", "error");
        return;
      }
      if (state.loginTimer) {
        window.clearInterval(state.loginTimer);
        state.loginTimer = null;
        setStatus("loginStatus", "现在可以重新登录。", "");
      }
    }

    /** Start a local countdown using the authoritative retry delay returned by the Worker. */
    function startLoginLock(seconds) {
      const durationSeconds = Math.max(1, Math.ceil(Number(seconds) || 0));
      state.loginLockedUntil = Date.now() + durationSeconds * 1000;
      if (state.loginTimer) {
        window.clearInterval(state.loginTimer);
      }
      state.loginTimer = window.setInterval(renderLoginControls, 250);
      renderLoginControls();
    }

    /** Create one badge node for account status display. */
    function createBadge(text, className) { const badge = document.createElement("span"); badge.className = "badge " + className; badge.textContent = text; return badge; }

    /** Create one account action button. */
    function createActionButton(label, className, handler) {
      const button = document.createElement("button");
      button.type = "button"; button.className = "compact " + (className || ""); button.textContent = label;
      /** Execute the selected account action and display any failure. */
      button.onclick = function handleAccountButtonClick() { handler().catch(function handleAccountActionError(error) { setStatus("accountStatus", error.message, "error"); }); };
      return button;
    }

    /** Render all accounts with their current MAC binding state. */
    function renderAccounts(accounts) {
      const root = byId("accounts"); root.innerHTML = "";
      if (!accounts.length) { const empty = document.createElement("div"); empty.className = "empty"; empty.textContent = "还没有访问账号"; root.appendChild(empty); return; }
      /** Render one account row and its action buttons. */
      accounts.forEach(function renderAccount(account) {
        const row = document.createElement("div"); row.className = "account-row";
        const identity = document.createElement("div"); identity.className = "account-name";
        const name = document.createElement("strong"); name.textContent = account.name || "未命名账号";
        const note = document.createElement("span"); note.textContent = account.note || "无备注"; note.title = note.textContent;
        identity.appendChild(name); identity.appendChild(note);
        const badges = document.createElement("div"); badges.className = "account-state";
        badges.appendChild(createBadge(account.enabled ? "已启用" : "已停用", account.enabled ? "enabled" : "disabled"));
        badges.appendChild(createBadge(account.macBound ? "MAC 已绑定" : "MAC 未绑定", account.macBound ? "bound" : "unbound"));
        badges.appendChild(createBadge(account.configChannel === "test" ? "测试配置" : "正式配置", account.configChannel === "test" ? "test" : "current"));
        if (account.macMissingGrant) badges.appendChild(createBadge("临时授权待使用", "grant"));
        const actions = document.createElement("div"); actions.className = "account-actions";
        actions.appendChild(createActionButton(account.enabled ? "停用" : "启用", "", function toggleAccount() { return updateAccount(account.id, { enabled: !account.enabled }); }));
        actions.appendChild(createActionButton(account.configChannel === "test" ? "走正式配置" : "走测试配置", "", function toggleConfigChannel() { return updateAccount(account.id, { configChannel: account.configChannel === "test" ? "current" : "test" }); }));
        actions.appendChild(createActionButton("解绑 MAC", "", function unbindMac() { return postAccountAction(account.id, "unbind-mac"); }));
        actions.appendChild(createActionButton("临时授权", "", function grantMacMissing() { return postAccountAction(account.id, "grant-mac-missing"); }));
        actions.appendChild(createActionButton("重置访问码", "", function resetCode() { return postAccountAction(account.id, "reset-code"); }));
        actions.appendChild(createActionButton("删除", "danger", function deleteAccount() { return deleteAccountById(account.id); }));
        row.appendChild(identity); row.appendChild(badges); row.appendChild(actions); root.appendChild(row);
      });
    }

    /** Render account and config counters in the dashboard summary. */
    function renderStats() {
      const enabled = state.accounts.filter(function isEnabled(account) { return account.enabled; }).length;
      const bound = state.accounts.filter(function isMacBound(account) { return account.macBound; }).length;
      byId("accountCount").textContent = String(state.accounts.length); byId("enabledCount").textContent = String(enabled); byId("boundCount").textContent = String(bound); byId("configVersion").textContent = String(state.config && state.config.version || 0);
    }

    /** Refresh accounts, current config, and audit data from the Worker. */
    async function refreshState() {
      const data = await api("/api/admin/state"); state.accounts = data.accounts || []; state.config = data.config || { version: 0, updatedAt: "", config: {} }; state.testConfig = data.testConfig || { version: 0, updatedAt: "", config: {} };
      renderAccounts(state.accounts); renderStats(); byId("configText").value = JSON.stringify(state.config.config || {}, null, 2);
      byId("configUpdatedAt").textContent = state.config.updatedAt ? "发布时间：" + formatDate(state.config.updatedAt) : "当前没有发布时间";
      byId("testConfigText").value = JSON.stringify(state.testConfig.config || {}, null, 2);
      byId("testConfigUpdatedAt").textContent = state.testConfig.updatedAt ? "测试版本 v" + String(state.testConfig.version || 0) + "：" + formatDate(state.testConfig.updatedAt) : "当前没有测试配置";
      byId("lastRefresh").textContent = "同步于 " + formatDate(new Date().toISOString()); renderAudit(data.audit || []); renderShell(true);
    }

    /** Render the recent audit log rows. */
    function renderAudit(rows) {
      const root = byId("audit"); root.innerHTML = "";
      if (!rows.length) { const empty = document.createElement("div"); empty.className = "empty"; empty.textContent = "暂无审计记录"; root.appendChild(empty); return; }
      /** Render one audit row in reverse chronological order. */
      rows.forEach(function renderAuditRow(row) {
        const node = document.createElement("div"); node.className = "audit-row";
        const main = document.createElement("div"); main.className = "audit-main";
        const account = document.createElement("strong"); account.textContent = row.account_name || "system";
        const detail = document.createElement("span"); detail.textContent = row.detail || "无附加信息"; detail.title = detail.textContent; main.appendChild(account); main.appendChild(detail);
        const time = document.createElement("div"); time.className = "audit-time"; time.textContent = auditActionLabel(row.action);
        const date = document.createElement("span"); date.textContent = formatDate(row.requested_at); time.appendChild(date);
        const outcome = document.createElement("span"); const success = row.outcome === "success"; outcome.className = "outcome " + (success ? "success" : "failed"); outcome.textContent = success ? "成功" : "失败";
        node.appendChild(main); node.appendChild(time); node.appendChild(outcome); root.appendChild(node);
      });
    }

    /** Show a newly generated one-time access code. */
    function showAccessCode(accessCode) { byId("accessCodeValue").textContent = accessCode || ""; byId("accessCodeToast").classList.add("visible"); }
    /** Hide the one-time access code notification. */
    function hideAccessCode() { byId("accessCodeToast").classList.remove("visible"); }
    /** Copy the current one-time access code to the clipboard. */
    async function copyAccessCode() { const value = byId("accessCodeValue").textContent; await navigator.clipboard.writeText(value); byId("copyAccessCodeButton").textContent = "已复制"; window.setTimeout(function resetCopyButtonLabel() { byId("copyAccessCodeButton").textContent = "复制"; }, 1600); }

    /** Login with the administrator account and password secrets. */
    async function login() {
      if (loginLockSeconds() > 0 || state.loginBusy) {
        return;
      }
      state.loginBusy = true;
      renderLoginControls();
      setStatus("loginStatus", "正在验证…", "");
      try {
        const data = await api("/api/admin/login", {
          method: "POST",
          body: { username: byId("username").value, password: byId("password").value }
        });
        state.token = data.token;
        localStorage.setItem(TOKEN_KEY, state.token);
        byId("password").value = "";
        await refreshState();
      } catch (error) {
        const retryAfterSeconds = Number(error.data && error.data.retryAfterSeconds || 0);
        const remainingAttempts = Number(error.data && error.data.remainingAttempts);
        if (retryAfterSeconds > 0) {
          startLoginLock(retryAfterSeconds);
        } else {
          const suffix = Number.isFinite(remainingAttempts) ? "还可尝试 " + remainingAttempts + " 次。" : "";
          setStatus("loginStatus", error.message + suffix, "error");
        }
      } finally {
        state.loginBusy = false;
        renderLoginControls();
      }
    }

    /** Clear the local admin session and return to the login view. */
    function logout() { state.token = ""; localStorage.removeItem(TOKEN_KEY); hideAccessCode(); renderShell(false); }

    /** Create one user account and display its one-time access code. */
    async function createAccount() { const data = await api("/api/admin/accounts", { method: "POST", body: { name: byId("accountName").value, note: byId("accountNote").value } }); showAccessCode(data.accessCode); setStatus("accountStatus", "账号已创建。", "success"); byId("accountName").value = ""; byId("accountNote").value = ""; await refreshState(); }
    /** Update one account's mutable fields. */
    async function updateAccount(id, patch) { await api("/api/admin/accounts/" + encodeURIComponent(id), { method: "PATCH", body: patch }); setStatus("accountStatus", "账号已更新。", "success"); await refreshState(); }
    /** Execute one account-level admin action. */
    async function postAccountAction(id, action) { const data = await api("/api/admin/accounts/" + encodeURIComponent(id) + "/" + action, { method: "POST" }); if (data.accessCode) showAccessCode(data.accessCode); setStatus("accountStatus", data.accessCode ? "访问码已重置。" : "操作完成。", "success"); await refreshState(); }
    /** Delete one account after browser confirmation. */
    async function deleteAccountById(id) { if (!confirm("确认删除这个账号？访问码将立即失效。")) return; await api("/api/admin/accounts/" + encodeURIComponent(id), { method: "DELETE" }); setStatus("accountStatus", "账号已删除。", "success"); await refreshState(); }
    /** Publish the textarea JSON as a new cloud config version. */
    async function publishConfig() { const config = JSON.parse(byId("configText").value || "{}"); const data = await api("/api/admin/config", { method: "POST", body: { config: config } }); setStatus("configStatus", "已发布 v" + data.version, "success"); await refreshState(); }
    /** Roll the cloud config back to its previous version. */
    async function rollbackConfig() { if (!confirm("确认回滚到上一版配置？")) return; const data = await api("/api/admin/rollback", { method: "POST" }); setStatus("configStatus", "已回滚至 v" + data.version, "success"); await refreshState(); }
    /** Save the staged textarea JSON without changing production users. */
    async function saveTestConfig() { const config = JSON.parse(byId("testConfigText").value || "{}"); const data = await api("/api/admin/test-config", { method: "POST", body: { config: config } }); setStatus("testConfigStatus", "测试版本已保存 v" + data.version, "success"); await refreshState(); }
    /** Copy the current production config into the staged test textarea. */
    async function copyCurrentToTest() { const data = await api("/api/admin/test-config/copy-current", { method: "POST" }); setStatus("testConfigStatus", "已复制为测试版本 v" + data.version, "success"); await refreshState(); }
    /** Promote the staged test config to production after confirmation. */
    async function promoteTestConfig() { if (!confirm("确认把测试配置发布到正式？当前正式配置会进入上一版。")) return; const data = await api("/api/admin/test-config/promote", { method: "POST" }); setStatus("configStatus", "测试配置已发布到正式 v" + data.version, "success"); await refreshState(); }

    /** Refresh all dashboard data and surface refresh failures. */
    function handleRefreshClick() { refreshState().catch(function handleRefreshError(error) { setStatus("configStatus", error.message, "error"); }); }
    /** Create an account from the input fields and surface failures. */
    function handleCreateAccountClick() { createAccount().catch(function handleCreateAccountError(error) { setStatus("accountStatus", error.message, "error"); }); }
    /** Publish the current textarea content and surface failures. */
    function handlePublishConfigClick() { publishConfig().catch(function handlePublishConfigError(error) { setStatus("configStatus", error.message, "error"); }); }
    /** Roll back the config package and surface failures. */
    function handleRollbackConfigClick() { rollbackConfig().catch(function handleRollbackConfigError(error) { setStatus("configStatus", error.message, "error"); }); }
    /** Save the staged config textarea and surface failures. */
    function handleSaveTestConfigClick() { saveTestConfig().catch(function handleSaveTestConfigError(error) { setStatus("testConfigStatus", error.message, "error"); }); }
    /** Copy production config into the staged slot and surface failures. */
    function handleCopyCurrentToTestClick() { copyCurrentToTest().catch(function handleCopyCurrentToTestError(error) { setStatus("testConfigStatus", error.message, "error"); }); }
    /** Promote staged config to production and surface failures. */
    function handlePromoteTestConfigClick() { promoteTestConfig().catch(function handlePromoteTestConfigError(error) { setStatus("testConfigStatus", error.message, "error"); }); }
    /** Submit login when Enter is pressed in either credential field. */
    function handleLoginKeydown(event) { if (event.key === "Enter") login(); }
    /** Copy the current access code and surface clipboard failures. */
    function handleCopyAccessCodeClick() { copyAccessCode().catch(function handleClipboardError() { byId("copyAccessCodeButton").textContent = "复制失败"; }); }

    byId("loginButton").onclick = login;
    byId("username").onkeydown = handleLoginKeydown;
    byId("password").onkeydown = handleLoginKeydown;
    byId("logoutButton").onclick = logout;
    byId("refreshButton").onclick = handleRefreshClick;
    byId("createAccountButton").onclick = handleCreateAccountClick;
    byId("publishConfigButton").onclick = handlePublishConfigClick;
    byId("rollbackConfigButton").onclick = handleRollbackConfigClick;
    byId("saveTestConfigButton").onclick = handleSaveTestConfigClick;
    byId("copyCurrentToTestButton").onclick = handleCopyCurrentToTestClick;
    byId("promoteTestConfigButton").onclick = handlePromoteTestConfigClick;
    byId("closeAccessCodeButton").onclick = hideAccessCode;
    byId("copyAccessCodeButton").onclick = handleCopyAccessCodeClick;
    if (state.token) {
      /** Return to the login shell when the saved token is invalid. */
      refreshState().catch(function handleInitialRefreshError() { logout(); });
    } else renderShell(false);
  </script>
</body>
</html>`;

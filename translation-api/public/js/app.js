function Uga() {
  return window.UgaApi;
}

let state = {
  user: null,
  billingConfig: null,
  newKey: null,
  lastApiKey: localStorage.getItem("ugajapa_last_key") || "",
};

const routes = {
  "/login": renderLogin,
  "/signup": renderSignup,
  "/dashboard": renderDashboard,
  "/keys": renderKeys,
  "/billing": renderBilling,
  "/playground": renderPlayground,
};

function esc(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmtDate(iso) {
  if (!iso) return "Never";
  return new Date(iso).toLocaleString();
}

function fmtNum(n) {
  return typeof n === "number" ? n.toLocaleString() : n;
}

function initials(name, email) {
  const src = name || email || "?";
  return src.split(" ").map((w) => w[0]).join("").slice(0, 2).toUpperCase();
}

function toast(msg, type = "success") {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.className = `toast ${type}`;
  el.classList.remove("hidden");
  setTimeout(() => el.classList.add("hidden"), 3500);
}

function navigate(path) {
  location.hash = path;
}

function currentRoute() {
  const hash = location.hash.replace(/^#/, "");
  if (!hash) return Uga().getToken() ? "/dashboard" : "/login";
  return routes[hash] ? hash : "/dashboard";
}

function layout(content, active = "/dashboard") {
  const user = state.user;
  return `
    <div class="dashboard">
      <header class="topbar">
        <div class="topbar-inner">
          <button class="menu-toggle" id="menu-toggle" aria-label="Toggle menu" aria-expanded="false">☰</button>
          <div class="logo">Uga<span>Japa</span></div>
          <nav class="nav" id="main-nav">
            <div class="nav-links">
              <a href="#/dashboard" class="${active === "/dashboard" ? "active" : ""}">📊 Overview</a>
              <a href="#/keys" class="${active === "/keys" ? "active" : ""}">🔑 API Keys</a>
              <a href="#/billing" class="${active === "/billing" ? "active" : ""}">💳 Billing</a>
              <a href="#/playground" class="${active === "/playground" ? "active" : ""}">🧪 Playground</a>
            </div>
            <div class="nav-user">
              <div class="user-chip">
                <div class="user-avatar">${esc(initials(user?.full_name, user?.email))}</div>
                <div class="meta">
                  <strong>${esc(user?.full_name || user?.email || "Account")}</strong>
                  <span>${esc(user?.email || "")}</span>
                </div>
              </div>
              <button class="btn btn-ghost btn-sm" id="logout-btn">Sign out</button>
            </div>
          </nav>
        </div>
      </header>
      <div class="nav-backdrop" id="nav-backdrop"></div>
      <main class="main">${content}</main>
    </div>
  `;
}

function authLayout(title, subtitle, formHtml, switchHtml) {
  return `
    <div class="auth-shell">
      <div class="auth-brand">
        <div class="logo">Uga<span>Japa</span></div>
        <p>Central Translation API for Mattermost plugins — auth, quality scoring, usage metering, and card billing.</p>
        <div class="auth-features">
          <div class="auth-feature">
            <div class="auth-feature-icon">⚡</div>
            <div><strong>Per-user API keys</strong><br><span style="color:var(--muted);font-size:0.85rem">Secure plugin access with usage tracking</span></div>
          </div>
          <div class="auth-feature">
            <div class="auth-feature-icon">✓</div>
            <div><strong>Quality in every response</strong><br><span style="color:var(--muted);font-size:0.85rem">Server-side evaluation metadata</span></div>
          </div>
          <div class="auth-feature">
            <div class="auth-feature-icon">💳</div>
            <div><strong>Card billing only</strong><br><span style="color:var(--muted);font-size:0.85rem">Stripe-powered subscriptions & invoices</span></div>
          </div>
        </div>
      </div>
      <div class="auth-panel">
        <div class="auth-card">
          <h1>${title}</h1>
          <p class="subtitle">${subtitle}</p>
          ${formHtml}
          <p class="auth-switch">${switchHtml}</p>
        </div>
      </div>
    </div>
  `;
}

function renderLogin() {
  document.getElementById("app").innerHTML = authLayout(
    "Welcome back",
    "Sign in to manage your translation API",
    `<form id="login-form">
      <div class="field"><label>Email</label><input name="email" type="email" required autocomplete="email" /></div>
      <div class="field"><label>Password</label><input name="password" type="password" required autocomplete="current-password" /></div>
      <div id="login-error" class="field-error hidden"></div>
      <button type="submit" class="btn btn-primary btn-block">Sign in</button>
    </form>`,
  `Don't have an account? <a href="#/signup">Create one</a>`
  );
  document.getElementById("login-form").onsubmit = onLogin;
}

function renderSignup() {
  document.getElementById("app").innerHTML = authLayout(
    "Create account",
    "Start translating with the UgaJapa API",
    `<form id="signup-form">
      <div class="field"><label>Full name</label><input name="full_name" required autocomplete="name" /></div>
      <div class="field"><label>Email</label><input name="email" type="email" required autocomplete="email" /></div>
      <div class="field"><label>Password</label><input name="password" type="password" minlength="8" required autocomplete="new-password" placeholder="At least 8 characters" /></div>
      <div id="signup-error" class="field-error hidden"></div>
      <button type="submit" class="btn btn-primary btn-block">Create account</button>
    </form>`,
    `Already have an account? <a href="#/login">Sign in</a>`
  );
  document.getElementById("signup-form").onsubmit = onSignup;
}

async function renderDashboard() {
  const usage = await Uga().getUsage();
  const pct = usage.characters_limit
    ? Math.min(100, (usage.characters_used / usage.characters_limit) * 100)
    : 0;

  document.getElementById("app").innerHTML = layout(`
    <div class="page-header">
      <h1>Overview</h1>
      <p>Your translation API usage and account at a glance.</p>
    </div>
    <div class="grid-4" style="margin-bottom:1.5rem">
      <div class="stat-card"><label>Plan</label><strong>${esc(usage.plan)}</strong></div>
      <div class="stat-card"><label>Used</label><strong>${fmtNum(usage.characters_used)}</strong></div>
      <div class="stat-card"><label>Remaining</label><strong>${usage.remaining != null ? fmtNum(usage.remaining) : "∞"}</strong></div>
      <div class="stat-card"><label>Month</label><strong>${esc(usage.month)}</strong></div>
    </div>
    <div class="card">
      <h2>Character quota</h2>
      <div style="display:flex;justify-content:space-between;font-size:0.85rem;color:var(--muted)">
        <span>${fmtNum(usage.characters_used)} used</span>
        <span>${usage.characters_limit ? fmtNum(usage.characters_limit) + " limit" : "Unlimited"}</span>
      </div>
      <div class="progress-bar"><span style="width:${pct}%"></span></div>
      ${usage.quota_exceeded ? '<p style="color:var(--danger);font-size:0.85rem;margin-top:0.75rem">Quota exceeded — <a href="#/billing">Upgrade plan</a></p>' : ""}
    </div>
    <div class="grid-2" style="margin-top:1.25rem">
      <div class="card">
        <h2>Quick start</h2>
        <ol style="color:var(--muted);font-size:0.9rem;padding-left:1.2rem;display:grid;gap:0.5rem">
          <li><a href="#/keys">Generate an API key</a></li>
          <li>Configure your Mattermost plugin with this URL</li>
          <li>Test in the <a href="#/playground">Playground</a></li>
        </ol>
      </div>
      <div class="card">
        <h2>API endpoint</h2>
        <div class="key-box"><span>${esc(location.origin)}/v1/translate</span>
          <button class="btn btn-secondary btn-sm" onclick="navigator.clipboard.writeText('${esc(location.origin)}/v1/translate');window.UgaApp.toast('Copied!')">Copy</button>
        </div>
      </div>
    </div>
  `, "/dashboard");
  bindLogout();
}

async function renderKeys() {
  const data = await Uga().getKeys();
  const keys = data.keys || [];

  const keysHtml = keys.length
    ? keys.map((k) => `
      <div class="key-item ${k.revoked ? "revoked" : ""}">
        <div class="key-item-head">
          <strong>${esc(k.name)}</strong>
          <span>
            <span class="pill pill-${k.env === "test" ? "test" : "live"}">${k.env}</span>
            ${k.revoked ? '<span class="pill pill-unpaid">revoked</span>' : ""}
          </span>
        </div>
        <div class="key-box"><span>${esc(k.key_preview || k.key_value)}</span></div>
        <div class="key-meta">Created ${fmtDate(k.created_at)} · Last used ${fmtDate(k.last_used)}</div>
      </div>`).join("")
    : `<div class="empty-state"><div style="font-size:2rem">🔑</div><p>No API keys yet</p></div>`;

  const revealHtml = state.newKey ? `
    <div class="key-reveal" id="key-reveal">
      <h3>✓ New API key created</h3>
      <p>Copy this key now — you won't see it again.</p>
      <div class="key-box">
        <span id="new-key-text">${esc(state.newKey)}</span>
        <button class="btn btn-secondary btn-sm" id="copy-key-btn">Copy</button>
      </div>
    </div>` : "";

  document.getElementById("app").innerHTML = layout(`
    <div class="page-header">
      <h1>API Keys</h1>
      <p>Issue keys for your Mattermost plugin and integrations.</p>
    </div>
    <div class="grid-2">
      <div class="card">
        <h2>Generate new key</h2>
        <form id="key-form">
          <div class="field"><label>Key name</label><input name="name" placeholder="Mattermost production" required /></div>
          <button type="submit" class="btn btn-primary">Generate key</button>
        </form>
        ${revealHtml}
      </div>
      <div class="card">
        <h2>Your keys</h2>
        ${keysHtml}
      </div>
    </div>
  `, "/keys");

  document.getElementById("key-form").onsubmit = onGenerateKey;
  const copyBtn = document.getElementById("copy-key-btn");
  if (copyBtn) copyBtn.onclick = () => copyText(state.newKey);
  bindLogout();
}

async function renderBilling() {
  const [overview, config] = await Promise.all([Uga().getBillingOverview(), Uga().getBillingConfig()]);
  const params = new URLSearchParams(location.hash.split("?")[1] || "");

  let notice = "";
  if (params.get("checkout") === "success") {
    notice = `<div class="billing-notice ok">✓ Payment successful! Your plan has been updated.</div>`;
  } else if (params.get("invoice_paid")) {
    notice = `<div class="billing-notice ok">✓ Invoice ${esc(params.get("invoice_paid"))} paid successfully.</div>`;
  } else if (params.get("checkout") === "canceled") {
    notice = `<div class="billing-notice">Payment canceled.</div>`;
  }

  const stripeReady = config.enabled;
  const plansHtml = (overview.plans || config.plans || []).map((p) => {
    const isCurrent = overview.plan === p.id;
    const isFeatured = p.id === "starter";
    const canUpgrade = stripeReady && !isCurrent && p.id !== "free" && p.id !== "enterprise";
    return `
      <div class="plan-card ${isFeatured ? "featured" : ""} ${isCurrent ? "current" : ""}">
        ${isCurrent ? '<span class="card-badge">Current</span>' : ""}
        ${isFeatured && !isCurrent ? '<span class="card-badge">Popular</span>' : ""}
        <h3>${esc(p.name)}</h3>
        <p style="color:var(--muted);font-size:0.85rem">${esc(p.description || "")}</p>
        <div class="plan-price">$${p.price_usd}<small>/mo</small></div>
        <ul class="plan-features">
          ${(p.features || []).map((f) => `<li>${esc(f)}</li>`).join("")}
        </ul>
        ${isCurrent
          ? '<button class="btn btn-secondary btn-block" disabled>Current plan</button>'
          : canUpgrade
            ? `<button class="btn btn-primary btn-block" data-plan="${p.id}">Pay with card</button>`
            : p.id === "free"
              ? '<button class="btn btn-secondary btn-block" disabled>Free tier</button>'
              : '<button class="btn btn-secondary btn-block" disabled>Contact sales</button>'}
        <div class="card-payment-badge">💳 Card payments only</div>
      </div>`;
  }).join("");

  const invoices = overview.invoices || [];
  const invoicesHtml = invoices.length
    ? invoices.map((inv) => `
      <div class="invoice-row">
        <div class="invoice-info">
          <strong>${esc(inv.month)}</strong>
          <span>${fmtNum(inv.characters_total)} chars · $${inv.amount_usd.toFixed(2)} USD</span>
        </div>
        <div style="display:flex;align-items:center;gap:0.75rem">
          <span class="pill pill-${inv.paid ? "paid" : "unpaid"}">${inv.paid ? "Paid" : "Unpaid"}</span>
          ${!inv.paid && inv.amount_usd > 0 && stripeReady
            ? `<button class="btn btn-primary btn-sm" data-invoice="${esc(inv.month)}">Pay with card</button>`
            : ""}
        </div>
      </div>`).join("")
    : `<div class="empty-state"><p>No invoices yet</p></div>`;

  const stripeNotice = stripeReady
    ? ""
    : `<div class="billing-notice">Stripe is not configured. Add <code>STRIPE_SECRET_KEY</code> and <code>STRIPE_PUBLISHABLE_KEY</code> to enable card payments.</div>`;

  document.getElementById("app").innerHTML = layout(`
    <div class="page-header">
      <h1>Billing</h1>
      <p>Manage your plan and pay invoices securely by card.</p>
    </div>
    ${notice}
    ${stripeNotice}
    <div class="grid-3" style="margin-bottom:2rem">${plansHtml}</div>
    <div class="card">
      <h2>Invoices</h2>
      ${invoicesHtml}
    </div>
  `, "/billing");

  document.querySelectorAll("[data-plan]").forEach((btn) => {
    btn.onclick = () => onCheckoutPlan(btn.dataset.plan);
  });
  document.querySelectorAll("[data-invoice]").forEach((btn) => {
    btn.onclick = () => onCheckoutInvoice(btn.dataset.invoice);
  });
  bindLogout();
}

function renderPlayground() {
  document.getElementById("app").innerHTML = layout(`
    <div class="page-header">
      <h1>Playground</h1>
      <p>Test the v1 translation API with your key.</p>
    </div>
    <div class="card">
      <form id="translate-form">
        <div class="field"><label>API key</label><input name="api_key" value="${esc(state.lastApiKey)}" placeholder="ugj_live_xxxx-xxxx-xxxx" required /></div>
        <div class="field"><label>Text</label><textarea name="text" rows="3" required>Good morning everyone</textarea></div>
        <div class="grid-2">
          <div class="field"><label>From</label><input name="from" value="en" required /></div>
          <div class="field"><label>To</label><input name="to" value="ja" required /></div>
        </div>
        <button type="submit" class="btn btn-primary">Translate</button>
      </form>
      <pre class="playground-result hidden" id="translate-result"></pre>
    </div>
  `, "/playground");
  document.getElementById("translate-form").onsubmit = onTranslate;
  bindLogout();
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast("Copied to clipboard");
  } catch {
    toast("Copy failed", "error");
  }
}

function bindLogout() {
  const btn = document.getElementById("logout-btn");
  if (btn) btn.onclick = async () => { await Uga().logout(); state.user = null; navigate("/login"); render(); };
  bindNavToggle();
}

function bindNavToggle() {
  const toggle = document.getElementById("menu-toggle");
  const nav = document.getElementById("main-nav");
  const backdrop = document.getElementById("nav-backdrop");
  if (!toggle || !nav || !backdrop) return;

  const closeNav = () => {
    nav.classList.remove("open");
    backdrop.classList.remove("open");
    toggle.setAttribute("aria-expanded", "false");
  };
  const openNav = () => {
    nav.classList.add("open");
    backdrop.classList.add("open");
    toggle.setAttribute("aria-expanded", "true");
  };

  toggle.onclick = () => (nav.classList.contains("open") ? closeNav() : openNav());
  backdrop.onclick = closeNav;
  nav.querySelectorAll(".nav-links a").forEach((a) => (a.onclick = closeNav));
}

async function onLogin(e) {
  e.preventDefault();
  const fd = new FormData(e.target);
  const errEl = document.getElementById("login-error");
  errEl.classList.add("hidden");
  const btn = e.target.querySelector("button");
  btn.disabled = true;
  try {
    const data = await Uga().login(Object.fromEntries(fd.entries()));
    Uga().setToken(data.token);
    state.user = await Uga().getMe();
    navigate("/dashboard");
    render();
  } catch (err) {
    errEl.textContent = err.message;
    errEl.classList.remove("hidden");
  } finally {
    btn.disabled = false;
  }
}

async function onSignup(e) {
  e.preventDefault();
  const fd = new FormData(e.target);
  const errEl = document.getElementById("signup-error");
  errEl.classList.add("hidden");
  const btn = e.target.querySelector("button");
  btn.disabled = true;
  try {
    const data = await Uga().signup(Object.fromEntries(fd.entries()));
    Uga().setToken(data.token);
    state.user = await Uga().getMe();
    navigate("/dashboard");
    render();
  } catch (err) {
    errEl.textContent = err.message;
    errEl.classList.remove("hidden");
  } finally {
    btn.disabled = false;
  }
}

async function onGenerateKey(e) {
  e.preventDefault();
  const name = new FormData(e.target).get("name");
  const btn = e.target.querySelector("button");
  btn.disabled = true;
  try {
    const data = await Uga().generateKey(name);
    state.newKey = data.key || data.key_value;
    state.lastApiKey = state.newKey;
    localStorage.setItem("ugajapa_last_key", state.newKey);
    toast("API key generated");
    renderKeys();
  } catch (err) {
    toast(err.message, "error");
  } finally {
    btn.disabled = false;
  }
}

async function onCheckoutPlan(plan) {
  try {
    const { url } = await Uga().checkoutPlan(plan);
    if (url) location.href = url;
  } catch (err) {
    toast(err.message, "error");
  }
}

async function onCheckoutInvoice(month) {
  try {
    const { url } = await Uga().checkoutInvoice(month);
    if (url) location.href = url;
  } catch (err) {
    toast(err.message, "error");
  }
}

async function onTranslate(e) {
  e.preventDefault();
  const fd = new FormData(e.target);
  const apiKey = fd.get("api_key");
  const resultEl = document.getElementById("translate-result");
  resultEl.classList.remove("hidden");
  resultEl.textContent = "Translating…";
  state.lastApiKey = apiKey;
  localStorage.setItem("ugajapa_last_key", apiKey);
  try {
    const data = await Uga().translateV1(apiKey, {
      text: fd.get("text"),
      sourceLang: fd.get("from"),
      targetLang: fd.get("to"),
    });
    resultEl.textContent = JSON.stringify(data, null, 2);
  } catch (err) {
    resultEl.textContent = err.message;
  }
}

async function render() {
  if (!window.UgaApi) {
    document.getElementById("app").innerHTML =
      '<div style="padding:2rem;color:#f87171;font-family:Inter,sans-serif"><h2>Failed to load app</h2><p>Refresh the page. Use <a href="http://localhost:5000">localhost:5000</a></p></div>';
    return;
  }

  const route = currentRoute();

  // Public pages render immediately — no API wait
  if (route === "/login") { renderLogin(); return; }
  if (route === "/signup") { renderSignup(); return; }

  if (!Uga().getToken()) {
    navigate("/login");
    renderLogin();
    return;
  }

  try {
    state.user = await Uga().getMe();
    const handler = routes[route] || renderDashboard;
    await handler();
  } catch {
    Uga().setToken("");
    renderLogin();
  }
}

function boot() {
  window.addEventListener("hashchange", () => render());
  render();
}

window.UgaApp = { toast, navigate, render };

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}

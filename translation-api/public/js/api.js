const API = "";

let authToken = localStorage.getItem("ugajapa_token") || "";

function getToken() {
  return authToken;
}

function setToken(token) {
  authToken = token || "";
  if (token) localStorage.setItem("ugajapa_token", token);
  else localStorage.removeItem("ugajapa_token");
}

async function api(path, opts = {}) {
  const headers = {
    "Content-Type": "application/json",
    ...(opts.headers || {}),
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(API + path, {
      ...opts,
      headers,
      signal: controller.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || res.statusText || "Request failed");
    return data;
  } catch (err) {
    if (err.name === "AbortError") throw new Error("Request timed out — is the API running on port 5000?");
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function authHeaders() {
  return {
    Authorization: "Bearer " + authToken,
    "Content-Type": "application/json",
  };
}

async function getMe() {
  return api("/auth/me", { headers: authHeaders() });
}

async function login(body) {
  return api("/auth/login", { method: "POST", body: JSON.stringify(body) });
}

async function signup(body) {
  return api("/auth/signup", { method: "POST", body: JSON.stringify(body) });
}

async function logout() {
  try {
    await api("/auth/logout", { method: "POST", headers: authHeaders() });
  } catch (_) {}
  setToken("");
}

async function getKeys() {
  return api("/keys", { headers: authHeaders() });
}

async function generateKey(name) {
  return api("/keys/generate", {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ name }),
  });
}

async function getUsage() {
  return api("/dashboard/usage", { headers: authHeaders() });
}

async function getBillingOverview() {
  return api("/billing/overview", { headers: authHeaders() });
}

async function getBillingConfig() {
  return api("/billing/config");
}

async function checkoutPlan(plan) {
  return api("/billing/checkout/plan", {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ plan }),
  });
}

async function checkoutInvoice(month) {
  return api("/billing/checkout/invoice", {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ month }),
  });
}

async function translateV1(apiKey, body) {
  return api("/v1/translate", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": apiKey,
    },
    body: JSON.stringify(body),
  });
}

window.UgaApi = {
  getToken,
  setToken,
  api,
  authHeaders,
  getMe,
  login,
  signup,
  logout,
  getKeys,
  generateKey,
  getUsage,
  getBillingOverview,
  getBillingConfig,
  checkoutPlan,
  checkoutInvoice,
  translateV1,
};

/**
 * Monarch Money content script — runs on app.monarch.com.
 * Reads session token from localStorage and handles GraphQL requests for accounts/balances.
 */

const MONARCH_GRAPHQL = 'https://api.monarch.com/graphql';
const MONARCH_GRAPHQL_LEGACY = 'https://api.monarchmoney.com/graphql';
const MONARCH_ORIGIN = 'https://app.monarch.com';
const MONARCH_CLIENT_VERSION = 'v1.0.2489';
const FETCH_TIMEOUT_MS = 15000;


function getMonarchDeviceUuid() {
  try {
    const v = localStorage.getItem('monarchDeviceUUID');
    return (v && typeof v === 'string' && v.trim()) ? v.trim() : null;
  } catch (_) {}
  return null;
}

async function fetchWithTimeout(url, options, timeoutMs = FETCH_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: ctrl.signal });
    clearTimeout(id);
    return res;
  } catch (e) {
    clearTimeout(id);
    if (e.name === 'AbortError') throw new Error('Request timed out');
    throw e;
  }
}

function buildMonarchHeaders(csrftoken) {
  const headers = {
    'Content-Type': 'application/json',
    'Client-Platform': 'web',
    'Monarch-Client': 'monarch-core-web-app-graphql',
    'Monarch-Client-Version': MONARCH_CLIENT_VERSION,
    Origin: MONARCH_ORIGIN,
  };
  const deviceUuid = getMonarchDeviceUuid();
  if (deviceUuid) headers['Device-Uuid'] = deviceUuid;
  if (csrftoken) headers['X-Csrftoken'] = csrftoken;
  return headers;
}

async function getMonarchCSRFToken(monarchURL) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "GET_MONARCH_CSRF_TOKEN", url: MONARCH_ORIGIN }, (response) => {
      if (!response || !response.success) {
          resolve(null);
      }
      resolve(response.token);
    });
  });
}

async function graphqlRequestWithAuth(query, variables = {}) {
  for (const graphqlUrl of [MONARCH_GRAPHQL, MONARCH_GRAPHQL_LEGACY]) {
    let res;
    const csrftoken = await getMonarchCSRFToken(graphqlUrl);
    try {
      res = await fetchWithTimeout(
          graphqlUrl,
          {
            method: 'POST',
            credentials: 'include',
            headers: buildMonarchHeaders(csrftoken),
            body: JSON.stringify({ query, variables }),
          },
          FETCH_TIMEOUT_MS);
    } catch (e) {
      if (e.message === 'Request timed out') continue;
      return { error: e.message || String(e) };
    }
    if (res.ok) {
      const json = await res.json();
      if (json.errors && json.errors.length) continue;
      return { data: json.data };
    }
    if (res.status === 401) continue;
    const text = await res.text();
    return { error: `HTTP ${res.status}: ${text.slice(0, 200)}` };
  }
  return { error: 'All auth combinations returned 401. Monarch may have changed how they authenticate.' };
}

const GET_ACCOUNTS_QUERY = `
query GetAccounts {
  accounts {
    id
    displayName
    currentBalance
    displayBalance
    type { name }
    isHidden
  }
}
`;

function parseOptionalBalance(value) {
  if (value == null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const s = String(value)
    .replace(/[,$]/g, '')
    .replace(/[−–—]/g, '-')
    .trim();
  const match = s.match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;
  const n = Number(match[0]);
  if (!Number.isFinite(n)) return null;
  return /^\(.*\)$/.test(s) ? -Math.abs(n) : n;
}

function accountBalance(node) {
  const current = parseOptionalBalance(node?.currentBalance);
  const display = parseOptionalBalance(node?.displayBalance);
  if (current == null) return display == null ? 0 : display;
  // Some Monarch account types can report currentBalance as zero while
  // displayBalance is the USD value shown in the app.
  if (current === 0 && display != null && display !== 0) return display;
  return current;
}

function describeValue(val) {
  if (val == null) return 'null';
  if (typeof val !== 'string') return typeof val;
  const s = val.trim();
  if (s.length === 0) return 'empty string';
  let shape = 'string, length ' + s.length;
  if (s.startsWith('eyJ')) shape += ', starts with eyJ (JWT-like)';
  else if (s.startsWith('{')) {
    try {
      const o = JSON.parse(s);
      if (o && typeof o === 'object') {
        const keys = Object.keys(o).slice(0, 15);
        shape += ', JSON with keys: ' + keys.join(', ');
      }
    } catch (_) {}
  }
  return shape;
}

function diagnoseStorage() {
  const report = { url: location.href, local: [], session: [], cookies: [] };
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      const val = localStorage.getItem(key);
      report.local.push({ key, valueShape: describeValue(val) });
    }
    for (let i = 0; i < sessionStorage.length; i++) {
      const key = sessionStorage.key(i);
      const val = sessionStorage.getItem(key);
      report.session.push({ key, valueShape: describeValue(val) });
    }
    document.cookie.split(';').forEach((part) => {
      const eq = part.indexOf('=');
      if (eq === -1) return;
      const name = part.slice(0, eq).trim();
      const val = part.slice(eq + 1).trim();
      report.cookies.push({ name, valueShape: describeValue(val) });
    });
  } catch (e) {
    report.error = String(e.message || e);
  }
  return report;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const handle = async () => {
    if (message.type === 'DIAGNOSE_STORAGE') {
      return { success: true, report: diagnoseStorage() };
    }

    if (message.type === 'GET_TOKEN') {
      const token = getTokenFromStorage();
      return { token: token || null, success: !!token };
    }

    if (message.type === 'FETCH_ACCOUNTS') {
      const result = await graphqlRequestWithAuth(GET_ACCOUNTS_QUERY);
      if (result.error) return { success: false, error: result.error };
      const data = result.data;
      const rawAccounts = data?.accounts ?? [];
      const accounts = (Array.isArray(rawAccounts) ? rawAccounts : [])
        .filter((node) => !node.isHidden)
        .map((node) => ({
          id: node.id,
          name: node.displayName || node.id,
          displayBalance: accountBalance(node),
          type: node.type?.name,
          subtype: node.subtype?.name,
          institution: node.institution?.name,
          isAsset: node.isAsset,
        }));
      return { success: true, accounts };
    }

    if (message.type === 'FETCH_BALANCES') {
      const accountIds = message.accountIds || [];
      if (accountIds.length === 0) return { success: true, accounts: [] };
      const result = await graphqlRequestWithAuth(GET_ACCOUNTS_QUERY);
      if (result.error) return { success: false, error: result.error };
      const data = result.data;
      const rawAccounts = data?.accounts ?? [];
      const allNodes = Array.isArray(rawAccounts) ? rawAccounts : [];
      const visible = allNodes.filter((node) => !node.isHidden);
      const idSet = new Set(accountIds);
      const accounts = visible
        .filter((node) => idSet.has(node.id))
        .map((node) => ({
          id: node.id,
          name: node.displayName || node.id,
          balance: accountBalance(node),
        }));
      return { success: true, accounts };
    }

    return null;
  };

  handle().then(sendResponse);
  return true;
});

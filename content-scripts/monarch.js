/**
 * Monarch Money content script — runs on app.monarch.com.
 * Reads session token from localStorage and handles GraphQL requests for accounts/balances.
 */

const MONARCH_GRAPHQL = 'https://api.monarch.com/graphql';
const MONARCH_GRAPHQL_LEGACY = 'https://api.monarchmoney.com/graphql';
const MONARCH_ORIGIN = 'https://app.monarch.com';
const MONARCH_CLIENT_VERSION = 'v1.0.1554';
const FETCH_TIMEOUT_MS = 15000;

const TOKEN_KEYS = [
  'gist.web.userToken',
  'mm/auth/token',
  'monarch/auth/token',
  'auth/token',
  'token',
  'authToken',
  'auth_token',
  'accessToken',
  'access_token',
  'userToken',
  'user_token',
  'session',
  'sessionToken',
  'bearer',
];
const JWT_PATTERN = /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_.-]+$/;
const AUTH_KEY_HINT = /token|auth|session|bearer|key|credential/i;

function extractTokenFromValue(val) {
  if (!val || typeof val !== 'string') return null;
  const s = val.trim();
  if (s.length < 20) return null;
  if (JWT_PATTERN.test(s)) return s;
  const bearerMatch = s.match(/^bearer\s+(.+)$/i);
  if (bearerMatch) {
    const t = bearerMatch[1].trim();
    if (JWT_PATTERN.test(t)) return t;
  }
  try {
    let parsed = null;
    try {
      parsed = JSON.parse(s);
    } catch (_) {
      try {
        parsed = JSON.parse(atob(s));
      } catch (_2) {}
    }
    if (parsed && typeof parsed === 'object') {
      const candidates = [
        parsed.value,
        parsed.token,
        parsed.accessToken,
        parsed.access_token,
        parsed.authToken,
        parsed.auth_token,
        parsed.sessionToken,
        parsed.session_token,
        parsed.bearer,
        parsed.key,
        parsed.data?.token,
        parsed.data?.accessToken,
        parsed.data?.access_token,
        parsed.user?.token,
        parsed.user?.accessToken,
        parsed.auth?.token,
        parsed.auth?.accessToken,
      ].filter(Boolean);
      for (const t of candidates) {
        const str = typeof t === 'string' ? t.trim() : String(t).trim();
        if (JWT_PATTERN.test(str)) return str;
      }
    }
  } catch (_) {}
  return null;
}

function getTokenFromCookies() {
  try {
    const cookies = document.cookie.split(';');
    for (const part of cookies) {
      const eq = part.indexOf('=');
      if (eq === -1) continue;
      const key = part.slice(0, eq).trim();
      const val = part.slice(eq + 1).trim();
      if (!AUTH_KEY_HINT.test(key)) continue;
      const token = extractTokenFromValue(val);
      if (token) return token;
    }
  } catch (_) {}
  return null;
}

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

function buildMonarchHeaders(authorizationValue) {
  const headers = {
    'Content-Type': 'application/json',
    Authorization: authorizationValue,
    'Client-Platform': 'web',
    'Monarch-Client': 'monarch-core-web-app-graphql',
    'Monarch-Client-Version': MONARCH_CLIENT_VERSION,
    Origin: MONARCH_ORIGIN,
  };
  const deviceUuid = getMonarchDeviceUuid();
  if (deviceUuid) headers['Device-Uuid'] = deviceUuid;
  return headers;
}

function getTokenFromPersistRoot(storage) {
  try {
    const raw = storage.getItem('persist:root');
    if (!raw || typeof raw !== 'string') return [];
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return [];
    const out = [];
    const dig = (obj, depth) => {
      if (depth > 6) return;
      if (!obj) return;
      if (typeof obj === 'string') {
        try {
          if (obj.trim().startsWith('{')) dig(JSON.parse(obj), depth + 1);
        } catch (_) {}
        return;
      }
      if (typeof obj !== 'object') return;
      if (typeof obj.token === 'string' && obj.token.length >= 20) out.push(obj.token.trim());
      if (typeof obj.authToken === 'string' && obj.authToken.length >= 20) out.push(obj.authToken.trim());
      if (typeof obj.accessToken === 'string' && obj.accessToken.length >= 20) out.push(obj.accessToken.trim());
      if (typeof obj.sessionToken === 'string' && obj.sessionToken.length >= 20) out.push(obj.sessionToken.trim());
      ['user', 'auth', 'client', 'employee'].forEach((k) => {
        if (obj[k]) dig(obj[k], depth + 1);
      });
      Object.keys(obj).forEach((k) => {
        if (!['user', 'auth', 'client', 'employee', '_persist'].includes(k) && obj[k] && typeof obj[k] === 'object') dig(obj[k], depth + 1);
      });
    };
    dig(parsed, 0);
    return out;
  } catch (_) {}
  return [];
}

function getGistStoredValue(storage, key) {
  try {
    const val = storage.getItem(key);
    if (!val || typeof val !== 'string') return null;
    const s = val.trim();
    if (!s.length) return null;
    const parsed = JSON.parse(s);
    if (!parsed || typeof parsed !== 'object') return null;
    const v = parsed.value;
    if (typeof v === 'string') {
      const t = v.trim();
      if (t.length > 0) return t;
    }
  } catch (_) {}
  return null;
}

function getTokenFromStorage() {
  const storages = [localStorage, sessionStorage];
  try {
    for (const storage of storages) {
      const sessionId = getGistStoredValue(storage, 'gist.web.sessionId');
      if (sessionId) return sessionId;
    }
    for (const storage of storages) {
      const userToken = getGistStoredValue(storage, 'gist.web.userToken');
      if (userToken) return userToken;
    }
    for (const storage of storages) {
      for (const key of TOKEN_KEYS) {
        const val = storage.getItem(key);
        const token = extractTokenFromValue(val);
        if (token) return token;
      }
    }
    for (const storage of storages) {
      for (let i = 0; i < storage.length; i++) {
        const key = storage.key(i);
        const val = storage.getItem(key);
        if (AUTH_KEY_HINT.test(key)) {
          const token = extractTokenFromValue(val);
          if (token) return token;
        }
      }
    }
    for (const storage of storages) {
      for (let i = 0; i < storage.length; i++) {
        const key = storage.key(i);
        const val = storage.getItem(key);
        const token = extractTokenFromValue(val);
        if (token) return token;
      }
    }
    const fromCookies = getTokenFromCookies();
    if (fromCookies) return fromCookies;
  } catch (e) {
    console.warn('[Chrysalis] Storage access error:', e);
  }
  return null;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function looksLikeApiToken(token) {
  if (!token || typeof token !== 'string') return false;
  const t = token.trim();
  if (UUID_PATTERN.test(t)) return false;
  if (t.length >= 50 && t.length <= 80 && /^[a-fA-F0-9\/\-]+$/.test(t)) return true;
  return false;
}

function getAllTokenCandidates() {
  const seen = new Set();
  const out = [];
  const storages = [localStorage, sessionStorage];
  for (const storage of storages) {
    const userToken = getGistStoredValue(storage, 'gist.web.userToken');
    if (userToken && !seen.has(userToken)) {
      seen.add(userToken);
      out.push({ token: userToken, source: 'gist.web.userToken' });
    }
    const sessionId = getGistStoredValue(storage, 'gist.web.sessionId');
    if (sessionId && !seen.has(sessionId)) {
      seen.add(sessionId);
      out.push({ token: sessionId, source: 'gist.web.sessionId' });
    }
    const persistTokens = getTokenFromPersistRoot(storage);
    persistTokens.forEach((t) => {
      if (t && !seen.has(t)) {
        seen.add(t);
        out.push({ token: t, source: 'persist:root' });
      }
    });
  }
  out.sort((a, b) => {
    const aApi = looksLikeApiToken(a.token) ? 1 : 0;
    const bApi = looksLikeApiToken(b.token) ? 1 : 0;
    if (aApi !== bApi) return bApi - aApi;
    const aUuid = UUID_PATTERN.test(a.token.trim()) ? 1 : 0;
    const bUuid = UUID_PATTERN.test(b.token.trim()) ? 1 : 0;
    return aUuid - bUuid;
  });
  return out;
}

function getStoredAuthFormat() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['monarchAuthPrefix', 'monarchAuthTokenLength'], (v) => {
      resolve({
        prefix: v.monarchAuthPrefix || null,
        tokenLength: v.monarchAuthTokenLength != null ? v.monarchAuthTokenLength : null,
      });
    });
  });
}

async function graphqlRequestWithAuth(query, variables = {}) {
  const candidates = getAllTokenCandidates();
  if (!candidates.length) return { error: 'No Monarch token found' };

  const stored = await getStoredAuthFormat();
  const prefixes = stored.prefix ? [stored.prefix.replace(/\s+$/, '')] : ['Token', 'Bearer'];
  const tryTokens = stored.tokenLength != null
    ? [...candidates].sort((a, b) => {
        const da = Math.abs(a.token.length - stored.tokenLength);
        const db = Math.abs(b.token.length - stored.tokenLength);
        return da - db;
      })
    : candidates;

  for (const { token } of tryTokens) {
    for (const p of prefixes) {
      const prefix = p.includes(' ') ? p : p + ' ';
      const authHeader = `${prefix}${token}`;
      for (const graphqlUrl of [MONARCH_GRAPHQL, MONARCH_GRAPHQL_LEGACY]) {
        let res;
        try {
          res = await fetchWithTimeout(
            graphqlUrl,
            {
              method: 'POST',
              credentials: 'include',
              headers: buildMonarchHeaders(authHeader),
              body: JSON.stringify({ query, variables }),
            },
            FETCH_TIMEOUT_MS
          );
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
    }
  }
  return { error: 'All auth combinations returned 401. Monarch may have changed how they authenticate.' };
}

async function graphqlRequest(token, query, variables = {}) {
  const res = await fetch(MONARCH_GRAPHQL, {
    method: 'POST',
    credentials: 'include',
    headers: buildMonarchHeaders(`Token ${token}`),
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  const json = await res.json();
  if (json.errors && json.errors.length) {
    throw new Error(json.errors.map((e) => e.message).join('; '));
  }
  return json.data;
}

const GET_ACCOUNTS_QUERY = `
query GetAccounts {
  accounts {
    id
    displayName
    currentBalance
    type { name }
    isHidden
  }
}
`;

function parseBalance(displayBalance) {
  if (displayBalance == null) return 0;
  if (typeof displayBalance === 'number' && !Number.isNaN(displayBalance)) return displayBalance;
  const s = String(displayBalance).replace(/[$,]/g, '').trim();
  const n = parseFloat(s);
  return Number.isNaN(n) ? 0 : n;
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
          displayBalance: node.currentBalance != null ? node.currentBalance : node.displayBalance,
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
      const balanceVal = (node) => node.currentBalance != null ? node.currentBalance : node.displayBalance;
      const accounts = visible
        .filter((node) => idSet.has(node.id))
        .map((node) => ({
          id: node.id,
          name: node.displayName || node.id,
          balance: parseBalance(balanceVal(node)),
        }));
      return { success: true, accounts };
    }

    return null;
  };

  handle().then(sendResponse);
  return true;
});

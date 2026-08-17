// Minimal OAuth 2.1 authorization server so MCP clients (claude.ai custom
// connectors, Claude Desktop, etc.) can connect with their standard OAuth flow
// instead of a hand-configured header.
//
// Single-operator model: the "login" on the consent screen is the server's
// access key (MCP_AUTH_TOKEN). Everything is stateless - client ids, auth
// codes, and tokens are HMAC-signed blobs, so no storage is needed.
//
// (Note: this is the MCP-client-facing auth. It is unrelated to the Genesys
// OAuth client credentials the Worker uses to reach the Platform API.)

const enc = new TextEncoder();

function bytesToB64url(bytes) {
  const arr = new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlToString(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return atob(s);
}

async function hmac(secret, data) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return bytesToB64url(await crypto.subtle.sign('HMAC', key, enc.encode(data)));
}

async function mint(secret, payload) {
  const data = bytesToB64url(enc.encode(JSON.stringify(payload)));
  return `${data}.${await hmac(secret, data)}`;
}

async function read(secret, token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [data, sig] = token.split('.');
  if (!data || !sig || (await hmac(secret, data)) !== sig) return null;
  try {
    const payload = JSON.parse(b64urlToString(data));
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch { return null; }
}

async function sha256b64url(s) {
  return bytesToB64url(await crypto.subtle.digest('SHA-256', enc.encode(s)));
}

const now = () => Math.floor(Date.now() / 1000);
const ACCESS_TTL = 30 * 24 * 3600;   // 30 days
const REFRESH_TTL = 180 * 24 * 3600; // 180 days

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

// True if the request may use the MCP endpoint. `accessKey` is the server's
// configured access key (from env or KV - see config.js).
export async function checkAuth(request, accessKey) {
  if (!accessKey) return true; // auth not configured - open server
  const header = request.headers.get('Authorization') || '';
  if (!header.startsWith('Bearer ')) return false;
  const presented = header.slice(7).trim();
  if (presented === accessKey) return true; // raw access key still works
  const payload = await read(accessKey, presented);
  return payload?.t === 'a';
}

export function unauthorized(origin) {
  return new Response(JSON.stringify({ error: 'Unauthorized' }), {
    status: 401,
    headers: {
      'Content-Type': 'application/json',
      'WWW-Authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
    },
  });
}

// Routes any OAuth-related path; returns null if the path isn't ours.
export async function handleOAuth(request, accessKey, url) {
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const origin = url.origin;

  if (path.startsWith('/.well-known/oauth-authorization-server')) {
    return json({
      issuer: origin,
      authorization_endpoint: `${origin}/authorize`,
      token_endpoint: `${origin}/token`,
      registration_endpoint: `${origin}/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: ['genesys'],
    });
  }

  if (path.startsWith('/.well-known/oauth-protected-resource')) {
    return json({
      resource: `${origin}/mcp`,
      authorization_servers: [origin],
      bearer_methods_supported: ['header'],
      scopes_supported: ['genesys'],
    });
  }

  if (path === '/register' && request.method === 'POST') {
    let body;
    try { body = await request.json(); } catch { return json({ error: 'invalid_client_metadata' }, 400); }
    const redirectUris = Array.isArray(body.redirect_uris) ? body.redirect_uris.filter((u) => typeof u === 'string') : [];
    if (!redirectUris.length) return json({ error: 'invalid_redirect_uri' }, 400);
    if (!accessKey) return json({ error: 'server_not_configured', error_description: 'MCP_AUTH_TOKEN is not set on this Worker.' }, 500);
    const clientId = await mint(accessKey, { t: 'client', r: redirectUris });
    return json({
      client_id: clientId,
      redirect_uris: redirectUris,
      client_name: body.client_name || 'MCP client',
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    }, 201);
  }

  if (path === '/authorize' && request.method === 'GET') {
    const q = url.searchParams;
    const client = await read(accessKey || '', q.get('client_id'));
    const redirectUri = q.get('redirect_uri') || '';
    if (!accessKey) return authPage({ error: 'This server has no MCP_AUTH_TOKEN configured - the operator must set one before OAuth can be used.' });
    if (client?.t !== 'client' || !client.r.includes(redirectUri)) {
      return authPage({ error: 'Unknown client or redirect URI. Re-add the connector so it re-registers.' });
    }
    if (q.get('response_type') !== 'code' || !q.get('code_challenge') || q.get('code_challenge_method') !== 'S256') {
      return authPage({ error: 'This server requires response_type=code with S256 PKCE.' });
    }
    return authPage({
      clientId: q.get('client_id'),
      redirectUri,
      state: q.get('state') || '',
      codeChallenge: q.get('code_challenge'),
    });
  }

  if (path === '/authorize' && request.method === 'POST') {
    const form = await request.formData();
    const key = form.get('access_key') || '';
    const clientId = form.get('client_id') || '';
    const redirectUri = form.get('redirect_uri') || '';
    const state = form.get('state') || '';
    const codeChallenge = form.get('code_challenge') || '';
    const client = await read(accessKey || '', clientId);
    if (!accessKey || client?.t !== 'client' || !client.r.includes(redirectUri) || !codeChallenge) {
      return authPage({ error: 'Invalid authorization request. Re-add the connector and try again.' });
    }
    if (key !== accessKey) {
      return authPage({ clientId, redirectUri, state, codeChallenge, error: 'Wrong access key - check with the operator of this server.' });
    }
    const code = await mint(accessKey, { t: 'code', ru: redirectUri, cc: codeChallenge, exp: now() + 600 });
    const sep = redirectUri.includes('?') ? '&' : '?';
    const location = `${redirectUri}${sep}code=${encodeURIComponent(code)}${state ? `&state=${encodeURIComponent(state)}` : ''}`;
    return new Response(null, { status: 302, headers: { Location: location } });
  }

  if (path === '/token' && request.method === 'POST') {
    if (!accessKey) return json({ error: 'server_error' }, 500);
    const form = await request.formData();
    const grantType = form.get('grant_type');

    if (grantType === 'authorization_code') {
      const code = await read(accessKey, form.get('code'));
      if (code?.t !== 'code') return json({ error: 'invalid_grant' }, 400);
      const redirectUri = form.get('redirect_uri');
      if (redirectUri && redirectUri !== code.ru) return json({ error: 'invalid_grant' }, 400);
      const verifier = form.get('code_verifier') || '';
      if (!verifier || (await sha256b64url(verifier)) !== code.cc) return json({ error: 'invalid_grant', error_description: 'PKCE verification failed' }, 400);
      return json(await issueTokens(accessKey));
    }

    if (grantType === 'refresh_token') {
      const refresh = await read(accessKey, form.get('refresh_token'));
      if (refresh?.t !== 'r') return json({ error: 'invalid_grant' }, 400);
      return json(await issueTokens(accessKey));
    }

    return json({ error: 'unsupported_grant_type' }, 400);
  }

  return null;
}

async function issueTokens(accessKey) {
  return {
    access_token: await mint(accessKey, { t: 'a', exp: now() + ACCESS_TTL }),
    token_type: 'Bearer',
    expires_in: ACCESS_TTL,
    refresh_token: await mint(accessKey, { t: 'r', exp: now() + REFRESH_TTL }),
    scope: 'genesys',
  };
}

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function authPage({ clientId, redirectUri, state, codeChallenge, error }) {
  const form = clientId ? `
  <form method="POST" action="/authorize">
    <input type="hidden" name="client_id" value="${esc(clientId)}">
    <input type="hidden" name="redirect_uri" value="${esc(redirectUri)}">
    <input type="hidden" name="state" value="${esc(state)}">
    <input type="hidden" name="code_challenge" value="${esc(codeChallenge)}">
    <label for="access_key">Access key</label>
    <input type="password" id="access_key" name="access_key" autofocus autocomplete="current-password" placeholder="Paste the server access key">
    <button type="submit">Authorize</button>
  </form>` : '';
  return new Response(`<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Authorize · genesys-mcp</title>
<style>
  body{font-family:ui-sans-serif,system-ui,sans-serif;max-width:420px;margin:14vh auto;padding:0 1.25rem;line-height:1.55;color:#1a2332}
  h1{font-size:1.35rem;letter-spacing:-.02em}
  .err{background:#fde8e8;color:#9b1c1c;border-radius:8px;padding:.6rem .8rem;margin:1rem 0;font-size:.92rem}
  label{display:block;font-size:.85rem;font-weight:600;margin:1.2rem 0 .3rem}
  input[type=password]{width:100%;box-sizing:border-box;padding:.6rem .7rem;border:1px solid #cbd5e1;border-radius:8px;font-size:1rem}
  button{margin-top:1rem;width:100%;padding:.65rem;border:0;border-radius:8px;background:#ea580c;color:#fff;font-size:1rem;font-weight:600;cursor:pointer}
  button:hover{background:#c2410c}
  p{color:#5b6779;font-size:.92rem}
  @media (prefers-color-scheme:dark){body{background:#0f141b;color:#dbe2ea}input[type=password]{background:#1e2733;border-color:#334155;color:#dbe2ea}p{color:#93a1b3}.err{background:#3b1219;color:#f6b1b1}}
</style></head><body>
<h1>🔐 genesys-mcp</h1>
<p>An AI client is asking for access to this Genesys Cloud MCP server. Enter the server's access key to authorize it.</p>
${error ? `<div class="err">${esc(error)}</div>` : ''}
${form}
</body></html>`, { status: error && !clientId ? 400 : 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

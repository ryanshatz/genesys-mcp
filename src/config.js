// Configuration resolution. Two sources, env wins:
//   1. Wrangler secrets / vars (GENESYS_CLIENT_ID, GENESYS_CLIENT_SECRET,
//      GENESYS_REGION, MCP_AUTH_TOKEN)
//   2. The KV-stored config written by the in-browser setup wizard (/setup)

const KV_KEY = 'genesys-config';

export async function loadConfig(env) {
  let stored = null;
  if (env.CONFIG) {
    try { stored = await env.CONFIG.get(KV_KEY, 'json'); } catch { /* KV unavailable */ }
  }
  const envManaged = Boolean(env.GENESYS_CLIENT_ID || env.GENESYS_CLIENT_SECRET);
  const cfg = {
    clientId: env.GENESYS_CLIENT_ID || stored?.clientId || '',
    clientSecret: env.GENESYS_CLIENT_SECRET || stored?.clientSecret || '',
    region: (envManaged ? env.GENESYS_REGION : stored?.region) || env.GENESYS_REGION || 'mypurecloud.com',
    authToken: env.MCP_AUTH_TOKEN || stored?.authToken || '',
    source: envManaged ? 'env' : (stored ? 'kv' : 'none'),
    hasKv: Boolean(env.CONFIG),
  };
  cfg.configured = Boolean(cfg.clientId && cfg.clientSecret);
  return cfg;
}

export async function saveConfig(env, { clientId, clientSecret, region, authToken }) {
  await env.CONFIG.put(KV_KEY, JSON.stringify({ clientId, clientSecret, region, authToken }));
}

export function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// MCP tool definitions + dispatch. Each tool maps to one or two Genesys Cloud
// Platform API calls and returns plain JSON for the model.
//
// Scope is deliberate: config reads + create/build actions. NO analytics/KPI
// tools and NO contact-list management - see about.js for why.

import { GenesysClient, GenesysError, REGIONS } from './genesys.js';
import { ABOUT } from './about.js';

// ---------- name → object resolution helpers ----------

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function resolveOne(gc, kind, path, ref, query = {}) {
  if (GUID_RE.test(ref)) return { id: ref };
  const { entities } = await gc.listAll(path, { ...query, name: ref }, { max: 50 });
  let matches = entities.filter((e) => e.name?.toLowerCase() === ref.toLowerCase());
  if (!matches.length) {
    const { entities: wide } = await gc.listAll(path, { ...query, name: `*${ref}*` }, { max: 50 });
    matches = wide;
  }
  if (!matches.length) throw new GenesysError(`No ${kind} found matching "${ref}"`, 404);
  if (matches.length > 1) {
    throw new GenesysError(
      `Ambiguous ${kind} "${ref}" - matches: ${matches.map((m) => m.name).join(', ')}. Use the exact name or id.`, 409);
  }
  return matches[0];
}

async function resolveUser(gc, ref) {
  if (GUID_RE.test(ref)) return { id: ref };
  const res = await gc.post('/api/v2/users/search', {
    query: [{ fields: ['email', 'name'], value: ref, type: 'CONTAINS' }],
    pageSize: 25,
  });
  const results = res.results || [];
  const exact = results.filter((u) => u.email?.toLowerCase() === ref.toLowerCase() || u.name?.toLowerCase() === ref.toLowerCase());
  const matches = exact.length ? exact : results;
  if (!matches.length) throw new GenesysError(`No user found matching "${ref}"`, 404);
  if (matches.length > 1) {
    throw new GenesysError(
      `Ambiguous user "${ref}" - matches: ${matches.map((u) => `${u.name} <${u.email}>`).join(', ')}. Use the email or id.`, 409);
  }
  return matches[0];
}

const slim = (e) => ({ id: e.id, name: e.name, ...(e.email ? { email: e.email } : {}), ...(e.state && e.state !== 'active' ? { state: e.state } : {}) });

// ---------- tools ----------

export const TOOLS = [
  {
    name: 'about',
    description: 'Who operates this server, why it exists, and the ground rules. Call this when you need context about the operator or how to behave.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    genesys: false,
    handler: () => ABOUT,
  },
  {
    name: 'check_connection',
    description: 'Verify that the Worker can authenticate to Genesys Cloud. Returns the org name, region, and object counts (queues, users, flows). Run this first if other tools are failing.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async (gc) => {
      const org = await gc.get('/api/v2/organizations/me');
      const [queues, users, flows] = await Promise.all([
        gc.get('/api/v2/routing/queues', { pageSize: 1 }),
        gc.get('/api/v2/users', { pageSize: 1, state: 'any' }),
        gc.get('/api/v2/flows', { pageSize: 1 }),
      ]);
      return {
        ok: true, org: org.name, orgId: org.id, region: gc.region,
        counts: { queues: queues.total, users: users.total, flows: flows.total },
      };
    },
  },

  // ----- queues & routing -----
  {
    name: 'list_queues',
    description: 'List routing queues (name, id, division). Optional name_filter supports * wildcards (e.g. "*support*").',
    inputSchema: {
      type: 'object',
      properties: { name_filter: { type: 'string', description: 'Queue name filter, * wildcards allowed' } },
      additionalProperties: false,
    },
    handler: async (gc, a) => {
      const r = await gc.listAll('/api/v2/routing/queues', a.name_filter ? { name: a.name_filter } : {});
      return { total: r.total, truncated: r.truncated, queues: r.entities.map((q) => ({ ...slim(q), division: q.division?.name, memberCount: q.memberCount })) };
    },
  },
  {
    name: 'get_queue',
    description: 'Get a queue\'s full configuration (media settings, ACW, routing rules, division) by name or id.',
    inputSchema: {
      type: 'object',
      properties: { queue: { type: 'string', description: 'Queue name or id' } },
      required: ['queue'],
      additionalProperties: false,
    },
    handler: async (gc, a) => gc.get(`/api/v2/routing/queues/${(await resolveOne(gc, 'queue', '/api/v2/routing/queues', a.queue)).id}`),
  },
  {
    name: 'create_queue',
    description: 'Create a new routing queue. Only name is required; Genesys applies sensible media-setting defaults. Optionally set description, division (name or id), and ACW settings.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        description: { type: 'string' },
        division: { type: 'string', description: 'Division name or id (defaults to Home)' },
        acw_wrapup_prompt: { type: 'string', enum: ['MANDATORY', 'OPTIONAL', 'MANDATORY_TIMEOUT', 'MANDATORY_FORCED_TIMEOUT', 'AGENT_REQUESTED'], description: 'After-call-work mode' },
        acw_timeout_ms: { type: 'number', description: 'ACW timeout in ms (for the timeout modes)' },
      },
      required: ['name'],
      additionalProperties: false,
    },
    handler: async (gc, a) => {
      const body = { name: a.name };
      if (a.description) body.description = a.description;
      if (a.division) body.division = { id: (await resolveOne(gc, 'division', '/api/v2/authorization/divisions', a.division)).id };
      if (a.acw_wrapup_prompt) body.acwSettings = { wrapupPrompt: a.acw_wrapup_prompt, ...(a.acw_timeout_ms ? { timeoutMs: a.acw_timeout_ms } : {}) };
      const q = await gc.post('/api/v2/routing/queues', body);
      return { created: true, id: q.id, name: q.name, division: q.division?.name };
    },
  },
  {
    name: 'list_wrapup_codes',
    description: 'List wrap-up (disposition) codes.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async (gc) => {
      const r = await gc.listAll('/api/v2/routing/wrapupcodes');
      return { total: r.total, wrapupCodes: r.entities.map(slim) };
    },
  },
  {
    name: 'create_wrapup_code',
    description: 'Create a wrap-up (disposition) code.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' }, description: { type: 'string' } },
      required: ['name'],
      additionalProperties: false,
    },
    handler: async (gc, a) => {
      const w = await gc.post('/api/v2/routing/wrapupcodes', { name: a.name, ...(a.description ? { description: a.description } : {}) });
      return { created: true, id: w.id, name: w.name };
    },
  },

  // ----- users & skills -----
  {
    name: 'list_users',
    description: 'List users (name, email, state, title). Optional search matches name or email.',
    inputSchema: {
      type: 'object',
      properties: { search: { type: 'string', description: 'Substring of name or email' } },
      additionalProperties: false,
    },
    handler: async (gc, a) => {
      if (a.search) {
        const res = await gc.post('/api/v2/users/search', { query: [{ fields: ['name', 'email'], value: a.search, type: 'CONTAINS' }], pageSize: 100 });
        return { total: res.total, users: (res.results || []).map((u) => ({ ...slim(u), title: u.title })) };
      }
      const r = await gc.listAll('/api/v2/users', { state: 'active' });
      return { total: r.total, truncated: r.truncated, users: r.entities.map((u) => ({ ...slim(u), title: u.title })) };
    },
  },
  {
    name: 'get_user',
    description: 'Get a user\'s profile and routing skills by email, name, or id.',
    inputSchema: {
      type: 'object',
      properties: { user: { type: 'string', description: 'Email, name, or id' } },
      required: ['user'],
      additionalProperties: false,
    },
    handler: async (gc, a) => {
      const { id } = await resolveUser(gc, a.user);
      const [u, skills] = await Promise.all([
        gc.get(`/api/v2/users/${id}`),
        gc.listAll(`/api/v2/users/${id}/routingskills`),
      ]);
      return {
        id: u.id, name: u.name, email: u.email, state: u.state, title: u.title,
        division: u.division?.name,
        skills: skills.entities.map((s) => ({ name: s.name, proficiency: s.proficiency })),
      };
    },
  },
  {
    name: 'list_skills',
    description: 'List ACD routing skills.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async (gc) => {
      const r = await gc.listAll('/api/v2/routing/skills');
      return { total: r.total, skills: r.entities.map(slim) };
    },
  },
  {
    name: 'create_skill',
    description: 'Create an ACD routing skill.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
      additionalProperties: false,
    },
    handler: async (gc, a) => {
      const s = await gc.post('/api/v2/routing/skills', { name: a.name });
      return { created: true, id: s.id, name: s.name };
    },
  },
  {
    name: 'assign_user_skill',
    description: 'Assign a routing skill to a user (or update their proficiency, 0-5). Additive only - it does not remove skills.',
    inputSchema: {
      type: 'object',
      properties: {
        user: { type: 'string', description: 'Email, name, or id' },
        skill: { type: 'string', description: 'Skill name or id' },
        proficiency: { type: 'number', description: '0-5 (default 3)' },
      },
      required: ['user', 'skill'],
      additionalProperties: false,
    },
    handler: async (gc, a) => {
      const [user, skill] = await Promise.all([
        resolveUser(gc, a.user),
        resolveOne(gc, 'skill', '/api/v2/routing/skills', a.skill),
      ]);
      const r = await gc.post(`/api/v2/users/${user.id}/routingskills`, { id: skill.id, proficiency: a.proficiency ?? 3 });
      return { assigned: true, user: user.name || user.id, skill: r.name, proficiency: r.proficiency };
    },
  },

  // ----- flows (Architect) -----
  {
    name: 'list_flows',
    description: 'List Architect flows (name, type, published state). Optional type filter, e.g. inboundcall, inboundchat, inboundemail, bot, digitalbot, workflow.',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', description: 'Flow type filter (e.g. "inboundcall")' },
        name_filter: { type: 'string', description: 'Flow name filter, * wildcards allowed' },
      },
      additionalProperties: false,
    },
    handler: async (gc, a) => {
      const query = {};
      if (a.type) query.type = a.type;
      if (a.name_filter) query.name = a.name_filter;
      const r = await gc.listAll('/api/v2/flows', query);
      return {
        total: r.total, truncated: r.truncated,
        flows: r.entities.map((f) => ({
          id: f.id, name: f.name, type: f.type, division: f.division?.name,
          published: Boolean(f.publishedVersion), publishedVersion: f.publishedVersion?.id,
          checkedInVersion: f.checkedInVersion?.id, active: f.active,
        })),
      };
    },
  },
  {
    name: 'get_flow',
    description: 'Get a flow\'s metadata (type, versions, division, description) by name or id.',
    inputSchema: {
      type: 'object',
      properties: { flow: { type: 'string', description: 'Flow name or id' } },
      required: ['flow'],
      additionalProperties: false,
    },
    handler: async (gc, a) => gc.get(`/api/v2/flows/${(await resolveOne(gc, 'flow', '/api/v2/flows', a.flow)).id}`),
  },
  {
    name: 'get_flow_configuration',
    description: 'Get a flow\'s latest full configuration JSON (the actual flow logic: actions, menus, transfers). Large output - use for inspecting or rendering a specific flow.',
    inputSchema: {
      type: 'object',
      properties: { flow: { type: 'string', description: 'Flow name or id' } },
      required: ['flow'],
      additionalProperties: false,
    },
    handler: async (gc, a) => gc.get(`/api/v2/flows/${(await resolveOne(gc, 'flow', '/api/v2/flows', a.flow)).id}/latestconfiguration`),
  },
  {
    name: 'list_prompts',
    description: 'List Architect user prompts (reusable audio/TTS prompts).',
    inputSchema: {
      type: 'object',
      properties: { name_filter: { type: 'string', description: 'Prompt name filter' } },
      additionalProperties: false,
    },
    handler: async (gc, a) => {
      const r = await gc.listAll('/api/v2/architect/prompts', a.name_filter ? { name: a.name_filter } : {});
      return { total: r.total, prompts: r.entities.map((p) => ({ id: p.id, name: p.name, description: p.description })) };
    },
  },

  // ----- org & telephony -----
  {
    name: 'list_divisions',
    description: 'List authorization divisions.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async (gc) => {
      const r = await gc.listAll('/api/v2/authorization/divisions');
      return { total: r.total, divisions: r.entities.map((d) => ({ id: d.id, name: d.name, home: d.homeDivision })) };
    },
  },
  {
    name: 'list_did_pools',
    description: 'List DID number pools (phone number ranges available in the org).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async (gc) => {
      const r = await gc.listAll('/api/v2/telephony/providers/edges/didpools');
      return { total: r.total, didPools: r.entities.map((p) => ({ id: p.id, startPhoneNumber: p.startPhoneNumber, endPhoneNumber: p.endPhoneNumber, provider: p.provider })) };
    },
  },

  // ----- power tool -----
  {
    name: 'genesys_api_call',
    description: 'Call any Genesys Cloud Platform API endpoint directly (for endpoints without a typed tool). GET/POST/PUT/PATCH only - DELETE is refused by design. Treat any non-GET call as a write: describe the method, path, and body and confirm with the user first.',
    inputSchema: {
      type: 'object',
      properties: {
        method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH'] },
        path: { type: 'string', description: 'API path starting with /api/v2/, e.g. /api/v2/routing/queues' },
        query: { type: 'object', description: 'Query string parameters', additionalProperties: true },
        body: { type: 'object', description: 'JSON body for POST/PUT/PATCH', additionalProperties: true },
      },
      required: ['method', 'path'],
      additionalProperties: false,
    },
    handler: async (gc, a) => {
      if (!/^\/api\/v2\//.test(a.path)) throw new GenesysError('path must start with /api/v2/', 400);
      return gc.api(a.method, a.path, { body: a.body, query: a.query });
    },
  },
];

// ---------- registry plumbing ----------

export function toolDefs() {
  return TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
}

export async function callTool(cfg, name, args = {}) {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) throw new Error(`Unknown tool: ${name}`);
  if (tool.genesys === false) return tool.handler(null, args);
  if (!cfg.configured) {
    throw new GenesysError('This server is not connected to Genesys Cloud yet - open /setup, or set the GENESYS_CLIENT_ID / GENESYS_CLIENT_SECRET / GENESYS_REGION secrets.', 503);
  }
  const gc = new GenesysClient(cfg);
  return tool.handler(gc, args);
}

// UI metadata - which tools are writes, and how they group on the landing page.
export const WRITE_TOOLS = new Set([
  'create_queue', 'create_wrapup_code', 'create_skill', 'assign_user_skill', 'genesys_api_call',
]);

export const TOOL_GROUPS = [
  { name: 'Org & Connection', icon: '🔌', tools: ['about', 'check_connection', 'list_divisions', 'list_did_pools'] },
  { name: 'Queues & Routing', icon: '📞', tools: ['list_queues', 'get_queue', 'create_queue', 'list_wrapup_codes', 'create_wrapup_code'] },
  { name: 'Users & Skills', icon: '👥', tools: ['list_users', 'get_user', 'list_skills', 'create_skill', 'assign_user_skill'] },
  { name: 'Flows (Architect)', icon: '🌳', tools: ['list_flows', 'get_flow', 'get_flow_configuration', 'list_prompts'] },
  { name: 'Power', icon: '⚡', tools: ['genesys_api_call'] },
];

export { REGIONS };

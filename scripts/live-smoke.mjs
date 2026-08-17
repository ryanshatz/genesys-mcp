// Live smoke test: drives the real MCP tool handlers against the Genesys org
// configured in .dev.vars. READ tools only by default; pass --writes to also
// exercise create tools (they create MCP_Test_* artifacts).
//
//   node scripts/live-smoke.mjs
//   node scripts/live-smoke.mjs --writes
import { readFileSync } from 'node:fs';
import { callTool } from '../src/tools.js';

const vars = Object.fromEntries(
  readFileSync(new URL('../.dev.vars', import.meta.url), 'utf8')
    .split('\n').filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()])
);

const cfg = {
  clientId: vars.GENESYS_CLIENT_ID,
  clientSecret: vars.GENESYS_CLIENT_SECRET,
  region: vars.GENESYS_REGION || 'mypurecloud.com',
  configured: true,
};
if (!cfg.clientId || !cfg.clientSecret) {
  console.error('Missing GENESYS_CLIENT_ID / GENESYS_CLIENT_SECRET in .dev.vars');
  process.exit(1);
}

const runWrites = process.argv.includes('--writes');
let pass = 0, fail = 0;

async function run(name, args = {}, show = (r) => r) {
  try {
    const r = await callTool(cfg, name, args);
    const summary = JSON.stringify(show(r));
    console.log(`✅ ${name} ${summary.length > 220 ? summary.slice(0, 220) + '…' : summary}`);
    pass++;
    return r;
  } catch (e) {
    console.log(`❌ ${name} - ${e.message}`);
    fail++;
    return null;
  }
}

console.log(`- read tools against region ${cfg.region} -`);
await run('check_connection');
await run('list_queues', {}, (r) => ({ total: r.total, first: r.queues[0]?.name }));
await run('list_users', {}, (r) => ({ total: r.total, first: r.users[0]?.name }));
await run('list_users', { search: 'ryan@outboundani.com' }, (r) => r.users.map((u) => u.email));
await run('get_user', { user: 'ryan@outboundani.com' }, (r) => ({ name: r.name, skills: r.skills }));
await run('list_skills', {}, (r) => ({ total: r.total }));
await run('list_wrapup_codes', {}, (r) => ({ total: r.total, names: r.wrapupCodes.map((w) => w.name) }));
await run('list_flows', {}, (r) => ({ total: r.total, types: [...new Set(r.flows.map((f) => f.type))] }));
await run('list_divisions', {}, (r) => ({ total: r.total, names: r.divisions.map((d) => d.name) }));
await run('list_prompts', {}, (r) => ({ total: r.total }));
await run('list_did_pools', {}, (r) => ({ total: r.total }));
await run('genesys_api_call', { method: 'GET', path: '/api/v2/telephony/providers/edges/dids', query: { pageSize: 3 } }, (r) => ({ total: r.total }));

const flows = await run('list_queues', { name_filter: '*' }, (r) => ({ total: r.total }));

if (runWrites) {
  console.log('- write tools (MCP_Test_* artifacts) -');
  const stamp = Date.now().toString(36);
  await run('create_skill', { name: `MCP_Test_Skill_${stamp}` });
  await run('create_wrapup_code', { name: `MCP_Test_Wrapup_${stamp}` });
  await run('create_queue', { name: `MCP_Test_Queue_${stamp}`, description: 'genesys-mcp smoke test - safe to delete' });
  console.log('NOTE: artifacts left in place - clean up via the UI or genesys_api_call once verified.');
}

console.log(`\n${pass} passed, ${fail} failed${runWrites ? ' (writes exercised)' : ''}`);
process.exit(fail ? 1 : 0);

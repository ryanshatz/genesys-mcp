import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRegion, GenesysClient, GenesysError, REGIONS } from '../src/genesys.js';
import { TOOLS, toolDefs, callTool, WRITE_TOOLS, TOOL_GROUPS } from '../src/tools.js';

test('normalizeRegion accepts full domains, shorthands, and host prefixes', () => {
  assert.equal(normalizeRegion('usw2.pure.cloud'), 'usw2.pure.cloud');
  assert.equal(normalizeRegion('usw2'), 'usw2.pure.cloud');
  assert.equal(normalizeRegion('login.usw2.pure.cloud'), 'usw2.pure.cloud');
  assert.equal(normalizeRegion('https://api.mypurecloud.ie/'), 'mypurecloud.ie');
  assert.equal(normalizeRegion('mypurecloud.com'), 'mypurecloud.com');
  assert.equal(normalizeRegion(''), 'mypurecloud.com');
  assert.equal(normalizeRegion(undefined), 'mypurecloud.com');
});

test('client derives login and api hosts from region', () => {
  const gc = new GenesysClient({ clientId: 'x', clientSecret: 'y', region: 'usw2' });
  assert.equal(gc.loginUrl, 'https://login.usw2.pure.cloud');
  assert.equal(gc.apiUrl, 'https://api.usw2.pure.cloud');
});

test('api() rejects non-/api/ paths without touching the network', async () => {
  const gc = new GenesysClient({ clientId: 'x', clientSecret: 'y', region: 'usw2' });
  await assert.rejects(() => gc.api('GET', '/oauth/token'), GenesysError);
  await assert.rejects(() => gc.api('GET', 'api/v2/users'), GenesysError);
});

test('tool definitions are well-formed and unique', () => {
  const defs = toolDefs();
  const names = defs.map((t) => t.name);
  assert.equal(new Set(names).size, names.length, 'tool names must be unique');
  for (const t of defs) {
    assert.ok(t.name && t.description, `${t.name}: needs name+description`);
    assert.equal(t.inputSchema.type, 'object', `${t.name}: schema must be object`);
    assert.equal(t.inputSchema.additionalProperties, false, `${t.name}: schema must close additionalProperties`);
  }
});

test('UI metadata references real tools', () => {
  const names = new Set(TOOLS.map((t) => t.name));
  for (const w of WRITE_TOOLS) assert.ok(names.has(w), `WRITE_TOOLS references unknown tool ${w}`);
  for (const g of TOOL_GROUPS) for (const t of g.tools) assert.ok(names.has(t), `group ${g.name} references unknown tool ${t}`);
});

test('no delete tools ship, and genesys_api_call schema refuses DELETE', () => {
  for (const t of TOOLS) assert.ok(!/delete/i.test(t.name), `unexpected delete tool: ${t.name}`);
  const power = TOOLS.find((t) => t.name === 'genesys_api_call');
  assert.deepEqual(power.inputSchema.properties.method.enum, ['GET', 'POST', 'PUT', 'PATCH']);
});

test('callTool: about works unconfigured; API tools demand config', async () => {
  const about = await callTool({ configured: false }, 'about');
  assert.match(about, /outboundIQ/);
  await assert.rejects(() => callTool({ configured: false }, 'list_queues'), /not connected/);
  await assert.rejects(() => callTool({ configured: true, clientId: 'x', clientSecret: 'y', region: 'zz-bogus' }, 'nope_tool'), /Unknown tool/);
});

test('listAll paginates and respects the cap', async () => {
  const gc = new GenesysClient({ clientId: 'x', clientSecret: 'y', region: 'usw2' });
  gc.token = async () => 'fake';
  const realFetch = globalThis.fetch;
  const pages = {
    1: { entities: [{ id: 'a' }, { id: 'b' }], pageCount: 2, total: 3 },
    2: { entities: [{ id: 'c' }], pageCount: 2, total: 3 },
  };
  globalThis.fetch = async (url) => {
    const n = Number(new URL(url).searchParams.get('pageNumber'));
    return new Response(JSON.stringify(pages[n]), { status: 200 });
  };
  try {
    const all = await gc.listAll('/api/v2/things');
    assert.deepEqual(all.entities.map((e) => e.id), ['a', 'b', 'c']);
    assert.equal(all.total, 3);
    assert.equal(all.truncated, false);
    const capped = await gc.listAll('/api/v2/things', {}, { max: 2 });
    assert.deepEqual(capped.entities.map((e) => e.id), ['a', 'b']);
    assert.equal(capped.truncated, true);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('REGIONS list looks sane', () => {
  assert.ok(REGIONS.includes('mypurecloud.com'));
  assert.ok(REGIONS.includes('usw2.pure.cloud'));
  assert.ok(REGIONS.every((r) => !r.startsWith('login.') && !r.startsWith('api.')));
});

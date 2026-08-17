// End-to-end flow builder verification against the live org:
// build_flow -> publish_flow (flow jobs pipeline) -> get_flow_job ->
// list_flows -> export_flow -> render_flow (existing flow), plus
// assign_user_skill. Creates MCP_Test_* artifacts only.
import { readFileSync } from 'node:fs';
import { callTool } from '../src/tools.js';

const vars = Object.fromEntries(
  readFileSync(new URL('../.dev.vars', import.meta.url), 'utf8')
    .split('\n').filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()])
);
const cfg = { clientId: vars.GENESYS_CLIENT_ID, clientSecret: vars.GENESYS_CLIENT_SECRET, region: vars.GENESYS_REGION, configured: true };

const stamp = Date.now().toString(36);
const flowName = `MCP_Test_Flow_${stamp}`;
const spec = {
  name: flowName,
  description: 'Built by genesys-mcp end-to-end test',
  greeting: 'Thanks for calling the genesys MCP demo line.',
  menu: {
    prompt: 'Press 1 to reach the test queue, or press 9 to end the call.',
    choices: [
      { dtmf: 1, action: 'transfer_to_queue', queue: 'MCP_Test_Queue_msxg5lg7', pre_transfer_message: 'Connecting you now.' },
      { dtmf: 9, action: 'disconnect', name: 'Goodbye' },
    ],
  },
};

console.log(`=== build_flow (${flowName}) ===`);
const built = await callTool(cfg, 'build_flow', { spec });
if (!built.valid) { console.error('INVALID SPEC:', built.errors); process.exit(1); }
console.log('valid. YAML lines:', built.yaml.split('\n').length, '| mermaid lines:', built.mermaid.split('\n').length);

console.log('\n=== publish_flow ===');
let pub;
try {
  pub = await callTool(cfg, 'publish_flow', { spec });
} catch (e) {
  console.error('PUBLISH THREW:', e.message); process.exit(1);
}
console.log(JSON.stringify({ jobId: pub.jobId, status: pub.status, flow: pub.flow, messages: pub.messages }, null, 1));

let status = pub.status;
let flowInfo = pub.flow;
for (let i = 0; i < 20 && !['Success', 'Failure'].includes(status); i++) {
  await new Promise((r) => setTimeout(r, 5000));
  const s = await callTool(cfg, 'get_flow_job', { job_id: pub.jobId });
  status = s.status; flowInfo = s.flow || flowInfo;
  console.log(`poll ${i + 1}: ${status}`);
  if (s.messages) console.log('messages:', JSON.stringify(s.messages).slice(0, 800));
}
if (status !== 'Success') { console.error(`JOB ENDED: ${status}`); process.exit(1); }
console.log('PUBLISHED:', JSON.stringify(flowInfo));

console.log('\n=== list_flows confirms ===');
const listed = await callTool(cfg, 'list_flows', { name_filter: 'MCP_Test*' });
console.log(JSON.stringify(listed.flows));

console.log('\n=== export_flow round-trip ===');
const exported = await callTool(cfg, 'export_flow', { flow: flowName });
console.log(exported.yaml ? `got YAML (${exported.yaml.length} chars), first lines:\n${exported.yaml.split('\n').slice(0, 8).join('\n')}` : JSON.stringify(exported));

console.log('\n=== render_flow on the NEW flow (from live config) ===');
const rNew = await callTool(cfg, 'render_flow', { flow: flowName });
console.log(rNew.mermaid);

console.log('\n=== render_flow on a pre-existing GUI-built flow ===');
const rOld = await callTool(cfg, 'render_flow', { flow: 'Inbound Call Flow' });
console.log(rOld.mermaid);

console.log('\n=== assign_user_skill (ryan@outboundani.com only) ===');
const asg = await callTool(cfg, 'assign_user_skill', { user: 'ryan@outboundani.com', skill: 'MCP_Test_Skill_msxg5lg7', proficiency: 3 });
console.log(JSON.stringify(asg));

console.log('\nE2E complete.');

// Architect flow authoring: spec validation, Archy YAML composition, and
// Mermaid rendering (for specs pre-publish, and best-effort for existing
// flows from their internal configuration JSON).
//
// Publishing goes through the flow jobs API (POST /api/v2/flows/jobs, then
// PUT the YAML to the returned presigned URL), the same pipeline Genesys'
// own CX as Code Terraform provider uses. The job validates AND publishes
// server-side; its failure messages are the validation report.

const DTMF = {
  0: 'digit_0', 1: 'digit_1', 2: 'digit_2', 3: 'digit_3', 4: 'digit_4',
  5: 'digit_5', 6: 'digit_6', 7: 'digit_7', 8: 'digit_8', 9: 'digit_9',
  '*': 'star', '#': 'pound',
};

export const FLOW_ACTIONS = ['transfer_to_queue', 'disconnect'];

// ---------- spec validation ----------

// Spec (v1): an inbound call flow with a TTS greeting and one DTMF menu.
// {
//   name, description?, division?, language? (default en-us),
//   greeting: "TTS text",
//   menu: {
//     prompt: "TTS text",
//     choices: [ { dtmf, action: 'transfer_to_queue'|'disconnect',
//                  name?, queue?, pre_transfer_message? } ]
//   }
// }
export function validateFlowSpec(spec) {
  const errors = [];
  if (!spec || typeof spec !== 'object') return { ok: false, errors: ['spec must be an object'] };

  const name = String(spec.name || '').trim();
  if (!name) errors.push('name is required');
  else if (name.length > 200) errors.push('name must be 200 characters or fewer');

  if (!String(spec.greeting || '').trim()) errors.push('greeting (TTS text) is required');

  const lang = spec.language || 'en-us';
  if (!/^[a-z]{2,3}(-[a-z0-9]{2,4})?$/i.test(lang)) errors.push(`language "${lang}" does not look like a language tag (e.g. en-us)`);

  const menu = spec.menu;
  if (!menu || typeof menu !== 'object') {
    errors.push('menu is required');
  } else {
    if (!String(menu.prompt || '').trim()) errors.push('menu.prompt (TTS text) is required');
    const choices = menu.choices;
    if (!Array.isArray(choices) || !choices.length) {
      errors.push('menu.choices must be a non-empty array');
    } else {
      if (choices.length > 12) errors.push('menu.choices supports at most 12 choices (digits 0-9, *, #)');
      const seen = new Set();
      choices.forEach((c, i) => {
        const where = `choices[${i}]`;
        const key = String(c.dtmf);
        if (!(key in DTMF)) errors.push(`${where}.dtmf must be one of 0-9, *, # (got "${c.dtmf}")`);
        else if (seen.has(key)) errors.push(`${where}: duplicate dtmf "${key}"`);
        seen.add(key);
        if (!FLOW_ACTIONS.includes(c.action)) errors.push(`${where}.action must be one of ${FLOW_ACTIONS.join(', ')}`);
        if (c.action === 'transfer_to_queue' && !String(c.queue || '').trim()) {
          errors.push(`${where}: transfer_to_queue requires a queue name`);
        }
      });
    }
  }
  return { ok: !errors.length, errors };
}

// ---------- Archy YAML composition ----------

// Single-quoted YAML scalar: safe for arbitrary text, quotes doubled.
function yq(s) {
  return `'${String(s).replace(/[\r\n\t]+/g, ' ').replace(/'/g, "''")}'`;
}

const choiceName = (c) =>
  c.name || (c.action === 'disconnect' ? 'Disconnect' : `Transfer to ${c.queue}`);

export function specToArchyYaml(spec) {
  const L = [];
  const push = (indent, text) => L.push('  '.repeat(indent) + text);

  push(0, 'inboundCall:');
  push(1, `name: ${yq(spec.name)}`);
  if (spec.description) push(1, `description: ${yq(spec.description)}`);
  if (spec.division) push(1, `division: ${yq(spec.division)}`);
  push(1, `defaultLanguage: ${spec.language || 'en-us'}`);
  push(1, 'startUpRef: ./menus/menu[mainMenu]');
  push(1, 'initialGreeting:');
  push(2, `tts: ${yq(spec.greeting)}`);
  push(1, 'menus:');
  push(2, '- menu:');
  push(4, 'name: Main Menu');
  push(4, 'refId: mainMenu');
  push(4, 'audio:');
  push(5, `tts: ${yq(spec.menu.prompt)}`);
  push(4, 'choices:');
  for (const c of spec.menu.choices) {
    const dtmf = DTMF[String(c.dtmf)];
    if (c.action === 'disconnect') {
      push(5, '- menuDisconnect:');
      push(7, `name: ${yq(choiceName(c))}`);
      push(7, `dtmf: ${dtmf}`);
    } else {
      push(5, '- menuTransferToAcd:');
      push(7, `name: ${yq(choiceName(c))}`);
      push(7, `dtmf: ${dtmf}`);
      if (c.pre_transfer_message) {
        push(7, 'preTransferAudio:');
        push(8, `tts: ${yq(c.pre_transfer_message)}`);
      }
      // Always set failure audio; without it every publish carries a
      // "no audio set" validation warning.
      push(7, 'failureTransferAudio:');
      push(8, `tts: ${yq(c.failure_message || "Sorry, we can't complete that transfer right now. Please try again later.")}`);
      push(7, 'targetQueue:');
      push(8, 'lit:');
      push(9, `name: ${yq(c.queue)}`);
    }
  }
  return L.join('\n') + '\n';
}

// ---------- Mermaid rendering ----------

function mLabel(s, max = 60) {
  const t = String(s).replace(/"/g, "'").replace(/[\r\n]+/g, ' ');
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

export function specToMermaid(spec) {
  const L = ['flowchart TD'];
  L.push(`  start(["📞 ${mLabel(spec.name)}"])`);
  L.push(`  greet["🔊 ${mLabel(spec.greeting)}"]`);
  L.push(`  menu{"${mLabel(spec.menu.prompt)}"}`);
  L.push('  start --> greet --> menu');
  spec.menu.choices.forEach((c, i) => {
    const id = `c${i}`;
    if (c.action === 'disconnect') {
      L.push(`  ${id}(("👋 ${mLabel(choiceName(c), 30)}"))`);
    } else {
      L.push(`  ${id}[["🎧 Queue: ${mLabel(c.queue, 40)}"]]`);
    }
    L.push(`  menu -->|${c.dtmf}| ${id}`);
  });
  return L.join('\n');
}

// Best-effort renderer for EXISTING flows from /latestconfiguration JSON.
// That format is internal and undocumented; menus and their choices render
// faithfully, other sequence types render as generic nodes. Good enough to
// see a flow's shape in chat; not a round-trip tool.
export function configToMermaid(cfg) {
  const L = ['flowchart TD'];
  const seqs = cfg.flowSequenceItemList || [];
  L.push(`  start(["📞 ${mLabel(cfg.name || 'Flow')}"])`);

  const greeting = extractTts(cfg.initialPrompts) || extractTts(cfg.initialGreeting);
  let prev = 'start';
  if (greeting) {
    L.push(`  greet["🔊 ${mLabel(greeting)}"]`);
    L.push('  start --> greet');
    prev = 'greet';
  }

  if (!seqs.length) L.push(`  empty["(no sequences in configuration)"]`);
  seqs.forEach((seq, si) => {
    const sid = `s${si}`;
    const isStart = seq.id === cfg.initialSequence;
    if (seq.__type === 'Menu') {
      const prompt = extractTts(seq.prompts);
      L.push(`  ${sid}{"${mLabel(prompt || seq.name || 'Menu')}"}`);
      (seq.menuChoiceList || []).forEach((ch, ci) => {
        const cid = `${sid}c${ci}`;
        const t = ch.action?.__type || '';
        const label = ch.name || ch.action?.name || t.replace(/Action$/, '');
        if (/Disconnect/i.test(t)) L.push(`  ${cid}(("👋 ${mLabel(label, 30)}"))`);
        else if (/Transfer/i.test(t)) L.push(`  ${cid}[["🎧 ${mLabel(label, 40)}"]]`);
        else L.push(`  ${cid}["${mLabel(label, 40)}"]`);
        const key = ch.digit ?? ch.dtmf ?? '';
        L.push(`  ${sid} -->|${key === '' ? '?' : key}| ${cid}`);
      });
    } else {
      L.push(`  ${sid}["${mLabel(`${seq.name || seq.__type || 'Step'}`, 50)}"]`);
    }
    if (isStart) L.push(`  ${prev} --> ${sid}`);
  });
  return L.join('\n');
}

// Pull the first TTS string out of an internal prompt/expression subtree.
function extractTts(node) {
  if (!node) return '';
  const m = JSON.stringify(node).match(/ToAudioTTS\(\\"((?:[^"\\]|\\[^"])*)\\"\)/);
  return m ? m[1].replace(/\\\\/g, '\\') : '';
}

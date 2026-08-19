// Architect flow authoring: spec validation, Archy YAML composition, and
// Mermaid rendering (for specs pre-publish, and best-effort for existing
// flows from their internal configuration JSON).
//
// Publishing goes through the flow jobs API (POST /api/v2/flows/jobs, then
// PUT the YAML to the returned presigned URL), the same pipeline Genesys'
// own CX as Code Terraform provider uses. The job validates AND publishes
// server-side; its failure messages are the validation report.
//
// YAML shapes follow Genesys' own published flows (DR blueprint, Archy
// lessons, terraform fixtures) and Architect's serializer: startUpRef points
// at a task when hours branching is used; unhandled evaluateScheduleGroup
// outputs fall through to the next task action (the jump to the main menu).

const DTMF = {
  0: 'digit_0', 1: 'digit_1', 2: 'digit_2', 3: 'digit_3', 4: 'digit_4',
  5: 'digit_5', 6: 'digit_6', 7: 'digit_7', 8: 'digit_8', 9: 'digit_9',
  '*': 'digit_star', '#': 'digit_pound',
};

export const FLOW_ACTIONS = ['transfer_to_queue', 'disconnect', 'voicemail', 'transfer_to_number', 'play_message'];

// ---------- spec validation ----------

// Spec (v2): an inbound call flow with a TTS greeting, an optional
// business-hours gate, and one DTMF menu.
// {
//   name, description?, division?, language? (default en-us),
//   greeting: "TTS text",
//   hours?: {
//     schedule_group: "existing schedule group name",   // create_schedule_group first
//     closed_message: "TTS text",
//     holiday_message?: "TTS text (defaults to closed_message)",
//     closed_action?: 'disconnect' (default) | 'voicemail',
//     closed_voicemail_queue?   // required for closed_action 'voicemail'
//   },
//   menu: {
//     prompt: "TTS text",
//     choices: [ { dtmf, action: 'transfer_to_queue'|'disconnect'|'voicemail'|'transfer_to_number'|'play_message',
//                  name?, queue?, number?, message?, then? ('return_to_menu'|'disconnect'),
//                  pre_transfer_message?, failure_message?, voicemail_greeting? } ]
//   }
// }
// play_message plays TTS info (an address, directions, a notice) and then
// returns to the menu (default) or disconnects.
// Voicemail targets a QUEUE (the message becomes a callback routed to that
// queue; enable voicemail on the queue for live calls). User/group voicemail
// targets are not supported yet: Genesys' validator rejects every documented
// YAML reference form for them, pending a canonical UI export to copy.
export function validateFlowSpec(spec) {
  const errors = [];
  if (!spec || typeof spec !== 'object') return { ok: false, errors: ['spec must be an object'] };

  const name = String(spec.name || '').trim();
  if (!name) errors.push('name is required');
  else if (name.length > 200) errors.push('name must be 200 characters or fewer');

  if (!String(spec.greeting || '').trim()) errors.push('greeting (TTS text) is required');

  const lang = spec.language || 'en-us';
  if (!/^[a-z]{2,3}(-[a-z0-9]{2,4})?$/i.test(lang)) errors.push(`language "${lang}" does not look like a language tag (e.g. en-us)`);

  if (spec.hours !== undefined) {
    const h = spec.hours;
    if (!h || typeof h !== 'object') {
      errors.push('hours must be an object');
    } else {
      if (!String(h.schedule_group || '').trim()) errors.push('hours.schedule_group (an existing schedule group name) is required');
      if (!String(h.closed_message || '').trim()) errors.push('hours.closed_message (TTS text) is required');
      const ca = h.closed_action || 'disconnect';
      if (!['disconnect', 'voicemail'].includes(ca)) errors.push(`hours.closed_action must be disconnect or voicemail (got "${h.closed_action}")`);
      if (ca === 'voicemail' && !String(h.closed_voicemail_queue || '').trim()) {
        errors.push('hours.closed_action "voicemail" requires closed_voicemail_queue (queue name)');
      }
    }
  }

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
        if (c.action === 'voicemail' && !String(c.queue || '').trim()) {
          errors.push(`${where}: voicemail requires a queue name (queue voicemail; user/group targets are not supported yet)`);
        }
        if (c.action === 'transfer_to_number') {
          const num = String(c.number || '').replace(/[\s().-]/g, '');
          if (!/^\+?\d{7,15}$/.test(num)) errors.push(`${where}: transfer_to_number requires an E.164-style number (e.g. +13175550123)`);
        }
        if (c.action === 'play_message') {
          if (!String(c.message || '').trim()) errors.push(`${where}: play_message requires message (TTS text)`);
          if (c.then !== undefined && !['return_to_menu', 'disconnect'].includes(c.then)) {
            errors.push(`${where}.then must be return_to_menu or disconnect (got "${c.then}")`);
          }
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

// Text destined for INSIDE an Architect expression string ("..."): strip the
// characters that would break the expression.
function expText(s) {
  return String(s).replace(/[\r\n\t]+/g, ' ').replace(/["\\]/g, "'");
}

const cleanNumber = (n) => String(n).replace(/[\s().-]/g, '');

const choiceName = (c) => {
  if (c.name) return c.name;
  switch (c.action) {
    case 'disconnect': return 'Disconnect';
    case 'voicemail': return 'Leave a Voicemail';
    case 'transfer_to_number': return `Call ${cleanNumber(c.number)}`;
    case 'play_message': return 'Information';
    default: return `Transfer to ${c.queue}`;
  }
};

export function specToArchyYaml(spec) {
  const L = [];
  const push = (indent, text) => L.push('  '.repeat(indent) + text);
  const hours = spec.hours;

  // A voicemail destination block, shared by the menu-choice and task-action
  // forms. `base` is the indent of the "destination:" line. Queue target
  // only: it is the shape Genesys' own flows publish, and the only one their
  // validator accepts from YAML today.
  const pushVoicemailDestination = (base, { queue, greeting }) => {
    push(base, 'destination:');
    push(base + 1, 'queue:');
    push(base + 2, 'targetQueue:');
    push(base + 3, 'lit:');
    push(base + 4, `name: ${yq(queue)}`);
    // Queue voicemail becomes a callback interaction; default the callback
    // number to the caller's ANI (Architect's own default).
    push(base + 2, 'callbackNumber:');
    push(base + 3, 'exp: ToPhoneNumber(Call.Ani)');
    if (greeting) {
      push(base + 2, 'voicemailGreeting:');
      push(base + 3, `exp: 'AudioPlaybackOptions(ToAudioTTS("${expText(greeting)}"), false)'`);
    }
  };

  // Pre/failure transfer audio with friendly defaults: without them every
  // publish carries "no audio set" validation warnings.
  const pushTransferAudio = (base, pre, failure) => {
    push(base, 'preTransferAudio:');
    push(base + 1, `tts: ${yq(pre || 'One moment please.')}`);
    push(base, 'failureTransferAudio:');
    push(base + 1, `tts: ${yq(failure || "Sorry, we can't complete that transfer right now. Please try again later.")}`);
  };

  push(0, 'inboundCall:');
  push(1, `name: ${yq(spec.name)}`);
  if (spec.description) push(1, `description: ${yq(spec.description)}`);
  if (spec.division) push(1, `division: ${yq(spec.division)}`);
  push(1, `defaultLanguage: ${spec.language || 'en-us'}`);
  push(1, hours ? 'startUpRef: "/inboundCall/tasks/task[checkHours]"' : 'startUpRef: ./menus/menu[mainMenu]');
  push(1, 'initialGreeting:');
  push(2, `tts: ${yq(spec.greeting)}`);

  if (hours) {
    const closedTerminal = (base) => {
      if ((hours.closed_action || 'disconnect') === 'voicemail') {
        push(base, '- transferToVoicemail:');
        push(base + 2, 'name: Closed Voicemail');
        pushTransferAudio(base + 2, 'Transferring you to voicemail.', hours.closed_message);
        pushVoicemailDestination(base + 2, {
          queue: hours.closed_voicemail_queue,
          greeting: hours.closed_voicemail_greeting,
        });
      } else {
        push(base, '- disconnect:');
        push(base + 2, 'name: Disconnect');
      }
    };
    push(1, 'tasks:');
    push(2, '- task:');
    push(4, 'name: Check Hours');
    push(4, 'refId: checkHours');
    push(4, 'actions:');
    push(5, '- evaluateScheduleGroup:');
    push(7, 'name: Evaluate Schedule Group');
    push(7, 'inServiceSchedules:');
    push(8, 'noValue: true');
    push(7, 'evaluate:');
    push(8, 'now: true');
    push(7, 'scheduleGroup:');
    push(8, 'lit:');
    push(9, `name: ${yq(hours.schedule_group)}`);
    push(7, 'emergencyGroup:');
    push(8, 'noValue: true');
    push(7, 'outputs:');
    // Open falls through to the jumpToMenu action below.
    push(8, 'closed:');
    push(9, 'actions:');
    push(10, '- playAudio:');
    push(12, 'name: Closed Message');
    push(12, 'audio:');
    push(13, `tts: ${yq(hours.closed_message)}`);
    closedTerminal(10);
    push(8, 'holiday:');
    push(9, 'actions:');
    push(10, '- playAudio:');
    push(12, 'name: Holiday Message');
    push(12, 'audio:');
    push(13, `tts: ${yq(hours.holiday_message || hours.closed_message)}`);
    closedTerminal(10);
    push(5, '- jumpToMenu:');
    push(7, 'name: Go to main menu');
    push(7, 'targetMenuRef: "/inboundCall/menus/menu[mainMenu]"');
  }

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
      continue;
    }
    if (c.action === 'play_message') {
      // An inline task choice: play the info message, then return to the
      // menu (default) or disconnect.
      push(5, '- menuTask:');
      push(7, `name: ${yq(choiceName(c))}`);
      push(7, `dtmf: ${dtmf}`);
      push(7, 'task:');
      push(8, 'actions:');
      push(9, '- playAudio:');
      push(11, 'name: Info Message');
      push(11, 'audio:');
      push(12, `tts: ${yq(c.message)}`);
      if ((c.then || 'return_to_menu') === 'disconnect') {
        push(9, '- disconnect:');
        push(11, 'name: Disconnect');
      } else {
        push(9, '- previousMenu:');
        push(11, 'name: Return to Menu');
      }
      continue;
    }
    const kind = c.action === 'voicemail' ? 'menuTransferToVoicemail'
      : c.action === 'transfer_to_number' ? 'menuTransferToNumber'
      : 'menuTransferToAcd';
    push(5, `- ${kind}:`);
    push(7, `name: ${yq(choiceName(c))}`);
    push(7, `dtmf: ${dtmf}`);
    pushTransferAudio(7, c.pre_transfer_message, c.failure_message);
    if (c.action === 'transfer_to_queue') {
      push(7, 'targetQueue:');
      push(8, 'lit:');
      push(9, `name: ${yq(c.queue)}`);
    } else if (c.action === 'voicemail') {
      pushVoicemailDestination(7, { queue: c.queue, greeting: c.voicemail_greeting });
    } else {
      push(7, 'targetNumber:');
      push(8, `lit: ${yq(cleanNumber(c.number))}`);
      push(7, 'connectTimeout:');
      push(8, 'noValue: true');
    }
  }
  return L.join('\n') + '\n';
}

// ---------- Mermaid rendering ----------

function mLabel(s, max = 60) {
  const t = String(s).replace(/"/g, "'").replace(/[\r\n]+/g, ' ');
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

function choiceNode(id, c) {
  if (c.action === 'disconnect') return `  ${id}(("👋 ${mLabel(choiceName(c), 30)}"))`;
  if (c.action === 'voicemail') return `  ${id}[["📬 ${mLabel(choiceName(c), 40)}"]]`;
  if (c.action === 'transfer_to_number') return `  ${id}[["☎️ ${mLabel(choiceName(c), 40)}"]]`;
  if (c.action === 'play_message') return `  ${id}["🔈 ${mLabel(c.message, 45)}"]`;
  return `  ${id}[["🎧 Queue: ${mLabel(c.queue, 40)}"]]`;
}

export function specToMermaid(spec) {
  const L = ['flowchart TD'];
  L.push(`  start(["📞 ${mLabel(spec.name)}"])`);
  L.push(`  greet["🔊 ${mLabel(spec.greeting)}"]`);
  L.push('  start --> greet');
  let menuFrom = 'greet';
  if (spec.hours) {
    const h = spec.hours;
    L.push(`  hrs{"🕐 ${mLabel(h.schedule_group, 40)}"}`);
    L.push('  greet --> hrs');
    L.push(`  closedmsg["🔊 ${mLabel(h.closed_message)}"]`);
    L.push('  hrs -->|closed / holiday| closedmsg');
    if ((h.closed_action || 'disconnect') === 'voicemail') {
      L.push(`  closedend[["📬 ${mLabel(h.closed_voicemail_queue, 35)} voicemail"]]`);
    } else {
      L.push('  closedend(("👋 end"))');
    }
    L.push('  closedmsg --> closedend');
    L.push('  hrs -->|open| menu');
    menuFrom = null;
  }
  L.push(`  menu{"${mLabel(spec.menu.prompt)}"}`);
  if (menuFrom) L.push(`  ${menuFrom} --> menu`);
  spec.menu.choices.forEach((c, i) => {
    const id = `c${i}`;
    L.push(choiceNode(id, c));
    L.push(`  menu -->|${c.dtmf}| ${id}`);
    if (c.action === 'play_message' && (c.then || 'return_to_menu') === 'return_to_menu') {
      L.push(`  ${id} -.-> menu`);
    }
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
        else if (/Voicemail/i.test(t)) L.push(`  ${cid}[["📬 ${mLabel(label, 40)}"]]`);
        else if (/Number/i.test(t)) L.push(`  ${cid}[["☎️ ${mLabel(label, 40)}"]]`);
        else if (/Transfer/i.test(t)) L.push(`  ${cid}[["🎧 ${mLabel(label, 40)}"]]`);
        else L.push(`  ${cid}["${mLabel(label, 40)}"]`);
        const key = ch.digit ?? ch.dtmf ?? '';
        L.push(`  ${sid} -->|${key === '' ? '?' : key}| ${cid}`);
      });
    } else if (seq.__type === 'Task' || /Task/i.test(seq.__type || '')) {
      const hasSchedule = JSON.stringify(seq).includes('ScheduleGroup');
      L.push(`  ${sid}${hasSchedule ? `{"🕐 ${mLabel(seq.name || 'Check Hours', 40)}"}` : `["${mLabel(seq.name || 'Task', 50)}"]`}`);
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

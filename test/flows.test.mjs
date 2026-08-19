import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateFlowSpec, specToArchyYaml, specToMermaid, configToMermaid } from '../src/flows.js';

const goodSpec = {
  name: 'Test Flow',
  greeting: "Thanks for calling, we're glad you're here",
  menu: {
    prompt: 'Press 1 for support, 9 to hang up.',
    choices: [
      { dtmf: 1, action: 'transfer_to_queue', queue: 'Support Queue', pre_transfer_message: 'One moment.' },
      { dtmf: 9, action: 'disconnect' },
    ],
  },
};

test('validateFlowSpec accepts a good spec', () => {
  const v = validateFlowSpec(goodSpec);
  assert.deepEqual(v, { ok: true, errors: [] });
});

test('validateFlowSpec catches missing fields, bad dtmf, dupes, missing queue', () => {
  const v = validateFlowSpec({
    menu: { choices: [
      { dtmf: 'x', action: 'transfer_to_queue' },
      { dtmf: 1, action: 'nope' },
      { dtmf: 1, action: 'disconnect' },
    ] },
  });
  assert.equal(v.ok, false);
  const all = v.errors.join(' | ');
  assert.match(all, /name is required/);
  assert.match(all, /greeting/);
  assert.match(all, /menu\.prompt/);
  assert.match(all, /dtmf must be one of/);
  assert.match(all, /duplicate dtmf/);
  assert.match(all, /requires a queue name/);
  assert.match(all, /action must be one of/);
});

test('specToArchyYaml emits the documented Archy shapes with safe quoting', () => {
  const yaml = specToArchyYaml(goodSpec);
  assert.match(yaml, /^inboundCall:\n/);
  assert.match(yaml, /name: 'Test Flow'/);
  assert.match(yaml, /startUpRef: \.\/menus\/menu\[mainMenu\]/);
  assert.match(yaml, /initialGreeting:\n {4}tts: 'Thanks for calling, we''re glad you''re here'/);
  assert.match(yaml, /- menuTransferToAcd:/);
  assert.match(yaml, /dtmf: digit_1/);
  assert.match(yaml, /targetQueue:\n {16}lit:\n {18}name: 'Support Queue'/);
  assert.match(yaml, /failureTransferAudio:\n {16}tts: 'Sorry, we can''t complete/);
  assert.match(yaml, /- menuDisconnect:/);
  assert.match(yaml, /dtmf: digit_9/);
  assert.ok(!yaml.includes('undefined'));
});

test('star and pound dtmf map to their Archy names', () => {
  const spec = { ...goodSpec, menu: { prompt: 'p', choices: [
    { dtmf: '*', action: 'disconnect' },
    { dtmf: '#', action: 'transfer_to_queue', queue: 'Q' },
  ] } };
  const yaml = specToArchyYaml(spec);
  assert.match(yaml, /dtmf: digit_star/);
  assert.match(yaml, /dtmf: digit_pound/);
});

const fullSpec = {
  name: 'Full Flow',
  greeting: 'Thanks for calling.',
  hours: {
    schedule_group: 'Main Office Hours',
    closed_message: "We're closed right now.",
    closed_action: 'voicemail',
    closed_voicemail_queue: 'Support',
  },
  menu: {
    prompt: 'Press 1 for support, 2 for voicemail, 3 for the answering service, 9 to hang up.',
    choices: [
      { dtmf: 1, action: 'transfer_to_queue', queue: 'Support' },
      { dtmf: 2, action: 'voicemail', queue: 'Support' },
      { dtmf: 3, action: 'transfer_to_number', number: '+1 (317) 555-0123' },
      { dtmf: 9, action: 'disconnect' },
    ],
  },
};

test('v2 spec validates: hours + voicemail + number', () => {
  assert.deepEqual(validateFlowSpec(fullSpec), { ok: true, errors: [] });
});

test('v2 validator catches bad hours and choice targets', () => {
  const v = validateFlowSpec({
    name: 'x', greeting: 'g',
    hours: { closed_action: 'voicemail' },
    menu: { prompt: 'p', choices: [
      { dtmf: 1, action: 'voicemail' },
      { dtmf: 3, action: 'transfer_to_number', number: 'call me' },
    ] },
  });
  assert.equal(v.ok, false);
  const all = v.errors.join(' | ');
  assert.match(all, /hours\.schedule_group/);
  assert.match(all, /hours\.closed_message/);
  assert.match(all, /closed_voicemail_queue/);
  assert.match(all, /voicemail requires a queue name/);
  assert.match(all, /E\.164/);
});

test('v2 YAML: schedule branching task, startUpRef, fall-through jump', () => {
  const yaml = specToArchyYaml(fullSpec);
  assert.match(yaml, /startUpRef: "\/inboundCall\/tasks\/task\[checkHours\]"/);
  assert.match(yaml, /- evaluateScheduleGroup:/);
  assert.match(yaml, /scheduleGroup:\n {16}lit:\n {18}name: 'Main Office Hours'/);
  assert.match(yaml, /emergencyGroup:\n {16}noValue: true/);
  assert.match(yaml, /evaluate:\n {16}now: true/);
  assert.match(yaml, /closed:\n {18}actions:\n {20}- playAudio:/);
  assert.match(yaml, /holiday:\n {18}actions:/);
  assert.match(yaml, /- jumpToMenu:\n {14}name: Go to main menu\n {14}targetMenuRef: "\/inboundCall\/menus\/menu\[mainMenu\]"/);
  // closed_action voicemail lands a transferToVoicemail inside the task
  assert.match(yaml, /- transferToVoicemail:\n {24}name: Closed Voicemail/);
});

test('v2 YAML: voicemail choice (queue), number choice, default pre-audio, no undefined', () => {
  const yaml = specToArchyYaml(fullSpec);
  assert.match(yaml, /- menuTransferToVoicemail:/);
  assert.match(yaml, /destination:\n {16}queue:\n {18}targetQueue:\n {20}lit:\n {22}name: 'Support'/);
  assert.match(yaml, /- menuTransferToNumber:/);
  assert.match(yaml, /targetNumber:\n {16}lit: '\+13175550123'/);
  assert.match(yaml, /connectTimeout:\n {16}noValue: true/);
  assert.match(yaml, /preTransferAudio:\n {16}tts: 'One moment please\.'/);
  assert.ok(!yaml.includes('undefined'));
});

test('v2 YAML: queue voicemail carries callbackNumber and sanitized greeting', () => {
  const spec = { ...goodSpec, menu: { prompt: 'p', choices: [
    { dtmf: 5, action: 'voicemail', queue: 'Support', voicemail_greeting: 'Say "hi" after the tone' },
  ] } };
  const yaml = specToArchyYaml(spec);
  assert.match(yaml, /destination:\n {16}queue:\n {18}targetQueue:\n {20}lit:\n {22}name: 'Support'/);
  assert.match(yaml, /callbackNumber:\n {20}exp: ToPhoneNumber\(Call\.Ani\)/);
  assert.match(yaml, /voicemailGreeting:\n {20}exp: 'AudioPlaybackOptions\(ToAudioTTS\("Say 'hi' after the tone"\), false\)'/);
});

test('v2 mermaid: hours diamond routes open to menu, closed to message', () => {
  const m = specToMermaid(fullSpec);
  assert.match(m, /hrs\{"🕐 Main Office Hours"\}/);
  assert.match(m, /hrs -->\|open\| menu/);
  assert.match(m, /hrs -->\|closed \/ holiday\| closedmsg/);
  assert.match(m, /📬/);
  assert.match(m, /☎️/);
});

test('spec without hours keeps the v1 shape', () => {
  const yaml = specToArchyYaml(goodSpec);
  assert.match(yaml, /startUpRef: \.\/menus\/menu\[mainMenu\]/);
  assert.ok(!yaml.includes('tasks:'));
  assert.ok(!yaml.includes('evaluateScheduleGroup'));
});

test('specToMermaid renders start, greeting, menu, and one node per choice', () => {
  const m = specToMermaid(goodSpec);
  assert.match(m, /^flowchart TD/);
  assert.match(m, /start\(\["📞 Test Flow"\]\)/);
  assert.match(m, /menu -->\|1\| c0/);
  assert.match(m, /menu -->\|9\| c1/);
  assert.match(m, /Queue: Support Queue/);
  assert.ok(!m.includes('"'.repeat(2)));
});

test('configToMermaid walks menus + choices from internal config JSON', () => {
  const cfg = {
    name: 'Inbound Call Flow',
    initialSequence: 'seq-1',
    initialPrompts: { p: { text: 'AudioPlaybackOptions(ToAudioTTS("Hello there"))' } },
    flowSequenceItemList: [{
      id: 'seq-1', __type: 'Menu', name: 'Main Menu',
      prompts: { pre: { text: 'AudioPlaybackOptions(ToAudioTTS("Press 9 to disconnect."))' } },
      menuChoiceList: [
        { name: 'Disconnect', digit: 9, action: { __type: 'DisconnectAction', name: 'Disconnect' } },
        { name: 'Support', digit: 1, action: { __type: 'TransferAcdAction', name: 'Transfer to ACD' } },
      ],
    }],
  };
  const m = configToMermaid(cfg);
  assert.match(m, /🔊 Hello there/);
  assert.match(m, /Press 9 to disconnect\./);
  assert.match(m, /-->\|9\| s0c0/);
  assert.match(m, /-->\|1\| s0c1/);
  assert.match(m, /👋/);
  assert.match(m, /🎧/);
  assert.match(m, /greet --> s0/);
});

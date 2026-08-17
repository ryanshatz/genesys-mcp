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
  assert.match(yaml, /dtmf: star/);
  assert.match(yaml, /dtmf: pound/);
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

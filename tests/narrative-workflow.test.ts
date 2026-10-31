import assert from 'node:assert/strict';
import test from 'node:test';
import {
  compileStory,
  createNarrativeSession,
  formatDiagnostics,
  prepareSnapshot,
  saveSession,
  MemoryNarrativeSaveStore,
  LocalStorageNarrativeSaveStore,
  runNarrativeAuthoring,
  validateStory,
  NarrativeWebAdapter,
  type AdventureModule,
  type Story,
} from '../src/narrative/index.js';

const story: Story = {
  schemaVersion: '1',
  id: 'workflow-test',
  version: '1.0.0',
  title: 'Workflow test',
  start: 'opening',
  variables: { score: { type: 'number', default: 0 }, name: { type: 'string', default: 'Ada' } },
  assets: { room: { type: 'image', src: '/room.png' }, theme: { type: 'audio', src: '/theme.ogg' } },
  nodes: [
    { id: 'opening', type: 'dialogue', lines: [{ speaker: 'Guide', text: 'Hello {{name}}.' }, { text: 'Choose carefully.' }], next: 'choice' },
    {
      id: 'choice', type: 'choice', prompt: 'What now?', options: [
        { id: 'good', text: 'Open the door', next: 'action', actions: [{ type: 'add', variable: 'score', value: 1 }] },
        { id: 'locked', text: 'Force the lock', next: 'ending', disabledWhen: { op: 'eq', left: { var: 'score' }, right: 0 }, disabledReason: 'The key is missing.' },
      ],
    },
    { id: 'action', type: 'scene', scene: 'room', background: 'room', music: 'theme', next: 'ending' },
    { id: 'ending', type: 'end', ending: 'door-open', text: 'Score: {{score}}' },
  ],
};

test('content validation reports graph errors and compilation detaches input', () => {
  const invalid = { ...story, nodes: [{ ...story.nodes[0], next: 'missing' }] };
  const result = validateStory(invalid);
  assert.equal(result.valid, false);
  assert.match(formatDiagnostics(result), /NODE_MISSING/);

  const compiled = compileStory(story);
  assert.notEqual(compiled.story, story);
  assert.equal(Object.isFrozen(compiled.story), true);
  assert.equal(compiled.nodes.get('opening')?.id, 'opening');
});

test('session transitions are deterministic and failed commands do not commit', () => {
  const first = createNarrativeSession(story, { seed: 7 });
  const second = createNarrativeSession(story, { seed: 7 });
  assert.deepEqual(first.start(), second.start());
  assert.equal(first.getView().line?.text, 'Hello Ada.');
  first.dispatch({ type: 'continue' });
  assert.equal(first.getView().line?.text, 'Choose carefully.');
  first.dispatch({ type: 'continue' });
  const before = first.snapshot();
  assert.throws(() => first.dispatch({ type: 'choose', optionId: 'locked' }), /key is missing/i);
  assert.deepEqual(first.snapshot(), before);
  const result = first.dispatch({ type: 'choose', optionId: 'good' });
  assert.equal(result.view.awaiting, 'ended');
  assert.equal(result.effects.some(effect => effect.type === 'scene'), true);
  assert.equal(result.view.ending?.text, 'Score: 1');

  const seededStory: Story = {
    schemaVersion: '1', id: 'seeded-test', version: '1.0.0', title: 'Seeded', start: 'roll',
    variables: { score: { type: 'number', default: 0 } },
    nodes: [
      { id: 'roll', type: 'action', actions: [{ type: 'set', variable: 'score', value: { random: { min: 1, max: 6 } } }], next: 'line' },
      { id: 'line', type: 'dialogue', lines: [{ text: '{{score}}' }], next: 'done' },
      { id: 'done', type: 'end', ending: 'finished' },
    ],
  };
  const seededA = createNarrativeSession(seededStory, { seed: 99 }).start();
  const seededB = createNarrativeSession(seededStory, { seed: 99 }).start();
  assert.deepEqual(seededA, seededB);
});

const module: AdventureModule = {
  id: 'dice',
  version: '1.0.0',
  stateVersion: 1,
  initialState: { calls: 0 },
  register(registrar) {
    registrar.command('dice:mark', context => {
      const state = context.getModuleState('dice') as { calls: number };
      context.setModuleState('dice', { calls: state.calls + 1 });
      context.emit({ type: 'dice.marked' });
    });
  },
};

const moduleStory: Story = {
  schemaVersion: '1', id: 'module-test', version: '1.0.0', title: 'Module', start: 'roll',
  nodes: [
    { id: 'roll', type: 'module', module: 'dice', input: { sides: 6 }, outcomes: { success: 'done' } },
    { id: 'done', type: 'end', ending: 'success' },
  ],
};

test('module requests, serializable effects and restore use a deterministic cursor', () => {
  const session = createNarrativeSession(moduleStory, [module]);
  const started = session.start();
  assert.equal(started.view.awaiting, 'module');
  assert.equal(started.effects[0]?.type, 'module.request');
  const snapshot = session.snapshot();
  assert.throws(() => session.dispatch({ type: 'continue' }), /module result/i);
  const done = session.dispatch({ type: 'module.result', requestId: started.view.pending!.id, outcome: 'success' });
  assert.equal(done.view.ending?.id, 'success');
  const restored = createNarrativeSession(moduleStory, [module]);
  const restoredResult = restored.restore(snapshot);
  assert.equal(restoredResult.view.awaiting, 'module');
  assert.equal(restoredResult.effects.some(effect => effect.type === 'module.request'), true);
});

test('snapshot preparation migrates module state versions', () => {
  const oldModule = module;
  const session = createNarrativeSession(moduleStory, [oldModule]);
  session.start();
  const old = session.snapshot();
  old.moduleVersions.dice = '1.0.0';
  old.state.modules.dice.version = 1;
  const migratedModule: AdventureModule = {
    ...module,
    version: '2.0.0',
    stateVersion: 2,
    migrateState: (value, from, to) => ({ ...(value as { calls: number }), migrated: `${from}->${to}` }),
  };
  const compiled = compileStory(moduleStory, [migratedModule]);
  const prepared = prepareSnapshot(old, compiled, { isModuleVersionCompatible: () => true });
  assert.equal(prepared.moduleVersions.dice, '2.0.0');
  assert.deepEqual(prepared.state.modules.dice.data, { calls: 0, migrated: '1->2' });
});

test('restore invokes module migration when implementation version changes without a schema bump', () => {
  const original = createNarrativeSession(moduleStory, [module]);
  original.start();
  const migrated: AdventureModule = {
    ...module,
    version: '1.1.0',
    migrateState: (value, from, to) => ({ ...(value as { calls: number }), changed: `${from}->${to}` }),
  };
  const next = createNarrativeSession(moduleStory, [migrated]);
  const restored = next.restore(original.snapshot());
  assert.deepEqual(restored.state.modules.dice.data, { calls: 0, changed: '1->1' });
});

test('save stores validate records and preserve a memory copy when browser storage is denied', async () => {
  const session = createNarrativeSession(story);
  session.start();
  const memory = new MemoryNarrativeSaveStore();
  const record = await saveSession(memory, 'slot-1', session, { savedAt: '2026-10-26T00:00:00.000Z', label: 'Opening' });
  assert.equal((await memory.list('workflow-test')).length, 1);
  const detached = await memory.read('slot-1');
  assert.equal(detached?.label, 'Opening');
  await assert.rejects(memory.write({ ...record, slotId: '' }), /slot ID/i);

  const denied = new LocalStorageNarrativeSaveStore({
    get length(): number { throw new DOMException('denied', 'SecurityError'); },
    key() { return null; },
    getItem() { throw new DOMException('denied', 'SecurityError'); },
    setItem() { throw new DOMException('denied', 'SecurityError'); },
    removeItem() {},
  });
  await denied.write(record);
  assert.equal((await denied.read('slot-1'))?.snapshot.gameId, 'workflow-test');
  assert.equal((await denied.list()).length, 1);

  const text = new Map<string, string>();
  const local = new LocalStorageNarrativeSaveStore({
    get length() { return text.size; },
    key(index) { return [...text.keys()][index] ?? null; },
    getItem(key) { return text.get(key) ?? null; },
    setItem(key, value) { text.set(key, value); },
    removeItem(key) { text.delete(key); },
  });
  await local.write(record);
  assert.equal((await local.read('slot-1'))?.snapshot.contentVersion, '1.0.0');
  text.set('general-engine:narrative:v1:corrupt', '{');
  await assert.rejects(local.read('corrupt'), SyntaxError);
});

test('web adapter dispatches scene, module and checkpoint effects to host callbacks', async () => {
  const received: string[] = [];
  const adapter = new NarrativeWebAdapter({
    onScene: scene => { received.push(`scene:${scene.id}`); },
    onModuleRequest: request => { received.push(`module:${request.module}`); },
    onCheckpoint: name => { received.push(`checkpoint:${name}`); },
    onEvent: event => { received.push(`event:${event.type}`); },
  });
  await adapter.apply([
    { type: 'scene', scene: 'room' },
    { type: 'module.request', request: { id: 'dice:1', module: 'dice', nodeId: 'roll', input: null } },
    { type: 'checkpoint', name: 'door' },
  ], [{ type: 'opened' }]);
  assert.deepEqual(received, ['event:opened', 'scene:room', 'module:dice', 'checkpoint:door']);
});

test('authoring workflow is injectable and supports validation/compile output', async () => {
  const files = new Map([['story.json', JSON.stringify(story)]]);
  const logs: string[] = [];
  const result = await runNarrativeAuthoring(['compile', 'story.json', '--out', 'build/story.json'], {
    readText: async path => files.get(path) ?? '',
    writeText: async (path, text) => { files.set(path, text); },
    mkdir: async () => {},
    log: message => logs.push(message),
    error: message => logs.push(`error:${message}`),
  });
  assert.equal(result.code, 0);
  assert.match(files.get('build/story.json') ?? '', /workflow-test/);
  assert.match(logs[0] ?? '', /Compiled workflow-test/);
});

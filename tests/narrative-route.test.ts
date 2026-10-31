import assert from 'node:assert/strict';
import test from 'node:test';
import { resolve } from 'node:path';
import { checkNarrativeRoute, runNarrativeRoute } from '../tools/narrative/check-route.js';
import type { Story } from '../src/narrative/index.js';

const story: Story = {
  schemaVersion: '1',
  id: 'route-test',
  version: '1.2.0',
  title: 'Route test',
  start: 'opening',
  variables: { trust: { type: 'number', default: 0 } },
  nodes: [
    { id: 'opening', type: 'dialogue', lines: [{ text: 'Welcome.' }], next: 'choice' },
    {
      id: 'choice', type: 'choice', options: [
        { id: 'stay', text: 'Stay', next: 'finish', actions: [{ type: 'add', variable: 'trust', value: 1 }, { type: 'tag.add', tag: 'stayed' }] },
        { id: 'leave', text: 'Leave', next: 'bad-ending', disabledWhen: { op: 'eq', left: { var: 'trust' }, right: 0 } },
      ],
    },
    { id: 'finish', type: 'end', ending: 'quiet-night' },
    { id: 'bad-ending', type: 'end', ending: 'alone' },
  ],
};

const route = {
  storyId: 'route-test',
  contentVersion: '1.2.0',
  seed: 42,
  steps: [
    { node: 'opening', command: { type: 'continue' } },
    { node: 'choice', command: { type: 'choose', optionId: 'stay' } },
  ],
  ending: 'quiet-night',
  variables: { trust: 1 },
  tags: ['stayed'],
};

test('route checker verifies player transitions and returns a stable trace', () => {
  const first = checkNarrativeRoute(story, route);
  const second = checkNarrativeRoute(story, route);
  assert.deepEqual(first, second);
  assert.equal(first.ending, 'quiet-night');
  assert.equal(first.trace.length, 3);
  assert.deepEqual(first.snapshot.state.tags, ['stayed']);
  assert.equal(first.snapshot.state.variables.trust, 1);
});

test('route checker rejects wrong nodes, disabled choices, stale content and unmet outcomes', () => {
  assert.throws(() => checkNarrativeRoute(story, { ...route, steps: [{ node: 'stale', command: { type: 'continue' } }] }), /expected node stale/);
  assert.throws(() => checkNarrativeRoute(story, { ...route, steps: [...route.steps.slice(0, 1), { node: 'choice', command: { type: 'choose', optionId: 'leave' } }] }), /not selectable/);
  assert.throws(() => checkNarrativeRoute(story, { ...route, contentVersion: 'old' }), /contentVersion mismatch/);
  assert.throws(() => checkNarrativeRoute(story, { ...route, ending: 'wrong' }), /ending mismatch/);
});

test('CLI writes deterministic output and refuses to overwrite either input', async () => {
  const storyPath = resolve('/workspace/story.json');
  const routePath = resolve('/workspace/route.json');
  const outputPath = resolve('/workspace/build/result.json');
  const files = new Map([
    [storyPath, JSON.stringify(story)],
    [routePath, JSON.stringify(route)],
  ]);
  const logs: string[] = [];
  const run = (args: string[]) => runNarrativeRoute(args, {
    readText: async path => files.get(path) ?? '',
    writeText: async (path, value) => { files.set(path, value); },
    mkdir: async () => {},
    log: message => logs.push(message),
    error: message => logs.push(`error:${message}`),
  });
  const args = ['--story', storyPath, '--route', routePath, '--out', outputPath];
  assert.equal(await run(args), 0);
  const firstOutput = files.get(outputPath);
  assert.ok(firstOutput);
  assert.equal(await run(args), 0);
  assert.equal(files.get(outputPath), firstOutput);
  assert.equal(await run(['--story', args[1], '--route', args[3], '--out', args[1]]), 2);
  assert.match(logs.at(-1) ?? '', /must not overwrite/);
});

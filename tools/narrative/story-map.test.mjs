import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeStory, renderMermaid } from './story-map.mjs';

const sample = {
  schemaVersion: '1', id: 'sample', version: '1.0.0', title: 'Sample', start: 'start',
  nodes: [
    { id: 'start', type: 'choice', options: [{ id: 'a', text: 'A', next: 'left' }, { id: 'b', text: 'B', next: 'right' }] },
    { id: 'left', type: 'dialogue', lines: [{ text: 'Left' }], next: 'ending' },
    { id: 'right', type: 'branch', branches: [{ when: { op: 'tag', tag: 'x' }, next: 'ending' }], fallback: 'cycle' },
    { id: 'cycle', type: 'action', actions: [], next: 'cycle' },
    { id: 'ending', type: 'end', ending: 'done' },
    { id: 'orphan', type: 'end', ending: 'unused' },
    { id: 'custom', type: 'demo:custom' },
  ],
};

test('analyzes declared edges, reachability, endings, cycles and unknown custom flow', () => {
  const map = analyzeStory(sample);
  assert.equal(map.analysis.valid, true);
  assert.deepEqual(map.analysis.unreachableNodeIds, ['orphan', 'custom']);
  assert.deepEqual(map.analysis.deadEndNodeIds, []);
  assert.deepEqual(map.analysis.cannotReachEndingNodeIds, ['cycle']);
  assert.deepEqual(map.analysis.cycles, [['cycle']]);
  assert.deepEqual(map.analysis.dynamicNodeIds, ['custom']);
  assert.equal(map.edges.length, 6);
});

test('reports missing starts, references, duplicate IDs and malformed built-in nodes', () => {
  const broken = structuredClone(sample);
  broken.nodes[0].options[0].next = 'missing';
  broken.nodes[1].id = 'start';
  const map = analyzeStory(broken);
  assert.equal(map.analysis.valid, false);
  assert.ok(map.analysis.errors.some(error => error.code === 'NODE_DUPLICATE'));
  assert.ok(map.analysis.errors.some(error => error.code === 'TARGET_MISSING'));
});

test('renders deterministic Mermaid node IDs and escaped labels', () => {
  const map = analyzeStory({ ...sample, nodes: [{ id: 'start]x', type: 'end', ending: 'done' }], start: 'start]x' });
  assert.match(renderMermaid(map), /n0\["start x · end"\]/);
});

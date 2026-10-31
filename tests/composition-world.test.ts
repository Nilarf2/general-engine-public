import assert from 'node:assert/strict';
import test from 'node:test';
import { World } from '../src/core/World.js';
import type { Plugin } from '../src/core/World.js';
import { createCompositionRuntime, createWorldCompositionModule, type CompositionGraph, type JsonValue } from '../src/composition/index.js';

function worldPlugin(cleaned: string[]): Plugin {
  return {
    id: 'counter',
    setup(target, scope) {
      const state = { value: 0 };
      target.services.set('counter', state);
      scope.defer(() => target.services.delete('counter'));
      scope.defer(target.addSystem({ id: 'counter-tick', update: () => { state.value++; } }));
      scope.defer(target.registerCommand('counter.read', command => ({ value: state.value, label: command.label ?? null })));
      scope.defer(() => { cleaned.push('counter'); });
    }
  };
}

function graph(nodes: CompositionGraph['nodes']): CompositionGraph {
  return { id: 'world-bridge-test', version: 1, start: nodes[0]!.id, nodes };
}

function worldNode(id: string, operation: JsonValue, edges: { to: string }[] = [], module = 'world') {
  return { id, type: 'module' as const, module, input: { from: 'literal' as const, value: operation }, output: `/${id}`, edges };
}

test('composition graph drives World steps, commands and JSON snapshots', async () => {
  const world = new World();
  const cleaned: string[] = [];
  const module = createWorldCompositionModule({ world, plugins: [worldPlugin(cleaned)] });
  const runtime = await createCompositionRuntime({
    graph: graph([
      worldNode('step', { type: 'step', count: 2 }, [{ to: 'command' }]),
      worldNode('command', { type: 'command', command: { type: 'counter.read', label: 'from-graph' } }, [{ to: 'snapshot' }]),
      worldNode('snapshot', { type: 'snapshot' })
    ]),
    modules: [module],
    initialState: { step: null, command: null, snapshot: null }
  });

  const result = await runtime.run();
  assert.equal(world.tick, 2);
  assert.deepEqual(result.state.command, { type: 'command', result: { value: 2, label: 'from-graph' }, snapshot: { version: 1, tick: 2, time: 2 / 60, entities: [] } });
  assert.deepEqual(result.state.snapshot, { type: 'snapshot', snapshot: { version: 1, tick: 2, time: 2 / 60, entities: [] } });
  assert.deepEqual(cleaned, []);
  await runtime.dispose();
  assert.deepEqual(cleaned, ['counter']);
  assert.equal(world.disposed, false);
  world.dispose();
});

test('external World remains open and bridge-owned plugins are uninstallable on module disposal', async () => {
  const world = new World();
  let calls = 0;
  const plugin: Plugin = {
    id: 'owned-plugin',
    setup(target, scope) {
      scope.defer(target.registerCommand('owned.ping', () => { calls++; return 'pong'; }));
    }
  };
  const runtime = await createCompositionRuntime({
    graph: graph([worldNode('run', { type: 'command', command: { type: 'owned.ping' } })]),
    modules: [createWorldCompositionModule({ world, plugins: [plugin] })],
    initialState: { run: null }
  });
  await runtime.run();
  assert.equal(calls, 1);
  await runtime.dispose();
  assert.equal(world.disposed, false);
  assert.throws(() => world.command({ type: 'owned.ping' }), /Unknown command/);
  world.dispose();
});

test('owning bridge disposes its World and module capabilities stay in the manifest namespace', async () => {
  const world = new World();
  const cleaned: string[] = [];
  const module = createWorldCompositionModule({
    id: 'simulation',
    world,
    plugins: [worldPlugin(cleaned)],
    ownsWorld: true,
    capabilities: { 'simulation:clock': { now: () => 0 } },
    exposeWorld: true
  });
  assert.deepEqual(module.manifest.provides, ['simulation:clock', 'simulation:instance']);
  const runtime = await createCompositionRuntime({
    graph: graph([worldNode('snapshot', { type: 'snapshot' }, [], 'simulation')]),
    modules: [module],
    initialState: { snapshot: null }
  });
  await runtime.dispose();
  assert.equal(world.disposed, true);
  assert.deepEqual(cleaned, ['counter']);
  assert.throws(() => createWorldCompositionModule({ id: 'simulation', world: new World(), capabilities: { 'other:clock': {} } }), /namespace/);
});

test('World command result must be JSON serializable', async () => {
  const world = new World();
  world.install({ id: 'bad-result', setup(target, scope) { scope.defer(target.registerCommand('bad.result', () => undefined)); } });
  const runtime = await createCompositionRuntime({
    graph: graph([worldNode('run', { type: 'command', command: { type: 'bad.result' } })]),
    modules: [createWorldCompositionModule({ world })],
    initialState: { run: null }
  });
  await assert.rejects(runtime.run(), /JSON value/);
  assert.equal(world.tick, 0);
  await runtime.dispose();
  world.dispose();
});

test('World uninstall respects plugin dependencies and remains reversible', () => {
  const world = new World();
  const disposed: string[] = [];
  const base: Plugin = { id: 'base', setup(_world, scope) { scope.defer(() => disposed.push('base')); } };
  const dependent: Plugin = { id: 'dependent', requires: ['base'], setup(_world, scope) { scope.defer(() => disposed.push('dependent')); } };
  world.install(base);
  world.install(dependent);
  assert.throws(() => world.uninstall('base'), /dependent plugin dependent/);
  assert.equal(world.uninstall('dependent'), true);
  assert.equal(world.uninstall('base'), true);
  assert.deepEqual(disposed, ['dependent', 'base']);
  assert.equal(world.uninstall('base'), false);
  world.dispose();
});

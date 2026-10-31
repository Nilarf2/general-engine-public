import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CompositionError,
  TransactionConflictError,
  createCompositionRuntime,
  createModuleRegistry,
  validateCompositionGraph,
  type CompositionGraph,
  type CompositionModule,
  type GraphEdge,
  type JsonValue
} from '../src/composition/index.js';

const moduleNode = (id: string, module: string, edges: GraphEdge[] = []) => ({ id, type: 'module' as const, module, edges });
const graph = (nodes: CompositionGraph['nodes'], start = nodes[0]!.id, triggers?: CompositionGraph['triggers']): CompositionGraph => ({
  id: 'test-graph',
  version: 1,
  start,
  nodes,
  ...(triggers ? { triggers } : {})
});

function moduleOf(
  id: string,
  execute: CompositionModule['execute'],
  extra: Partial<CompositionModule['manifest']> = {}
): CompositionModule {
  return { manifest: { id, version: '1.0.0', apiVersion: 1, ...extra }, execute };
}

test('module registry orders dependencies, exposes declared capabilities, and cleans up in reverse order', async () => {
  const lifecycle: string[] = [];
  const dependent: CompositionModule = {
    manifest: { id: 'dependent', version: '1.0.0', apiVersion: 1, requires: { base: '1.0.0' } },
    setup(context) {
      lifecycle.push('dependent.setup');
      context.defer(() => { lifecycle.push('dependent.cleanup'); });
    },
    execute(context) {
      assert.deepEqual(context.capability<{ ready: boolean }>('base:service'), { ready: true });
      return true;
    }
  };
  const base = {
    manifest: { id: 'base', version: '1.0.0', apiVersion: 1 as const, provides: ['base:service'] },
    setup(context: Parameters<NonNullable<CompositionModule['setup']>>[0]) {
      lifecycle.push('base.setup');
      context.provide('base:service', { ready: true });
      return () => { lifecycle.push('base.cleanup'); };
    },
    execute() { return null; }
  } satisfies CompositionModule;
  const registry = createModuleRegistry([dependent, base]);
  assert.deepEqual(registry.ordered.map(module => module.manifest.id), ['base', 'dependent']);
  const runtime = await createCompositionRuntime({ graph: graph([moduleNode('start', 'dependent')]), modules: [dependent, base], initialState: {} });
  assert.deepEqual(lifecycle, ['base.setup', 'dependent.setup']);
  await runtime.dispose();
  assert.deepEqual(lifecycle, ['base.setup', 'dependent.setup', 'dependent.cleanup', 'base.cleanup']);
});

test('conditional edges use dataflow and stable priorities', async () => {
  const seen: string[] = [];
  const modules = [
    moduleOf('probe', async context => {
      seen.push(String(context.input));
      return context.input;
    }),
    moduleOf('fallback', async context => { seen.push(`fallback:${String(context.input)}`); return 'fallback'; })
  ];
  const nodes = [
    moduleNode('start', 'probe', [
      { to: 'fallback', priority: 10 },
      { to: 'selected', priority: 0, when: { op: 'eq', left: { from: 'state', path: '/route' }, right: { from: 'literal', value: 'selected' } } }
    ]),
    { ...moduleNode('selected', 'probe'), input: { from: 'node' as const, node: 'start' } },
    moduleNode('fallback', 'fallback')
  ];
  const runtime = await createCompositionRuntime({ graph: graph(nodes), modules, initialState: { route: 'selected' } });
  const result = await runtime.run('input');
  assert.equal(result.output, 'input');
  assert.deepEqual(seen, ['input', 'input']);
  assert.equal(runtime.revision, 1);
  await runtime.dispose();
});

test('parallel branches merge disjoint JSON Pointer writes and preserve branch order', async () => {
  const delays = new Map([['slow', 20], ['fast', 1]]);
  const module = moduleOf('write', async (context, input) => {
    await new Promise(resolve => setTimeout(resolve, delays.get(String(input)) ?? 0));
    context.set(`/values/${String(input)}`, input);
    context.effect('branch.finished', { name: input });
    return input;
  });
  const parallel = {
    id: 'all',
    type: 'parallel' as const,
    branches: [
      { id: 'slow-branch', version: 1 as const, start: 'write', nodes: [{ ...moduleNode('write', 'write'), input: { from: 'literal' as const, value: 'slow' } }] },
      { id: 'fast-branch', version: 1 as const, start: 'write', nodes: [{ ...moduleNode('write', 'write'), input: { from: 'literal' as const, value: 'fast' } }] }
    ],
    output: '/results'
  };
  const runtime = await createCompositionRuntime({ graph: graph([parallel]), modules: [module], initialState: { values: {}, results: [] } });
  const result = await runtime.run('slow');
  assert.deepEqual(result.state.values, { slow: 'slow', fast: 'fast' });
  assert.deepEqual(result.state.results, ['slow', 'fast']);
  assert.deepEqual(result.output, ['slow', 'fast']);
  assert.deepEqual(result.effects.map(effect => effect.payload), [{ name: 'slow' }, { name: 'fast' }]);
  await runtime.dispose();
});

test('parallel conflicting writes fail transactionally and retain the previous revision', async () => {
  const writer = moduleOf('writer', async context => {
    if (context.input === 'root') context.set('/shared', { value: 'root' });
    else context.set('/shared/value', context.input);
    return context.input;
  });
  const parallel = {
    id: 'all',
    type: 'parallel' as const,
    branches: [
      { id: 'one', version: 1 as const, start: 'write', nodes: [{ ...moduleNode('write', 'writer'), input: { from: 'literal' as const, value: 'root' } }] },
      { id: 'two', version: 1 as const, start: 'write', nodes: [{ ...moduleNode('write', 'writer'), input: { from: 'literal' as const, value: 'leaf' } }] }
    ]
  };
  const runtime = await createCompositionRuntime({ graph: graph([parallel]), modules: [writer], initialState: { shared: { value: 'before' } } });
  await assert.rejects(() => runtime.run(), (error: unknown) => error instanceof TransactionConflictError);
  assert.deepEqual(runtime.state, { shared: { value: 'before' } });
  assert.equal(runtime.revision, 0);
  await runtime.dispose();
});

test('events trigger graph entry points and effects remain an atomic outbox', async () => {
  const emitter = moduleOf('emitter', context => {
    context.emit('counter.bump', { amount: 2 });
    context.effect('toast', { message: 'queued' });
    return 'emitted';
  });
  const increment = moduleOf('increment', context => {
    const amount = context.event?.payload && typeof context.event.payload === 'object' && !Array.isArray(context.event.payload)
      ? context.event.payload.amount : 0;
    context.set('/count', (context.get('/count') as number) + Number(amount));
    return amount;
  });
  const runtime = await createCompositionRuntime({
    graph: graph(
      [moduleNode('emit', 'emitter'), moduleNode('increment', 'increment')],
      'emit',
      [{ id: 'counter', event: 'counter.bump', start: 'increment' }]
    ),
    modules: [emitter, increment],
    initialState: { count: 0 }
  });
  const result = await runtime.run(null);
  assert.equal(result.state.count, 2);
  assert.deepEqual(result.effects, [{ type: 'toast', payload: { message: 'queued' } }]);
  assert.deepEqual(result.events, [{ type: 'counter.bump', payload: { amount: 2 } }]);
  await runtime.dispose();
});

test('cancellation aborts module work without committing state or effects', async () => {
  const controller = new AbortController();
  const slow = moduleOf('slow', async context => {
    await new Promise<void>((resolve, reject) => {
      const abort = () => reject(new CompositionError('CANCELLED', 'aborted'));
      context.signal.addEventListener('abort', abort, { once: true });
      setTimeout(resolve, 50);
    });
    context.set('/done', true);
    context.effect('should.not.commit');
    return true;
  });
  const runtime = await createCompositionRuntime({ graph: graph([moduleNode('slow', 'slow')]), modules: [slow], initialState: { done: false } });
  const running = runtime.run(null, { signal: controller.signal });
  controller.abort('test cancellation');
  await assert.rejects(running, (error: unknown) => error instanceof CompositionError && error.code === 'CANCELLED');
  assert.deepEqual(runtime.state, { done: false });
  assert.equal(runtime.revision, 0);
  await runtime.dispose();
});

test('module errors discard state, emitted events, and effects from the whole run', async () => {
  const broken = moduleOf('broken', context => {
    context.set('/done', true);
    context.emit('done', { yes: true });
    context.effect('toast', { message: 'not committed' });
    throw new Error('module failed');
  });
  const runtime = await createCompositionRuntime({ graph: graph([moduleNode('broken', 'broken')]), modules: [broken], initialState: { done: false } });
  await assert.rejects(() => runtime.run(), /module failed/);
  assert.deepEqual(runtime.state, { done: false });
  assert.equal(runtime.revision, 0);
  await runtime.dispose();
});

test('concurrent run requests serialize against committed state', async () => {
  const counter = moduleOf('counter', async context => {
    const next = Number(context.get('/count')) + 1;
    await new Promise(resolve => setTimeout(resolve, 2));
    context.set('/count', next);
    return next;
  });
  const runtime = await createCompositionRuntime({ graph: graph([moduleNode('counter', 'counter')]), modules: [counter], initialState: { count: 0 } });
  const [first, second] = await Promise.all([runtime.run(), runtime.run()]);
  assert.equal(first.state.count, 1);
  assert.equal(second.state.count, 2);
  assert.deepEqual(runtime.state, { count: 2 });
  assert.equal(runtime.revision, 2);
  await runtime.dispose();
});

test('parallel array deletions conflict on their shared container pointer', async () => {
  const deleter = moduleOf('deleter', (context, input) => {
    context.delete(String(input));
    return input;
  });
  const parallel = {
    id: 'all',
    type: 'parallel' as const,
    branches: [
      { id: 'one', version: 1 as const, start: 'delete', nodes: [{ ...moduleNode('delete', 'deleter'), input: { from: 'literal' as const, value: '/items/0' } }] },
      { id: 'two', version: 1 as const, start: 'delete', nodes: [{ ...moduleNode('delete', 'deleter'), input: { from: 'literal' as const, value: '/items/1' } }] }
    ]
  };
  const runtime = await createCompositionRuntime({ graph: graph([parallel]), modules: [deleter], initialState: { items: ['a', 'b', 'c'] } });
  await assert.rejects(() => runtime.run(), (error: unknown) => error instanceof TransactionConflictError && error.paths.includes('/items'));
  assert.deepEqual(runtime.state, { items: ['a', 'b', 'c'] });
  await runtime.dispose();
});

test('dispatch executes matching triggers without treating its incoming event as outbox data', async () => {
  const receive = moduleOf('receive', context => {
    context.set('/received', context.event?.payload ?? null);
    context.effect('received');
  });
  const runtime = await createCompositionRuntime({
    graph: graph([moduleNode('receive', 'receive')], 'receive', [{ id: 'receive-event', event: 'message.in', start: 'receive' }]),
    modules: [receive], initialState: { received: null }
  });
  const result = await runtime.dispatch('message.in', { text: 'hello' });
  assert.deepEqual(result.state.received, { text: 'hello' });
  assert.deepEqual(result.events, []);
  assert.deepEqual(result.effects, [{ type: 'received', payload: null }]);
  await runtime.dispose();
});

test('event-trigger branches conflict transactionally and clean up every completed branch', async () => {
  const cleanup: string[] = [];
  const makeWriter = (id: string, value: string) => moduleOf(id, async context => {
    const name = String((context.event?.payload as { name: string }).name);
    context.defer(() => { cleanup.push(name); });
    context.set('/value', value);
    context.emit('branch.done', { name });
  });
  const one = makeWriter('writer-one', 'left');
  const two = makeWriter('writer-two', 'right');
  const runtime = await createCompositionRuntime({
    graph: graph(
      [moduleNode('write-one', 'writer-one'), moduleNode('write-two', 'writer-two')], 'write-one', [
        { id: 'one', event: 'write.both', start: 'write-one' },
        { id: 'two', event: 'write.both', start: 'write-two' }
      ]
    ),
    modules: [one, two], initialState: { value: null }
  });
  await assert.rejects(() => runtime.dispatch('write.both', { name: 'same' }), (error: unknown) => error instanceof TransactionConflictError);
  assert.deepEqual(runtime.state, { value: null });
  assert.deepEqual(cleanup, ['same', 'same']);
  await runtime.dispose();
});

test('dispose aborts the module lifetime and waits for active execution cleanup', async () => {
  const lifecycle: string[] = [];
  let setupSignal: AbortSignal | undefined;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const module: CompositionModule = {
    manifest: { id: 'owned', version: '1.0.0', apiVersion: 1 },
    setup(context) {
      setupSignal = context.signal;
      context.defer(() => { lifecycle.push('setup.cleanup'); });
    },
    async execute(context) {
      entered();
      context.defer(async () => {
        await new Promise(resolve => setTimeout(resolve, 2));
        lifecycle.push('run.cleanup');
      });
      await new Promise<void>((resolve, reject) => {
        context.signal.addEventListener('abort', () => reject(new CompositionError('CANCELLED', 'aborted')), { once: true });
      });
    }
  };
  const runtime = await createCompositionRuntime({ graph: graph([moduleNode('owned', 'owned')]), modules: [module], initialState: {} });
  const running = runtime.run();
  await started;
  const disposing = runtime.dispose();
  await assert.rejects(running, (error: unknown) => error instanceof CompositionError && error.code === 'CANCELLED');
  await disposing;
  assert.equal(setupSignal?.aborted, true);
  assert.deepEqual(lifecycle, ['run.cleanup', 'setup.cleanup']);
});

test('graph validation rejects invalid pointers, duplicate trigger IDs, and unknown edge destinations', () => {
  assert.throws(() => validateCompositionGraph(graph([moduleNode('start', 'missing', [{ to: 'nope' }])])), /Edge destination/);
  assert.throws(() => validateCompositionGraph(graph([{ ...moduleNode('start', 'missing'), output: '/bad~2escape' }])), /Invalid escape/);
  assert.throws(() => validateCompositionGraph({
    ...graph([moduleNode('start', 'missing')]),
    triggers: [{ id: 'same', event: 'one', start: 'start' }, { id: 'same', event: 'two', start: 'start' }]
  }), /Duplicate trigger/);
});

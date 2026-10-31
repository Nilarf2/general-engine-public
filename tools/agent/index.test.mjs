import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  AgentGatewayError,
  createAgentCatalog,
  createAgentToolGateway,
  validateAgentCatalog,
} from './index.mjs';

const descriptor = (overrides = {}) => ({
  manifest: { id: 'scene', version: '1.0.0', apiVersion: 1, requires: {}, provides: ['scene:inspect'] },
  description: 'Inspect a JSON scene.',
  tags: ['content', 'read'],
  permissions: ['scene:read'],
  inputSchema: {
    type: 'object', additionalProperties: false, required: ['scene'],
    properties: { scene: { type: 'object', additionalProperties: false, required: ['entities'], properties: { entities: { type: 'array', items: { type: 'object' } } } } },
  },
  outputSchema: {
    type: 'object', additionalProperties: false, required: ['entityCount'],
    properties: { entityCount: { type: 'integer', minimum: 0 } },
  },
  ...overrides,
});

const makeGateway = (options = {}) => {
  const catalog = options.catalog ?? createAgentCatalog([descriptor()]);
  return createAgentToolGateway({
    catalog,
    handlers: options.handlers ?? { scene: input => ({ entityCount: input.scene.entities.length }) },
    grantedPermissions: options.grantedPermissions ?? ['scene:read'],
    ...options,
  });
};

async function rejectsCode(promise, code) {
  await assert.rejects(promise, error => error instanceof AgentGatewayError && error.code === code);
}

test('catalog revisions are deterministic, sorted and content-sensitive', () => {
  const first = createAgentCatalog([descriptor(), { ...descriptor(), manifest: { ...descriptor().manifest, id: 'world', provides: ['world:step'] } }]);
  const reordered = createAgentCatalog([{ ...descriptor(), manifest: { ...descriptor().manifest, id: 'world', provides: ['world:step'] } }, descriptor()]);
  assert.equal(first.revision, reordered.revision);
  assert.deepEqual(first.modules.map(module => module.manifest.id), ['scene', 'world']);
  const changed = createAgentCatalog([descriptor({ description: 'Different summary.' })]);
  assert.notEqual(first.revision, changed.revision);
  assert.equal(validateAgentCatalog(first).revision, first.revision);
  assert.throws(() => validateAgentCatalog({ ...first, revision: '0'.repeat(64) }), { code: 'REVISION_MISMATCH' });
});

test('discovery filters by query and capability and detects stale read revisions', async () => {
  const gateway = makeGateway();
  const found = await gateway.call('engine.catalog.list', { query: 'SCENE', capability: 'scene:inspect' });
  assert.equal(found.modules.length, 1);
  assert.equal(found.modules[0].manifest.id, 'scene');
  assert.deepEqual(await gateway.call('engine.catalog.list', { expectedRevision: found.revision }), found);
  await rejectsCode(gateway.call('engine.catalog.list', { expectedRevision: '0'.repeat(64) }), 'REVISION_MISMATCH');
  await rejectsCode(gateway.call('engine.catalog.describe', { moduleId: 'scene', expectedRevision: '0'.repeat(64) }), 'REVISION_MISMATCH');
});

test('invocation requires current revision, exact host grants, and valid input and output', async () => {
  let executions = 0;
  const catalog = createAgentCatalog([descriptor()]);
  const denied = makeGateway({ catalog, grantedPermissions: [], handlers: { scene: () => { executions++; return { entityCount: 0 }; } } });
  await rejectsCode(denied.call('engine.module.invoke', { moduleId: 'scene', revision: catalog.revision, input: { scene: { entities: [] } } }), 'PERMISSION_DENIED');
  assert.equal(executions, 0);

  const gateway = makeGateway({ catalog, handlers: { scene: input => { executions++; return { entityCount: input.scene.entities.length }; } } });
  const result = await gateway.call('engine.module.invoke', { moduleId: 'scene', revision: catalog.revision, input: { scene: { entities: [{ id: 'player' }] } } });
  assert.deepEqual(result.output, { entityCount: 1 });
  assert.equal(executions, 1);
  await rejectsCode(gateway.call('engine.module.invoke', { moduleId: 'scene', revision: '0'.repeat(64), input: { scene: { entities: [] } } }), 'REVISION_MISMATCH');
  await rejectsCode(gateway.call('engine.module.invoke', { moduleId: 'scene', revision: catalog.revision, input: { scene: { entities: [], extra: true } } }), 'INPUT_INVALID');

  const badOutput = makeGateway({ catalog, handlers: { scene: () => ({ entityCount: -1 }) } });
  await rejectsCode(badOutput.call('engine.module.invoke', { moduleId: 'scene', revision: catalog.revision, input: { scene: { entities: [] } } }), 'OUTPUT_INVALID');
});

test('gateway bounds serialized values and invocation count', async () => {
  const catalog = createAgentCatalog([descriptor()]);
  const gateway = makeGateway({ catalog, maxInputBytes: 40, maxOutputBytes: 20, maxCalls: 1 });
  await rejectsCode(gateway.call('engine.module.invoke', { moduleId: 'scene', revision: catalog.revision, input: { scene: { entities: [{ payload: 'x'.repeat(100) }] } } }), 'INPUT_LIMIT');
  await gateway.call('engine.module.invoke', { moduleId: 'scene', revision: catalog.revision, input: { scene: { entities: [] } } });
  await rejectsCode(gateway.call('engine.module.invoke', { moduleId: 'scene', revision: catalog.revision, input: { scene: { entities: [] } } }), 'CALL_LIMIT');

  const oversizedOutput = makeGateway({ catalog, maxOutputBytes: 10, handlers: { scene: () => ({ entityCount: 123456 }) } });
  await rejectsCode(oversizedOutput.call('engine.module.invoke', { moduleId: 'scene', revision: catalog.revision, input: { scene: { entities: [] } } }), 'OUTPUT_LIMIT');
});

test('catalog schema rejects foreign capabilities, unsupported references, and wildcard grants', () => {
  assert.throws(() => createAgentCatalog([descriptor({ manifest: { ...descriptor().manifest, provides: ['world:inspect'] } })]), { code: 'MODULE_INVALID' });
  assert.throws(() => createAgentCatalog([descriptor({ inputSchema: { $ref: 'https://example.invalid/schema.json' } })]), { code: 'SCHEMA_UNSUPPORTED' });
  assert.throws(() => createAgentCatalog([descriptor({ unknown: 'ignored?' })]), { code: 'CATALOG_INVALID' });
  assert.throws(() => makeGateway({ grantedPermissions: ['scene:*'] }), { code: 'PERMISSIONS_INVALID' });
});

test('checked-in example catalog and contracts match the runtime gateway', async () => {
  const example = JSON.parse(await readFile(new URL('../../docs/agent/example-catalog.json', import.meta.url), 'utf8'));
  assert.equal(validateAgentCatalog(example).modules[0].manifest.id, 'scene');
  const contracts = JSON.parse(await readFile(new URL('../../docs/agent/tool-contracts.json', import.meta.url), 'utf8'));
  assert.deepEqual(contracts.map(contract => contract.name), ['engine.catalog.list', 'engine.catalog.describe', 'engine.module.invoke']);
});

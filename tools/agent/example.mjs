import { createAgentCatalog, createAgentToolGateway } from './index.mjs';

const catalog = createAgentCatalog([{
  manifest: {
    id: 'scene',
    version: '1.0.0',
    apiVersion: 1,
    requires: {},
    provides: ['scene:inspect'],
  },
  description: 'Read a validated scene summary from a caller-owned JSON value.',
  tags: ['content', 'read'],
  permissions: ['scene:read'],
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['scene'],
    properties: { scene: { type: 'object' } },
  },
  outputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['entityCount'],
    properties: { entityCount: { type: 'integer', minimum: 0 } },
  },
}]);

const gateway = createAgentToolGateway({
  catalog,
  grantedPermissions: ['scene:read'],
  handlers: {
    scene(input) {
      return { entityCount: Array.isArray(input.scene.entities) ? input.scene.entities.length : 0 };
    },
  },
});

const discovered = await gateway.call('engine.catalog.list', { query: 'scene' });
const result = await gateway.call('engine.module.invoke', {
  moduleId: 'scene',
  revision: discovered.revision,
  input: { scene: { entities: [{ id: 'floor' }, { id: 'player' }] } },
});
console.log(JSON.stringify({ discovered, result }, null, 2));

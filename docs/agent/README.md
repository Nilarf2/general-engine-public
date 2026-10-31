# Agent-native workflow / 面向 Agent 的工作流

This directory defines the offline boundary between an Agent and the General Engine. The host publishes a signed-by-content module catalog, exposes the small tool contract list, and supplies trusted handlers. Agent-authored JSON can select a module and provide data, but it cannot load a module, add a permission, or replace a handler.

本目录定义 Agent 与 General Engine 之间的离线边界。宿主发布由内容计算修订号的模块目录，暴露固定的工具合同，并提供受信任的处理函数。Agent 生成的 JSON 只能选择模块并提供数据，不能加载代码、添加权限或替换处理函数。

The current files are:

- [`module-catalog.schema.json`](module-catalog.schema.json): portable catalog shape. A catalog contains versioned manifests, capability declarations, permission names, and input/output JSON Schemas.
- [`tool-contracts.json`](tool-contracts.json): the three public tools: `engine.catalog.list`, `engine.catalog.describe`, and `engine.module.invoke`.
- [`tool-contracts.schema.json`](tool-contracts.schema.json): schema for the contract document itself.
- [`example-catalog.json`](example-catalog.json): a complete catalog with a reproducible revision.
- [`../tools/agent/index.mjs`](../../tools/agent/index.mjs): host-side implementation and validation library.
- [`../tools/agent/cli.mjs`](../../tools/agent/cli.mjs): offline catalog validator and inspector.

The module catalog is content-addressed. `createAgentCatalog()` sorts modules and manifest arrays into a canonical representation and calculates a SHA-256 `revision`. A caller must echo that exact revision when invoking a module. A changed catalog therefore produces a stale-call error instead of silently applying a request to a different module set.

模块目录使用内容寻址。`createAgentCatalog()` 对模块和清单数组排序，生成规范表示后计算 SHA-256 `revision`。调用模块时必须回传完全相同的修订号。目录变化会产生过期调用错误，不会把请求静默地应用到另一组模块。

Use the library in a host process:

```js
import { createAgentCatalog, createAgentToolGateway } from './tools/agent/index.mjs';

const catalog = createAgentCatalog([{
  manifest: {
    id: 'scene', version: '1.0.0', apiVersion: 1,
    requires: {}, provides: ['scene:inspect'],
  },
  description: 'Read a scene summary.',
  tags: ['content', 'read'],
  permissions: ['scene:read'],
  inputSchema: {
    type: 'object', additionalProperties: false, required: ['scene'],
    properties: { scene: { type: 'object' } },
  },
  outputSchema: {
    type: 'object', additionalProperties: false, required: ['entityCount'],
    properties: { entityCount: { type: 'integer', minimum: 0 } },
  },
}]);

const gateway = createAgentToolGateway({
  catalog,
  grantedPermissions: ['scene:read'],
  // This function is selected by the host, never by the Agent.
  handlers: { scene: input => ({ entityCount: input.scene.entities.length }) },
});

const discovery = await gateway.call('engine.catalog.list', {});
const response = await gateway.call('engine.module.invoke', {
  moduleId: 'scene', revision: discovery.revision,
  input: { scene: { entities: [] } },
});
```

`engine.catalog.list` and `engine.catalog.describe` are read-only and accept an optional `expectedRevision`. `engine.module.invoke` requires `moduleId`, `revision`, and `input`. The gateway checks the revision, required permissions, serialized input/output byte limits, invocation count, and each module's JSON Schema before and after calling the trusted handler. The handler receives only a cloned JSON input and `{ signal, revision, moduleId }`; it cannot mutate the catalog.

`engine.catalog.list` 与 `engine.catalog.describe` 是只读工具，可选 `expectedRevision`。`engine.module.invoke` 必须提供 `moduleId`、`revision` 和 `input`。网关在调用受信任处理函数前后检查修订号、权限、输入输出序列化字节数、调用次数以及模块 JSON Schema。处理函数只收到 JSON 输入的副本和 `{ signal, revision, moduleId }`，无法修改目录。

Permissions are exact strings such as `scene:read` or `save:write`; wildcard grants are rejected. Keep broad capabilities out of a module descriptor. If an operation needs a new permission, add it to host configuration and review the catalog change. The gateway performs no network access or credential lookup and never dynamically imports a handler. The CLI only reads the catalog path explicitly supplied by its caller.

权限是 `scene:read`、`save:write` 等精确字符串，网关拒绝通配符授权。不要在模块清单中放置宽泛能力；新操作需要新权限时，应修改宿主配置并审核目录变化。网关不会联网或查找凭据，也不会动态导入处理函数。CLI 只读取调用方明确提供的目录路径。

Validate a catalog before publishing it:

```sh
node tools/agent/cli.mjs validate docs/agent/example-catalog.json
node tools/agent/cli.mjs list docs/agent/example-catalog.json
node tools/agent/cli.mjs revision docs/agent/example-catalog.json
node tools/agent/example.mjs
node --test tools/agent/index.test.mjs
```

The JSON Schema files document the interchange format for editors and other languages. The JavaScript gateway intentionally implements a bounded, offline JSON Schema subset and rejects `$ref`, unknown keywords, reserved object keys, non-JSON values, and excessively deep schemas. A different host may use a full JSON Schema validator after applying the same catalog and permission rules.

JSON Schema 文件用于编辑器和其他语言的互操作格式。JavaScript 网关有意实现受限的离线 JSON Schema 子集，并拒绝 `$ref`、未知关键字、保留对象键、非 JSON 值和过深的 schema。其他宿主可以在相同目录与权限规则上使用完整 JSON Schema 验证器。

This is a host integration boundary, not a sandbox for untrusted JavaScript. Put handlers in reviewed host code and pass only data to them. Keep module side effects explicit in the descriptor and tool contract; the gateway enforces declared permissions but cannot make a trusted handler safe if the host itself gives it excessive authority.

这是宿主集成边界，不是运行不受信任 JavaScript 的沙箱。处理函数必须放在经过审核的宿主代码中，网关只向它传递数据。模块副作用应在描述符和工具合同中明确；网关会执行声明的权限，但宿主若授予处理函数过大权限，网关无法替代宿主完成安全隔离。

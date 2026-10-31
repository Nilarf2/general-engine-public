# Composition Core

## 组合核心

组合模块是通用引擎中不依赖外部包的编排边界。它通过经过校验的图执行带版本的模块；渲染、物理、剧情呈现、存储和宿主服务仍由可选模块或宿主负责。

The composition package is the dependency-free orchestration boundary of the general engine. It executes versioned modules through a validated graph while leaving rendering, physics, narrative presentation, storage, and host services outside the core.

## Module contract

每个 `CompositionModule` 都有 `ModuleManifest`，声明 API 版本、模块版本、依赖项和能力。注册表在 setup 前解析依赖关系。setup 会收到 `AbortSignal`，只能发布已声明的能力，并可注册按逆序执行的清理函数。setup 失败时，引擎会先清理已初始化的模块。

Each `CompositionModule` has a `ModuleManifest` with an explicit API version, module version, dependencies, and declared capabilities. The registry resolves dependencies before setup. Setup receives an `AbortSignal`, may publish only declared capabilities, and may register reverse-order cleanup handlers. A failed setup disposes already-created module scopes before the error escapes.

## Graph contract

`CompositionGraph` 是带版本的有向图。模块节点调用已注册模块；并行节点会基于同一份状态快照执行子图。边条件可读取状态、输入、事件负载、上一步结果和节点结果。边的优先级数值越小越先检查，优先级相同时按目标节点 ID 稳定排序。事件触发器将事件路由到图入口。

`CompositionGraph` is a versioned directed graph. A module node invokes one registered module; a parallel node executes independent subgraphs against one state snapshot. Edges are selected by conditions over state, input, event payloads, prior results, and node results. Lower edge priority wins, with destination ID as the deterministic tie-breaker. Trigger entries provide event-to-subgraph routing.

条件路由不依赖边的声明顺序。并行分支结果总按分支声明顺序返回，即使异步完成顺序不同。只有 JSON Pointer 写入路径互不重叠，或操作和值都相同的重复写入，才能合并。父路径与子路径同时被写入时视为冲突。

Declaration order does not determine conditional routing. Parallel branch results are returned in branch declaration order even when asynchronous work completes in another order. Branch writes are merged only when their JSON Pointer footprints are disjoint or exactly equivalent. A write to a pointer and a write to one of its descendants are overlapping writes and fail with `TransactionConflictError` when they disagree.

## Transactions and effects

每次 `run()` 或 `dispatch()` 都从最近一次已提交状态开始。模块写入、事件和副作用会先缓存在事务中，直到图和事件触发器全部执行成功。模块异常、无效指针、写入冲突、执行次数超限或取消都会丢弃整个事务，并保持状态和版本号不变。副作用以 outbox 记录返回，宿主负责在提交后投递。

Every `run()` or `dispatch()` starts from the last committed state. Module writes, emitted events, and effects are held in a transaction until graph execution and event-trigger processing complete. A module failure, invalid pointer, conflict, execution-limit breach, or cancellation discards the complete transaction and leaves the state and revision unchanged. Effects are records in an outbox; hosts decide how and when to deliver them after commit.

JSON Pointer 必须是绝对路径，父节点必须已存在，数组索引必须指向已有元素，并且保留对象键会被拒绝。状态在对外提供前会复制；返回的快照与运行时内部状态分离。

JSON Pointer paths are absolute. Existing parents are required, array indexes must address existing elements, and reserved object keys are rejected. State is cloned before exposure and returned snapshots are detached from the runtime.

## Cancellation and cleanup

调用方可通过外部 signal 或 `runtime.cancel()` 取消执行。长任务需要检查模块上下文的 signal；运行时会在 await 前后及提交前再次检查。取消不会提交状态、事件或副作用。`runtime.dispose()` 会中止活动执行，并按逆序等待模块清理完成。

An execution can be cancelled with an external signal or `runtime.cancel()`. Modules must observe the context signal for long-running work; the runtime checks cancellation before and after awaits and before commit. Cancellation prevents state, events, and effects from committing. `runtime.dispose()` aborts active work, then awaits module cleanup in reverse registration order.

组合核心不包含基于实时时钟的调度器、重试策略、存档格式或副作用投递适配器。这些策略属于宿主，或未来拥有独立版本契约的模块。

The composition core intentionally does not provide a wall-clock scheduler, retry policy, persistence format, or effect delivery adapter. Those policies belong to the host or a future module with its own versioned contract.

## Fixed-step World adapter

`createWorldCompositionModule({ world, plugins, ownsWorld })` adapts the existing synchronous `World` plugin API into the composition module contract. The module installs its explicit plugin list during setup and removes those plugins in reverse order when disposed; set `ownsWorld: true` only when the adapter owns the World, in which case disposal closes the World and all of its plugins. `World.uninstall(id)` is reversible and refuses to remove a plugin while an installed dependent still needs it.

The module accepts JSON operations: `{ "type": "step", "count": 1 }`, `{ "type": "advance", "seconds": 0.016 }`, `{ "type": "snapshot" }`, or `{ "type": "command", "command": { "type": "game.move", "direction": "north" } }`. Each result is JSON, includes a detached World snapshot, and command results must themselves be valid JSON. Optional host capabilities are declared in the manifest namespace (for example `world:clock`); a World instance is exposed only when `exposeWorld` is explicitly enabled.

Composition transactions cover the composition state and its event/effect outboxes. They cannot roll back mutations performed inside a World step or command if a later graph node fails. Keep World operations near the end of a graph run or make commands idempotent/compensatable when that boundary matters. A non-owning adapter also requires that no external plugin remain installed with a dependency on one of the adapter's plugins when the composition runtime is disposed.

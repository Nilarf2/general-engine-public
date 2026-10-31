import {
  assertJson,
  assertName,
  cloneJson,
  deepFreeze,
  encodePointer,
  isRecord,
  jsonEqual,
  parsePointer,
  pointerDelete,
  pointerGet,
  pointerSet
} from './json.js';
import {
  createModuleRegistry,
  createSetupContext,
  ModuleScope,
  type CapabilityMap,
} from './modules.js';
import {
  CompositionError,
  TransactionConflictError,
  type CompositionGraph,
  type CompositionModule,
  type CompositionNode,
  type Condition,
  type ConditionContext,
  type DataRef,
  type EffectRecord,
  type ExecutionOptions,
  type ExecutionResult,
  type GraphEdge,
  type JsonObject,
  type JsonValue,
  type ModuleExecutionContext,
  type ParallelNode,
  type RuntimeEvent,
  type RuntimeOptions,
  type Subgraph,
  type CompositionRuntime
} from './types.js';

interface Write {
  readonly path: string;
  /** The pointer footprint used for branch conflict detection. */
  readonly footprint: string;
  readonly kind: 'set' | 'delete';
  readonly value?: JsonValue;
}

interface Transaction {
  state: JsonObject;
  readonly writes: Write[];
  readonly results: Map<string, JsonValue>;
  readonly events: RuntimeEvent[];
  readonly pendingEvents: RuntimeEvent[];
  readonly effects: EffectRecord[];
  lastResult: JsonValue;
}

interface GraphRunResult {
  readonly output: JsonValue;
  readonly executions: number;
}

function abortError(signal: AbortSignal): CompositionError {
  const reason = signal.reason;
  return new CompositionError('CANCELLED', reason instanceof Error ? reason.message : reason === undefined ? 'Composition execution was cancelled' : String(reason));
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError(signal);
}

function pointerRelation(left: string, right: string): boolean {
  if (left === right) return true;
  const a = parsePointer(left);
  const b = parsePointer(right);
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;
  return shorter.every((segment, index) => segment === longer[index]);
}

function writesEquivalent(left: Write, right: Write): boolean {
  return left.path === right.path && left.kind === right.kind &&
    (left.kind === 'delete' || (left.value !== undefined && right.value !== undefined && jsonEqual(left.value, right.value)));
}

function validateDataRef(ref: unknown, path: string): void {
  if (!isRecord(ref) || typeof ref.from !== 'string') throw new CompositionError('DATA_REF', `Invalid data reference at ${path}`);
  switch (ref.from) {
    case 'literal': assertJson(ref.value, `${path}/value`); return;
    case 'state':
    case 'input':
    case 'result':
    case 'event':
    case 'node':
      if (ref.from === 'state' && typeof ref.path !== 'string') throw new CompositionError('DATA_REF', `State references require a JSON Pointer at ${path}`);
      if (ref.path !== undefined) {
        if (typeof ref.path !== 'string') throw new CompositionError('DATA_REF', `Invalid data reference path at ${path}`);
        parsePointer(ref.path);
      }
      if (ref.from === 'node') assertName(ref.node, `${path}/node`);
      return;
    default: throw new CompositionError('DATA_REF', `Unknown data reference source at ${path}`);
  }
}

function validateCondition(condition: unknown, path: string): void {
  if (!isRecord(condition) || typeof condition.op !== 'string') throw new CompositionError('CONDITION', `Invalid condition at ${path}`);
  switch (condition.op) {
    case 'and':
    case 'or':
      if (!Array.isArray(condition.conditions)) throw new CompositionError('CONDITION', `Condition list required at ${path}`);
      condition.conditions.forEach((child, index) => validateCondition(child, `${path}/conditions/${index}`));
      return;
    case 'not': validateCondition(condition.condition, `${path}/condition`); return;
    case 'exists': validateDataRef(condition.value, `${path}/value`); return;
    case 'eq': case 'ne': case 'gt': case 'gte': case 'lt': case 'lte':
      validateDataRef(condition.left, `${path}/left`); validateDataRef(condition.right, `${path}/right`); return;
    default:
      if (!/^[a-z][a-z0-9-]*:[A-Za-z0-9_.-]+$/.test(condition.op)) throw new CompositionError('CONDITION', `Unknown condition operator at ${path}`);
      if (condition.data !== undefined) assertJson(condition.data, `${path}/data`);
  }
}

function validateEdge(edge: unknown, path: string, nodeIds: ReadonlySet<string>): void {
  if (!isRecord(edge) || typeof edge.to !== 'string' || !nodeIds.has(edge.to)) throw new CompositionError('GRAPH_EDGE', `Edge destination is missing at ${path}`);
  if (edge.priority !== undefined && (typeof edge.priority !== 'number' || !Number.isFinite(edge.priority))) throw new CompositionError('GRAPH_EDGE', `Edge priority must be finite at ${path}`);
  if (edge.when !== undefined) validateCondition(edge.when, `${path}/when`);
}

function validateSubgraph(graph: Subgraph, path: string): void {
  if (!isRecord(graph)) throw new CompositionError('GRAPH', `Expected graph object at ${path}`);
  assertName(graph.id, `${path}/id`);
  if (graph.version !== 1) throw new CompositionError('GRAPH_VERSION', `Unsupported graph version at ${path}`);
  if (!Array.isArray(graph.nodes) || graph.nodes.length === 0) throw new CompositionError('GRAPH_NODES', `Graph needs nodes at ${path}`);
  if (typeof graph.start !== 'string') throw new CompositionError('GRAPH_START', `Graph start must be a node ID at ${path}`);
  const ids = new Set<string>();
  for (const [index, node] of graph.nodes.entries()) {
    if (!isRecord(node)) throw new CompositionError('GRAPH_NODE', `Invalid node at ${path}/nodes/${index}`);
    assertName(node.id, `${path}/nodes/${index}/id`);
    if (ids.has(node.id)) throw new CompositionError('GRAPH_NODE_DUPLICATE', `Duplicate node ID: ${node.id}`);
    ids.add(node.id);
    if (node.type === 'module') {
      assertName(node.module, `${path}/nodes/${index}/module`);
      if (node.input !== undefined) validateDataRef(node.input, `${path}/nodes/${index}/input`);
      if (node.output !== undefined) {
        if (typeof node.output !== 'string') throw new CompositionError('GRAPH_OUTPUT', `Node output must be a JSON Pointer: ${node.id}`);
        parsePointer(node.output);
      }
    } else if (node.type === 'parallel') {
      if (!Array.isArray(node.branches) || node.branches.length === 0) throw new CompositionError('GRAPH_BRANCHES', `Parallel node needs branches: ${node.id}`);
      for (const [branchIndex, branch] of node.branches.entries()) validateSubgraph(branch, `${path}/nodes/${index}/branches/${branchIndex}`);
      if (node.output !== undefined) {
        if (typeof node.output !== 'string') throw new CompositionError('GRAPH_OUTPUT', `Node output must be a JSON Pointer: ${node.id}`);
        parsePointer(node.output);
      }
    } else {
      throw new CompositionError('GRAPH_NODE_TYPE', `Unknown graph node type at ${path}/nodes/${index}`);
    }
  }
  if (!ids.has(graph.start)) throw new CompositionError('GRAPH_START', `Graph start node is missing: ${graph.start}`);
  for (const [index, node] of graph.nodes.entries()) {
    for (const [edgeIndex, edge] of (node.edges ?? []).entries()) validateEdge(edge, `${path}/nodes/${index}/edges/${edgeIndex}`, ids);
  }
}

export function validateCompositionGraph(graph: CompositionGraph): void {
  validateSubgraph(graph, '$');
  if (graph.triggers !== undefined) {
    if (!Array.isArray(graph.triggers)) throw new CompositionError('GRAPH_TRIGGERS', 'triggers must be an array');
    const ids = new Set<string>();
    const nodeIds = new Set(graph.nodes.map(node => node.id));
    for (const [index, trigger] of graph.triggers.entries()) {
      if (!isRecord(trigger) || typeof trigger.id !== 'string' || !trigger.id.trim() || typeof trigger.event !== 'string' || !trigger.event.trim() || typeof trigger.start !== 'string' || !nodeIds.has(trigger.start)) {
        throw new CompositionError('GRAPH_TRIGGER', `Invalid trigger at $/triggers/${index}`);
      }
      if (ids.has(trigger.id)) throw new CompositionError('GRAPH_TRIGGER_DUPLICATE', `Duplicate trigger ID: ${trigger.id}`);
      ids.add(trigger.id);
      if (trigger.when !== undefined) validateCondition(trigger.when, `$/triggers/${index}/when`);
    }
  }
}

function validateGraphModules(graph: Subgraph, modules: ReadonlyMap<string, CompositionModule>): void {
  for (const node of graph.nodes) {
    if (node.type === 'module' && !modules.has(node.module)) {
      throw new CompositionError('MODULE_UNKNOWN', `Graph references unavailable module: ${node.module}`);
    }
    if (node.type === 'parallel') for (const branch of node.branches) validateGraphModules(branch, modules);
  }
}

function validateConditionHandlers(graph: Subgraph | CompositionGraph, conditions: ReadonlyMap<string, (context: ConditionContext, data?: JsonValue) => boolean>): void {
  const inspect = (condition: Condition): void => {
    switch (condition.op) {
      case 'and': case 'or': condition.conditions.forEach(inspect); break;
      case 'not': inspect(condition.condition); break;
      case 'exists': case 'eq': case 'ne': case 'gt': case 'gte': case 'lt': case 'lte': break;
      default:
        if (!conditions.has(condition.op)) throw new CompositionError('CONDITION_UNKNOWN', `Condition is not registered: ${condition.op}`);
    }
  };
  for (const node of graph.nodes) {
    for (const edge of node.edges ?? []) if (edge.when) inspect(edge.when);
    if (node.type === 'parallel') for (const branch of node.branches) validateConditionHandlers(branch, conditions);
  }
  if ('triggers' in graph) {
    const root = graph as CompositionGraph;
    for (const trigger of root.triggers ?? []) if (trigger.when) inspect(trigger.when);
  }
}

function createTransaction(state: JsonObject): Transaction {
  return { state: cloneJson(state), writes: [], results: new Map(), events: [], pendingEvents: [], effects: [], lastResult: null };
}

function recordSet(tx: Transaction, path: string, value: JsonValue): void {
  assertJson(value);
  const canonical = encodePointer(parsePointer(path));
  if (!canonical) {
    if (!isRecord(value)) throw new CompositionError('STATE_ROOT', 'The root state must remain a JSON object');
    tx.state = cloneJson(value);
  } else {
    tx.state = pointerSet(tx.state, canonical, value);
  }
  tx.writes.push({ path: canonical, footprint: canonical, kind: 'set', value: cloneJson(value) });
}

function recordDelete(tx: Transaction, path: string): void {
  const canonical = encodePointer(parsePointer(path));
  const deleted = pointerDelete(tx.state, canonical);
  tx.state = deleted.state;
  tx.writes.push({ path: canonical, footprint: deleted.footprint, kind: 'delete' });
}

function resolveDataRef(ref: DataRef, tx: Transaction, input: JsonValue, event?: RuntimeEvent): JsonValue | undefined {
  const extract = (value: JsonValue | undefined, path?: string): JsonValue | undefined => {
    const resolved = path === undefined ? value : value === undefined ? undefined : pointerGet(value, path);
    return resolved === undefined ? undefined : cloneJson(resolved);
  };
  switch (ref.from) {
    case 'literal': return cloneJson(ref.value);
    case 'state': return extract(pointerGet(tx.state, ref.path), undefined);
    case 'input': return extract(input, ref.path);
    case 'result': return extract(tx.lastResult, ref.path);
    case 'event': return extract(event?.payload, ref.path);
    case 'node': return extract(tx.results.get(ref.node), ref.path);
  }
}

function conditionValue(context: ConditionContext, ref: DataRef): JsonValue | undefined {
  const extract = (value: JsonValue | undefined, path?: string): JsonValue | undefined => path === undefined ? value : value === undefined ? undefined : pointerGet(value, path);
  switch (ref.from) {
    case 'literal': return cloneJson(ref.value);
    case 'state': return context.get(ref.path);
    case 'input': return extract(context.input, ref.path);
    case 'result': return extract(context.previous, ref.path);
    case 'event': return extract(context.event?.payload, ref.path);
    case 'node': return extract(context.nodeResult(ref.node), ref.path);
  }
}

function compareCondition(left: JsonValue | undefined, right: JsonValue | undefined, operator: string): boolean {
  switch (operator) {
    case 'eq': return left !== undefined && right !== undefined && jsonEqual(left, right);
    case 'ne': return left === undefined || right === undefined ? left !== right : !jsonEqual(left, right);
    case 'gt': case 'gte': case 'lt': case 'lte': {
      if ((typeof left !== 'number' && typeof left !== 'string') || typeof left !== typeof right) return false;
      if (operator === 'gt') return left > (right as typeof left);
      if (operator === 'gte') return left >= (right as typeof left);
      if (operator === 'lt') return left < (right as typeof left);
      return left <= (right as typeof left);
    }
    default: return false;
  }
}

function evaluateCondition(
  condition: Condition,
  context: ConditionContext,
  conditions: ReadonlyMap<string, (context: ConditionContext, data?: JsonValue) => boolean>
): boolean {
  switch (condition.op) {
    case 'and': return condition.conditions.every(child => evaluateCondition(child, context, conditions));
    case 'or': return condition.conditions.some(child => evaluateCondition(child, context, conditions));
    case 'not': return !evaluateCondition(condition.condition, context, conditions);
    case 'exists': return conditionValue(context, condition.value) !== undefined;
    case 'eq': case 'ne': case 'gt': case 'gte': case 'lt': case 'lte':
      return compareCondition(conditionValue(context, condition.left), conditionValue(context, condition.right), condition.op);
    default: {
      const handler = conditions.get(condition.op);
      if (!handler) throw new CompositionError('CONDITION_UNKNOWN', `Condition is not registered: ${condition.op}`);
      return Boolean(handler(context, condition.data));
    }
  }
}

function createConditionContext(tx: Transaction, input: JsonValue, event: RuntimeEvent | undefined, signal: AbortSignal): ConditionContext {
  const cloneOptional = (value: JsonValue | undefined): JsonValue | undefined => value === undefined ? undefined : cloneJson(value);
  return Object.freeze({
    signal,
    input: deepFreeze(cloneJson(input)),
    previous: deepFreeze(cloneJson(tx.lastResult)),
    ...(event ? { event: deepFreeze({ type: event.type, payload: cloneJson(event.payload) }) } : {}),
    get(path: string): JsonValue | undefined { return cloneOptional(pointerGet(tx.state, path)); },
    nodeResult(nodeId: string): JsonValue | undefined { return cloneOptional(tx.results.get(nodeId)); }
  });
}

function createModuleContext(
  tx: Transaction,
  input: JsonValue,
  event: RuntimeEvent | undefined,
  previous: JsonValue,
  signal: AbortSignal,
  capabilities: CapabilityMap,
  scope: ModuleScope,
  lifecycle: { active: boolean }
): ModuleExecutionContext {
  const cloneOptional = (value: JsonValue | undefined): JsonValue | undefined => value === undefined ? undefined : cloneJson(value);
  const assertActive = () => {
    if (!lifecycle.active) throw new CompositionError('LIFECYCLE_CLOSED', 'Module execution context is closed');
    throwIfAborted(signal);
  };
  return {
    signal,
    input: deepFreeze(cloneJson(input)),
    previous: deepFreeze(cloneJson(previous)),
    ...(event ? { event: deepFreeze({ type: event.type, payload: cloneJson(event.payload) }) } : {}),
    get(path: string): JsonValue | undefined { assertActive(); return cloneOptional(pointerGet(tx.state, path)); },
    getState(): JsonObject { assertActive(); return deepFreeze(cloneJson(tx.state)); },
    set(path: string, value: JsonValue): void { assertActive(); assertJson(value); recordSet(tx, path, value); },
    delete(path: string): void { assertActive(); recordDelete(tx, path); },
    capability<T = unknown>(name: string): T {
      assertActive();
      if (!capabilities.has(name)) throw new CompositionError('CAPABILITY_MISSING', `Capability is not available: ${name}`);
      return capabilities.get(name) as T;
    },
    emit(type: string, payload: JsonValue = null): void {
      assertActive();
      assertName(type, 'event.type', /^[a-z][a-z0-9_.:-]*$/);
      assertJson(payload);
      const event = { type, payload: cloneJson(payload) };
      tx.events.push(event);
      tx.pendingEvents.push(event);
    },
    effect(type: string, payload: JsonValue = null): void {
      assertActive();
      assertName(type, 'effect.type', /^[a-z][a-z0-9_.:-]*$/);
      assertJson(payload);
      tx.effects.push({ type, payload: cloneJson(payload) });
    },
    defer(cleanup: () => void | Promise<void>): void { assertActive(); scope.defer(cleanup); }
  };
}

function getNextNode(node: CompositionNode, tx: Transaction, input: JsonValue, event: RuntimeEvent | undefined, signal: AbortSignal, conditions: ReadonlyMap<string, (context: ConditionContext, data?: JsonValue) => boolean>): string | undefined {
  throwIfAborted(signal);
  const context = createConditionContext(tx, input, event, signal);
  const edges = [...(node.edges ?? [])].sort((left, right) => (left.priority ?? 0) - (right.priority ?? 0) || left.to.localeCompare(right.to));
  return edges.find(edge => edge.when === undefined || evaluateCondition(edge.when, context, conditions))?.to;
}

function createBranchTransaction(parent: Transaction): Transaction {
  const branch = createTransaction(parent.state);
  for (const [id, result] of parent.results) branch.results.set(id, cloneJson(result));
  branch.lastResult = cloneJson(parent.lastResult);
  return branch;
}

function mergeBranches(parent: Transaction, branches: readonly Transaction[]): void {
  const conflicts = new Set<string>();
  for (let left = 0; left < branches.length; left++) {
    for (let right = left + 1; right < branches.length; right++) {
      for (const first of branches[left]!.writes) for (const second of branches[right]!.writes) {
        if (pointerRelation(first.footprint, second.footprint)) {
          if (!writesEquivalent(first, second)) {
            conflicts.add(first.footprint);
            conflicts.add(second.footprint);
          }
        }
      }
    }
  }
  if (conflicts.size) throw new TransactionConflictError([...conflicts].sort());
  const merged: Write[] = [];
  for (const branch of branches) {
    for (const write of branch.writes) {
      if (merged.some(existing => writesEquivalent(existing, write))) continue;
      merged.push(write);
      if (write.kind === 'set') recordSet(parent, write.path, write.value!);
      else recordDelete(parent, write.path);
    }
    parent.events.push(...branch.events);
    parent.pendingEvents.push(...branch.pendingEvents);
    parent.effects.push(...branch.effects);
    for (const [id, result] of branch.results) parent.results.set(id, cloneJson(result));
    parent.lastResult = cloneJson(branch.lastResult);
  }
}

async function settleBranches<T>(promises: readonly Promise<T>[]): Promise<T[]> {
  const results = await Promise.allSettled(promises);
  const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (failures.length === 1) throw failures[0]!.reason;
  if (failures.length > 1) throw new AggregateError(failures.map(failure => failure.reason), 'Composition branches failed');
  return results.map(result => (result as PromiseFulfilledResult<T>).value);
}

class Runtime implements CompositionRuntime {
  private currentState: JsonObject;
  private currentRevision = 0;
  private disposed = false;
  private readonly runtimeController: AbortController;
  private readonly active = new Set<AbortController>();
  private readonly scope: ModuleScope;
  private readonly capabilities: CapabilityMap;
  private readonly graph: CompositionGraph;
  private readonly registry: ReturnType<typeof createModuleRegistry>;
  private readonly maxExecutions: number;
  private executionTail: Promise<void> = Promise.resolve();
  private disposal?: Promise<void>;

  private constructor(options: RuntimeOptions, registry: ReturnType<typeof createModuleRegistry>, scope: ModuleScope, capabilities: CapabilityMap, runtimeController: AbortController) {
    this.graph = deepFreeze(structuredClone(options.graph));
    this.registry = registry;
    this.scope = scope;
    this.capabilities = capabilities;
    this.runtimeController = runtimeController;
    this.maxExecutions = options.maxExecutions ?? 10000;
    if (!Number.isSafeInteger(this.maxExecutions) || this.maxExecutions < 1) throw new CompositionError('EXECUTION_LIMIT', 'maxExecutions must be a positive safe integer');
    assertJson(options.initialState);
    if (!isRecord(options.initialState)) throw new CompositionError('STATE_ROOT', 'initialState must be a JSON object');
    this.currentState = deepFreeze(cloneJson(options.initialState));
  }

  static async create(options: RuntimeOptions): Promise<Runtime> {
    validateCompositionGraph(options.graph);
    const registry = createModuleRegistry(options.modules);
    if (options.maxExecutions !== undefined && (!Number.isSafeInteger(options.maxExecutions) || options.maxExecutions < 1)) {
      throw new CompositionError('EXECUTION_LIMIT', 'maxExecutions must be a positive safe integer');
    }
    assertJson(options.initialState);
    if (!isRecord(options.initialState)) throw new CompositionError('STATE_ROOT', 'initialState must be a JSON object');
    validateGraphModules(options.graph, registry.byId);
    validateConditionHandlers(options.graph, registry.conditions);
    const controller = new AbortController();
    const scope = new ModuleScope();
    const capabilities: CapabilityMap = new Map();
    try {
      for (const module of registry.ordered) {
        throwIfAborted(controller.signal);
        if (!module.setup) continue;
        const result = await module.setup(createSetupContext(module, controller.signal, capabilities, scope));
        if (typeof result === 'function') scope.defer(result);
      }
      return new Runtime(options, registry, scope, capabilities, controller);
    } catch (error) {
      try { await scope.dispose(); } catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Composition setup failed and cleanup failed'); }
      throw error;
    }
  }

  get state(): JsonObject { return this.currentState; }
  get revision(): number { return this.currentRevision; }

  async run(input: JsonValue = null, options: ExecutionOptions = {}): Promise<ExecutionResult> {
    return this.execute({ kind: 'run', input }, options);
  }

  async dispatch(type: string, payload: JsonValue = null, options: ExecutionOptions = {}): Promise<ExecutionResult> {
    assertName(type, 'event.type', /^[a-z][a-z0-9_.:-]*$/);
    assertJson(payload);
    return this.execute({ kind: 'event', event: { type, payload: cloneJson(payload) } }, options);
  }

  cancel(reason?: unknown): void {
    for (const controller of this.active) if (!controller.signal.aborted) controller.abort(reason);
  }

  async dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.disposed = true;
    this.runtimeController.abort('Composition runtime disposed');
    this.cancel('Composition runtime disposed');
    this.disposal = (async () => {
      await this.executionTail;
      await this.scope.dispose();
    })();
    return this.disposal;
  }

  private execute(source: { kind: 'run'; input: JsonValue } | { kind: 'event'; event: RuntimeEvent }, options: ExecutionOptions): Promise<ExecutionResult> {
    if (this.disposed) throw new CompositionError('RUNTIME_DISPOSED', 'Composition runtime is disposed');
    assertJson(source.kind === 'run' ? source.input : source.event.payload);
    const queuedSource = source.kind === 'run'
      ? { kind: 'run' as const, input: deepFreeze(cloneJson(source.input)) }
      : { kind: 'event' as const, event: deepFreeze({ type: source.event.type, payload: cloneJson(source.event.payload) }) };
    const controller = new AbortController();
    this.active.add(controller);
    const execute = () => this.executeNow(queuedSource, options, controller);
    const next = this.executionTail.then(execute, execute);
    this.executionTail = next.then(() => undefined, () => undefined);
    return next;
  }

  private async executeNow(source: { kind: 'run'; input: JsonValue } | { kind: 'event'; event: RuntimeEvent }, options: ExecutionOptions, controller: AbortController): Promise<ExecutionResult> {
    const unlink: (() => void)[] = [];
    const abortFrom = (signal: AbortSignal | undefined): void => {
      if (!signal) return;
      const abort = () => controller.abort(signal.reason);
      if (signal.aborted) abort(); else { signal.addEventListener('abort', abort, { once: true }); unlink.push(() => signal.removeEventListener('abort', abort)); }
    };
    abortFrom(this.runtimeController.signal);
    abortFrom(options.signal);
    const tx = createTransaction(this.currentState);
    const eventsQueue: RuntimeEvent[] = [];
    try {
      throwIfAborted(controller.signal);
      let output: JsonValue = null;
      let executionCount = 0;
      if (source.kind === 'run') {
        const result = await this.runSubgraph(this.graph, this.graph.start, tx, source.input, undefined, controller.signal, () => ++executionCount);
        output = result.output;
        eventsQueue.push(...tx.pendingEvents.splice(0));
      } else {
        eventsQueue.push(source.event);
      }
      const eventOutputs: JsonValue[] = [];
      while (eventsQueue.length) {
        throwIfAborted(controller.signal);
        const event = eventsQueue.shift()!;
        const triggers = [...(this.graph.triggers ?? [])].filter(trigger => trigger.event === event.type).sort((left, right) => left.id.localeCompare(right.id));
        const matching = triggers.filter(trigger => trigger.when === undefined || evaluateCondition(trigger.when, createConditionContext(tx, event.payload, event, controller.signal), this.registry.conditions));
        const branches = await settleBranches(matching.map(async trigger => {
          const branchTx = createBranchTransaction(tx);
          const result = await this.runSubgraph(this.graph, trigger.start, branchTx, event.payload, event, controller.signal, () => ++executionCount);
          return { id: trigger.id, tx: branchTx, output: result.output };
        }));
        mergeBranches(tx, branches.map(branch => branch.tx));
        eventOutputs.push(...branches.map(branch => cloneJson(branch.output)));
        eventsQueue.push(...tx.pendingEvents.splice(0));
        if (executionCount > this.maxExecutions) throw new CompositionError('EXECUTION_LIMIT', `Execution exceeded ${this.maxExecutions} node invocations`);
      }
      throwIfAborted(controller.signal);
      this.currentState = deepFreeze(cloneJson(tx.state));
      this.currentRevision++;
      const result: ExecutionResult = {
        revision: this.currentRevision,
        state: cloneJson(this.currentState),
        output: deepFreeze(cloneJson(source.kind === 'event' ? (eventOutputs.length === 1 ? eventOutputs[0]! : eventOutputs) : output)),
        events: deepFreeze(cloneJson(tx.events as unknown as JsonValue) as unknown as RuntimeEvent[]),
        effects: deepFreeze(cloneJson(tx.effects as unknown as JsonValue) as unknown as EffectRecord[])
      };
      return result;
    } finally {
      for (const unlinkSignal of unlink) unlinkSignal();
      this.active.delete(controller);
    }
  }

  private async runSubgraph(
    graph: Subgraph,
    start: string,
    tx: Transaction,
    input: JsonValue,
    event: RuntimeEvent | undefined,
    signal: AbortSignal,
    count: () => number
  ): Promise<GraphRunResult> {
    const nodes = new Map(graph.nodes.map(node => [node.id, node]));
    let nodeId: string | undefined = start;
    let output: JsonValue = null;
    while (nodeId !== undefined) {
      throwIfAborted(signal);
      if (count() > this.maxExecutions) throw new CompositionError('EXECUTION_LIMIT', `Execution exceeded ${this.maxExecutions} node invocations`);
      const node = nodes.get(nodeId);
      if (!node) throw new CompositionError('GRAPH_NODE', `Node is missing at runtime: ${nodeId}`);
      const result = await this.executeNode(node, tx, input, event, signal, count);
      output = result;
      tx.results.set(node.id, cloneJson(result));
      tx.lastResult = cloneJson(result);
      nodeId = getNextNode(node, tx, input, event, signal, this.registry.conditions);
    }
    return { output, executions: 0 };
  }

  private async executeNode(node: CompositionNode, tx: Transaction, input: JsonValue, event: RuntimeEvent | undefined, signal: AbortSignal, count: () => number): Promise<JsonValue> {
    throwIfAborted(signal);
    if (node.type === 'module') {
      const module = this.registry.byId.get(node.module);
      if (!module) throw new CompositionError('MODULE_UNKNOWN', `Graph references unavailable module: ${node.module}`);
      const moduleInput = node.input === undefined ? cloneJson(input) : resolveDataRef(node.input, tx, input, event);
      if (moduleInput === undefined) throw new CompositionError('DATA_REF_MISSING', `Input reference did not resolve for node ${node.id}`);
      const callScope = new ModuleScope();
      const lifecycle = { active: true };
      const context = createModuleContext(tx, moduleInput, event, tx.lastResult, signal, this.capabilities, callScope, lifecycle);
      let output: JsonValue = null;
      const failures: unknown[] = [];
      try {
        const result = await module.execute(context, moduleInput);
        throwIfAborted(signal);
        output = result === undefined ? null : cloneJson(result);
      } catch (error) {
        failures.push(error);
      } finally {
        lifecycle.active = false;
        try { await callScope.dispose(); }
        catch (cleanupError) { failures.push(cleanupError); }
      }
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) throw new AggregateError(failures, `Node ${node.id} failed or cleanup reported errors`);
      if (node.output !== undefined) recordSet(tx, node.output, output);
      return output;
    }
    return this.executeParallel(node, tx, input, event, signal, count);
  }

  private async executeParallel(node: ParallelNode, tx: Transaction, input: JsonValue, event: RuntimeEvent | undefined, signal: AbortSignal, count: () => number): Promise<JsonValue> {
    const branches = await settleBranches(node.branches.map(async branch => {
      const branchTx = createBranchTransaction(tx);
      const result = await this.runSubgraph(branch, branch.start, branchTx, input, event, signal, count);
      return { tx: branchTx, result: result.output };
    }));
    mergeBranches(tx, branches.map(branch => branch.tx));
    const output = branches.map(branch => cloneJson(branch.result));
    const value = cloneJson(output as unknown as JsonValue);
    if (node.output !== undefined) recordSet(tx, node.output, value);
    return value;
  }
}

export async function createCompositionRuntime(options: RuntimeOptions): Promise<CompositionRuntime> {
  if (!isRecord(options)) throw new CompositionError('RUNTIME_OPTIONS', 'Runtime options must be an object');
  if (!isRecord(options.graph)) throw new CompositionError('RUNTIME_GRAPH', 'Runtime graph is required');
  if (!Array.isArray(options.modules)) throw new CompositionError('RUNTIME_MODULES', 'Runtime modules are required');
  if (!isRecord(options.initialState)) throw new CompositionError('RUNTIME_STATE', 'Runtime initialState must be a JSON object');
  return Runtime.create(options);
}

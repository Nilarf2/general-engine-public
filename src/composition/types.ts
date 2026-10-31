export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };
export type Awaitable<T> = T | Promise<T>;
export type Disposer = () => void | Promise<void>;

export interface ModuleManifest {
  readonly id: string;
  readonly version: string;
  readonly apiVersion: 1;
  readonly requires?: Readonly<Record<string, string>>;
  readonly provides?: readonly string[];
}

export type DataRef =
  | { readonly from: 'literal'; readonly value: JsonValue }
  | { readonly from: 'state'; readonly path: string }
  | { readonly from: 'input'; readonly path?: string }
  | { readonly from: 'result'; readonly path?: string }
  | { readonly from: 'node'; readonly node: string; readonly path?: string }
  | { readonly from: 'event'; readonly path?: string };

export type Condition =
  | { readonly op: 'and' | 'or'; readonly conditions: readonly Condition[] }
  | { readonly op: 'not'; readonly condition: Condition }
  | { readonly op: 'exists'; readonly value: DataRef }
  | { readonly op: 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte'; readonly left: DataRef; readonly right: DataRef }
  | { readonly op: `${string}:${string}`; readonly data?: JsonValue };

export interface GraphEdge {
  readonly to: string;
  /** Lower values are considered first. Node ID breaks equal-priority ties. */
  readonly priority?: number;
  readonly when?: Condition;
}

export interface ModuleNode {
  readonly id: string;
  readonly type: 'module';
  readonly module: string;
  readonly input?: DataRef;
  /** Store the module result at this JSON Pointer after a successful call. */
  readonly output?: string;
  readonly edges?: readonly GraphEdge[];
}

export interface ParallelNode {
  readonly id: string;
  readonly type: 'parallel';
  readonly branches: readonly Subgraph[];
  /** Store branch results in declaration order at this JSON Pointer. */
  readonly output?: string;
  readonly edges?: readonly GraphEdge[];
}

export type CompositionNode = ModuleNode | ParallelNode;

export interface Subgraph {
  readonly id: string;
  readonly version: 1;
  readonly start: string;
  readonly nodes: readonly CompositionNode[];
}

export interface EventTrigger {
  readonly id: string;
  readonly event: string;
  readonly start: string;
  readonly when?: Condition;
}

export interface CompositionGraph extends Subgraph {
  readonly triggers?: readonly EventTrigger[];
}

export interface RuntimeEvent {
  readonly type: string;
  readonly payload: JsonValue;
}

export interface EffectRecord {
  readonly type: string;
  readonly payload: JsonValue;
}

export interface ModuleSetupContext {
  readonly signal: AbortSignal;
  provide(name: string, value: unknown): void;
  defer(cleanup: Disposer): void;
}

export interface ModuleExecutionContext {
  readonly signal: AbortSignal;
  readonly input: JsonValue;
  readonly previous: JsonValue;
  readonly event?: RuntimeEvent;
  get(path: string): JsonValue | undefined;
  getState(): JsonObject;
  set(path: string, value: JsonValue): void;
  delete(path: string): void;
  capability<T = unknown>(name: string): T;
  emit(type: string, payload?: JsonValue): void;
  effect(type: string, payload?: JsonValue): void;
  defer(cleanup: Disposer): void;
}

export interface ConditionContext {
  readonly signal: AbortSignal;
  readonly input: JsonValue;
  readonly previous: JsonValue;
  readonly event?: RuntimeEvent;
  get(path: string): JsonValue | undefined;
  nodeResult(nodeId: string): JsonValue | undefined;
}

export type ConditionHandler = (context: ConditionContext, data?: JsonValue) => boolean;

export interface CompositionModule {
  readonly manifest: ModuleManifest;
  setup?(context: ModuleSetupContext): Awaitable<void | Disposer>;
  execute(context: ModuleExecutionContext, input: JsonValue): Awaitable<JsonValue | void>;
  readonly conditions?: Readonly<Record<string, ConditionHandler>>;
}

export interface RuntimeOptions {
  readonly graph: CompositionGraph;
  readonly modules: readonly CompositionModule[];
  readonly initialState: JsonObject;
  readonly maxExecutions?: number;
}

export interface ExecutionOptions {
  readonly signal?: AbortSignal;
}

export interface ExecutionResult {
  readonly revision: number;
  readonly state: JsonObject;
  readonly output: JsonValue;
  readonly events: readonly RuntimeEvent[];
  readonly effects: readonly EffectRecord[];
}

export interface CompositionRuntime {
  readonly state: JsonObject;
  readonly revision: number;
  run(input?: JsonValue, options?: ExecutionOptions): Promise<ExecutionResult>;
  dispatch(type: string, payload?: JsonValue, options?: ExecutionOptions): Promise<ExecutionResult>;
  cancel(reason?: unknown): void;
  dispose(): Promise<void>;
}

export class CompositionError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'CompositionError';
  }
}

export class TransactionConflictError extends CompositionError {
  constructor(readonly paths: readonly string[]) {
    super('TRANSACTION_CONFLICT', `Parallel branches wrote conflicting JSON Pointers: ${paths.join(', ')}`);
    this.name = 'TransactionConflictError';
  }
}

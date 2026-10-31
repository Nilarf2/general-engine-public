import { assertName, deepFreeze, isRecord } from './json.js';
import {
  CompositionError,
  type CompositionModule,
  type ConditionHandler,
  type JsonValue,
  type ModuleManifest,
  type ModuleSetupContext
} from './types.js';

export interface ModuleRegistry {
  readonly ordered: readonly CompositionModule[];
  readonly byId: ReadonlyMap<string, CompositionModule>;
  readonly conditions: ReadonlyMap<string, ConditionHandler>;
  readonly dependencies: ReadonlyMap<string, ReadonlySet<string>>;
  readonly capabilityProviders: ReadonlyMap<string, string>;
}

function validateManifest(module: CompositionModule): ModuleManifest {
  const source = module?.manifest;
  if (!isRecord(source)) throw new CompositionError('MODULE_MANIFEST', 'Every module needs a manifest object');
  assertName(source.id, 'module.manifest.id');
  if (typeof source.version !== 'string' || !source.version.trim()) throw new CompositionError('MODULE_VERSION', `Module ${source.id} needs a nonempty version`);
  if (source.apiVersion !== 1) throw new CompositionError('MODULE_API_VERSION', `Module ${source.id} uses an unsupported API version`);
  if (source.requires !== undefined && !isRecord(source.requires)) throw new CompositionError('MODULE_REQUIRES', `Module ${source.id} requires must be a version map`);
  const requires: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [id, version] of Object.entries(source.requires ?? {})) {
    assertName(id, `module ${source.id} dependency`);
    if (typeof version !== 'string' || !version.trim()) throw new CompositionError('MODULE_REQUIRES', `Invalid version requirement for ${source.id} -> ${id}`);
    requires[id] = version;
  }
  if (source.provides !== undefined && !Array.isArray(source.provides)) throw new CompositionError('MODULE_PROVIDES', `Module ${source.id} provides must be a list`);
  const provides: string[] = [];
  for (const capability of source.provides ?? []) {
    assertName(capability, `module ${source.id} capability`, /^[a-z][a-z0-9-]*:[A-Za-z0-9_.-]+$/);
    if (!capability.startsWith(`${source.id}:`)) throw new CompositionError('MODULE_CAPABILITY_OWNER', `Module ${source.id} can only provide names in its namespace: ${capability}`);
    if (provides.includes(capability)) throw new CompositionError('MODULE_PROVIDES', `Duplicate capability: ${capability}`);
    provides.push(capability);
  }
  return deepFreeze({ id: source.id, version: source.version, apiVersion: 1, requires, provides });
}

export function createModuleRegistry(modules: readonly CompositionModule[]): ModuleRegistry {
  if (!Array.isArray(modules)) throw new CompositionError('MODULES', 'modules must be an array');
  const raw = new Map<string, CompositionModule>();
  const manifests = new Map<string, ModuleManifest>();
  for (const candidate of modules) {
    if (!candidate || typeof candidate.execute !== 'function') throw new CompositionError('MODULE_EXECUTE', 'Every module must provide execute()');
    const manifest = validateManifest(candidate);
    if (raw.has(manifest.id)) throw new CompositionError('MODULE_DUPLICATE', `Duplicate module: ${manifest.id}`);
    raw.set(manifest.id, candidate);
    manifests.set(manifest.id, manifest);
  }

  const orderedIds: string[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new CompositionError('MODULE_CYCLE', `Circular module dependency involving ${id}`);
    if (visited.has(id)) return;
    visiting.add(id);
    const manifest = manifests.get(id)!;
    for (const [dependencyId, requiredVersion] of Object.entries(manifest.requires ?? {})) {
      const dependency = manifests.get(dependencyId);
      if (!dependency) throw new CompositionError('MODULE_DEPENDENCY', `${id} requires missing module ${dependencyId}`);
      if (requiredVersion !== '*' && dependency.version !== requiredVersion) {
        throw new CompositionError('MODULE_VERSION_MISMATCH', `${id} requires ${dependencyId}@${requiredVersion}, found ${dependency.version}`);
      }
      visit(dependencyId);
    }
    visiting.delete(id);
    visited.add(id);
    orderedIds.push(id);
  };
  for (const id of [...raw.keys()].sort()) visit(id);

  const dependencies = new Map<string, ReadonlySet<string>>();
  for (const id of orderedIds) {
    const transitive = new Set<string>();
    const collect = (dependencyId: string): void => {
      if (transitive.has(dependencyId)) return;
      transitive.add(dependencyId);
      for (const [nested] of Object.entries(manifests.get(dependencyId)!.requires ?? {})) collect(nested);
    };
    for (const [dependencyId] of Object.entries(manifests.get(id)!.requires ?? {})) collect(dependencyId);
    dependencies.set(id, transitive);
  }

  const ordered: CompositionModule[] = orderedIds.map(id => {
    const source = raw.get(id)!;
    const conditions: Record<string, ConditionHandler> = Object.create(null) as Record<string, ConditionHandler>;
    if (source.conditions !== undefined && !isRecord(source.conditions)) throw new CompositionError('MODULE_CONDITIONS', `Module ${id} conditions must be a map`);
    for (const [name, handler] of Object.entries(source.conditions ?? {})) {
      assertName(name, `module ${id} condition`, /^[a-z][a-z0-9-]*:[A-Za-z0-9_.-]+$/);
      if (!name.startsWith(`${id}:`)) throw new CompositionError('MODULE_CONDITION_OWNER', `Module ${id} cannot register condition ${name}`);
      if (!manifests.get(id)!.provides?.includes(name)) throw new CompositionError('MODULE_CONDITION_UNDECLARED', `Condition ${name} must be declared in manifest.provides`);
      if (typeof handler !== 'function') throw new CompositionError('MODULE_CONDITION', `Condition ${name} must be a function`);
      conditions[name] = handler.bind(source);
    }
    return {
      manifest: manifests.get(id)!,
      ...(source.setup ? { setup: source.setup.bind(source) } : {}),
      execute: source.execute.bind(source),
      ...(Object.keys(conditions).length ? { conditions } : {})
    };
  });

  const conditionMap = new Map<string, ConditionHandler>();
  for (const module of ordered) for (const [name, handler] of Object.entries(module.conditions ?? {})) {
    if (conditionMap.has(name)) throw new CompositionError('MODULE_CONDITION_DUPLICATE', `Duplicate condition: ${name}`);
    conditionMap.set(name, handler);
  }
  const capabilityProviders = new Map<string, string>();
  for (const module of ordered) for (const capability of module.manifest.provides ?? []) {
    if (capabilityProviders.has(capability)) throw new CompositionError('CAPABILITY_DUPLICATE', `Capability already declared: ${capability}`);
    capabilityProviders.set(capability, module.manifest.id);
  }
  return {
    ordered,
    byId: new Map(ordered.map(module => [module.manifest.id, module])),
    conditions: conditionMap,
    dependencies,
    capabilityProviders
  };
}

export class ModuleScope {
  private cleanups: (() => void | Promise<void>)[] = [];
  private closed = false;

  defer(cleanup: () => void | Promise<void>): void {
    if (typeof cleanup !== 'function') throw new TypeError('Cleanup must be a function');
    if (this.closed) throw new CompositionError('MODULE_SCOPE_CLOSED', 'Module lifecycle is already closed');
    this.cleanups.push(cleanup);
  }

  async dispose(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const errors: unknown[] = [];
    for (const cleanup of this.cleanups.reverse()) {
      try { await cleanup(); } catch (error) { errors.push(error); }
    }
    this.cleanups = [];
    if (errors.length) throw new AggregateError(errors, 'Module cleanup failed');
  }
}

export type CapabilityMap = Map<string, unknown>;

export function createSetupContext(
  module: CompositionModule,
  signal: AbortSignal,
  capabilities: CapabilityMap,
  scope: ModuleScope
): ModuleSetupContext {
  const declared = new Set(module.manifest.provides ?? []);
  return Object.freeze({
    signal,
    provide(name: string, value: unknown): void {
      if (!declared.has(name)) throw new CompositionError('CAPABILITY_UNDECLARED', `${module.manifest.id} did not declare ${name}`);
      validateCapabilityValue(value);
      if (capabilities.has(name)) throw new CompositionError('CAPABILITY_DUPLICATE', `Capability already provided: ${name}`);
      capabilities.set(name, value);
    },
    defer(cleanup: () => void | Promise<void>): void { scope.defer(cleanup); }
  });
}

export function validateCapabilityValue(value: unknown): void {
  if (value === undefined) throw new CompositionError('CAPABILITY_VALUE', 'Capabilities cannot be undefined');
}

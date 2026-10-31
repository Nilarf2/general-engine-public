import { World } from '../core/World.js';
import type { Plugin } from '../core/World.js';
import type { Command } from '../core/types.js';
import { assertJson, cloneJson, isRecord } from './json.js';
import type { CompositionModule, JsonObject, JsonValue } from './types.js';

export type WorldCompositionOperation =
  | { readonly type: 'step'; readonly count?: number }
  | { readonly type: 'advance'; readonly seconds: number }
  | { readonly type: 'snapshot' }
  | { readonly type: 'command'; readonly command: JsonObject };

export interface WorldCompositionModuleOptions {
  readonly id?: string;
  readonly version?: string;
  readonly world: World;
  readonly plugins?: readonly Plugin[];
  readonly ownsWorld?: boolean;
  readonly capabilities?: Readonly<Record<string, unknown>>;
  readonly exposeWorld?: boolean;
}

function parseOperation(value: JsonValue): WorldCompositionOperation {
  if (!isRecord(value) || typeof value.type !== 'string') throw new TypeError('World operation must be an object with a type');
  switch (value.type) {
    case 'step':
      if (value.count !== undefined && typeof value.count !== 'number') throw new TypeError('step.count must be a number');
      return { type: 'step', ...(value.count === undefined ? {} : { count: value.count }) };
    case 'advance':
      if (typeof value.seconds !== 'number') throw new TypeError('advance.seconds must be a number');
      return { type: 'advance', seconds: value.seconds };
    case 'snapshot':
      return { type: 'snapshot' };
    case 'command':
      if (!isRecord(value.command) || typeof value.command.type !== 'string') throw new TypeError('command.command must be a JSON object with a string type');
      assertJson(value.command, 'operation.command');
      return { type: 'command', command: cloneJson(value.command as JsonObject) };
    default:
      throw new TypeError(`Unsupported World operation: ${value.type}`);
  }
}

function snapshot(world: World): JsonValue {
  const value = world.snapshot();
  assertJson(value, 'world.snapshot');
  return cloneJson(value as unknown as JsonValue);
}

/** Adapt the fixed-step World and its synchronous plugins into the composition module model. */
export function createWorldCompositionModule(options: WorldCompositionModuleOptions): CompositionModule {
  const id = options.id ?? 'world';
  const version = options.version ?? '1.0.0';
  const plugins = [...(options.plugins ?? [])];
  const capabilities = options.capabilities ?? {};
  const provided: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [name, value] of Object.entries(capabilities)) provided[name] = value;
  if (options.exposeWorld) provided[`${id}:instance`] = options.world;

  for (const name of Object.keys(provided)) {
    if (!name.startsWith(`${id}:`)) throw new TypeError(`World capability must use the ${id}: namespace: ${name}`);
  }
  if (!options.world || typeof options.world.step !== 'function' || typeof options.world.install !== 'function') {
    throw new TypeError('A World instance is required');
  }

  return {
    manifest: { id, version, apiVersion: 1, provides: Object.keys(provided).sort() },
    setup(context) {
      const installed: string[] = [];
      context.defer(async () => {
        if (options.ownsWorld) {
          options.world.dispose();
          return;
        }
        const failures: unknown[] = [];
        for (const pluginId of [...installed].reverse()) {
          try { options.world.uninstall(pluginId); } catch (error) { failures.push(error); }
        }
        if (failures.length) throw new AggregateError(failures, 'World plugin cleanup failed');
      });
      for (const [name, value] of Object.entries(provided)) context.provide(name, value);
      for (const plugin of plugins) {
        options.world.install(plugin);
        installed.push(plugin.id);
      }
    },
    execute(_context, input): JsonValue {
      const operation = parseOperation(input);
      switch (operation.type) {
        case 'step': {
          const count = operation.count ?? 1;
          options.world.step(count);
          return { type: 'step', steps: count, snapshot: snapshot(options.world) };
        }
        case 'advance': {
          const result = options.world.advance(operation.seconds);
          return { type: 'advance', ...result, snapshot: snapshot(options.world) };
        }
        case 'snapshot':
          return { type: 'snapshot', snapshot: snapshot(options.world) };
        case 'command': {
          const result = options.world.command(operation.command as unknown as Command);
          assertJson(result, 'world.command result');
          return { type: 'command', result: cloneJson(result), snapshot: snapshot(options.world) };
        }
      }
    }
  };
}

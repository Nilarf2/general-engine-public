#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { compileStory, createNarrativeSession } from '../../src/narrative/index.js';
import type { PlayerCommand, Scalar, SessionView, Story } from '../../src/narrative/index.js';

export interface NarrativeRouteStep {
  node: string;
  command: Extract<PlayerCommand, { type: 'continue' | 'choose' }>;
}

export interface NarrativeRouteCase {
  seed?: number;
  storyId?: string;
  contentVersion?: string;
  steps: NarrativeRouteStep[];
  ending: string;
  variables?: Record<string, Scalar>;
  tags?: string[];
}

export interface NarrativeRouteResult {
  storyId: string;
  contentVersion: string;
  seed: number;
  ending: string;
  trace: SessionView[];
  snapshot: ReturnType<ReturnType<typeof createNarrativeSession>['snapshot']>;
}

export interface NarrativeRouteIO {
  readText(path: string): Promise<string>;
  writeText(path: string, text: string): Promise<void>;
  mkdir(path: string): Promise<void>;
  log(message: string): void;
  error(message: string): void;
}

interface RouteCliValues { story?: string; route?: string; out?: string; help?: boolean }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseRoute(value: unknown): NarrativeRouteCase {
  if (!isRecord(value)) throw new Error('Route must be a JSON object');
  if (!Array.isArray(value.steps)) throw new Error('Route steps must be an array');
  if (typeof value.ending !== 'string' || value.ending.length === 0) throw new Error('Route ending must be a nonempty string');
  if (value.seed !== undefined && (!Number.isSafeInteger(value.seed) || (value.seed as number) < 0)) {
    throw new Error('Route seed must be a nonnegative safe integer');
  }
  for (const key of ['storyId', 'contentVersion'] as const) {
    if (value[key] !== undefined && (typeof value[key] !== 'string' || value[key].length === 0)) {
      throw new Error(`Route ${key} must be a nonempty string`);
    }
  }
  if (value.variables !== undefined) {
    if (!isRecord(value.variables) || Object.values(value.variables).some(item =>
      item !== null && typeof item === 'object' || (typeof item !== 'string' && typeof item !== 'number' && typeof item !== 'boolean'),
    )) throw new Error('Route variables must contain scalar expected values');
  }
  if (value.tags !== undefined && (!Array.isArray(value.tags) || value.tags.some(tag => typeof tag !== 'string'))) {
    throw new Error('Route tags must be an array of strings');
  }
  const steps = value.steps.map((step, index) => {
    if (!isRecord(step) || typeof step.node !== 'string' || !step.node || !isRecord(step.command)) {
      throw new Error(`Route step ${index + 1} must include a node and command`);
    }
    if (step.command.type === 'continue') return { node: step.node, command: { type: 'continue' as const } };
    if (step.command.type === 'choose' && typeof step.command.optionId === 'string' && step.command.optionId) {
      return { node: step.node, command: { type: 'choose' as const, optionId: step.command.optionId } };
    }
    throw new Error(`Route step ${index + 1} command must be continue or choose with an optionId`);
  });
  return {
    ...(value.seed === undefined ? {} : { seed: value.seed as number }),
    ...(value.storyId === undefined ? {} : { storyId: value.storyId as string }),
    ...(value.contentVersion === undefined ? {} : { contentVersion: value.contentVersion as string }),
    steps,
    ending: value.ending,
    ...(value.variables === undefined ? {} : { variables: value.variables as Record<string, Scalar> }),
    ...(value.tags === undefined ? {} : { tags: value.tags as string[] }),
  };
}

/** Run a deterministic player route against standard story nodes. */
export function checkNarrativeRoute(storyInput: unknown, routeInput: unknown): NarrativeRouteResult {
  const route = parseRoute(routeInput);
  const compiled = compileStory(storyInput as Story);
  const story = compiled.story;
  if (route.storyId !== undefined && route.storyId !== story.id) throw new Error(`Route storyId mismatch: expected ${route.storyId}, got ${story.id}`);
  if (route.contentVersion !== undefined && route.contentVersion !== story.version) {
    throw new Error(`Route contentVersion mismatch: expected ${route.contentVersion}, got ${story.version}`);
  }

  const seed = route.seed ?? 1;
  const session = createNarrativeSession(compiled, { seed });
  const trace = [session.start().view];
  for (const [index, step] of route.steps.entries()) {
    const view = session.getView();
    if (view.nodeId !== step.node) throw new Error(`Route step ${index + 1}: expected node ${step.node}, got ${view.nodeId}`);
    const command = step.command;
    if (command.type === 'choose' && !view.choices?.some(choice => choice.id === command.optionId && !choice.disabled)) {
      throw new Error(`Route step ${index + 1}: option ${command.optionId} is not selectable at ${view.nodeId}`);
    }
    trace.push(session.dispatch(step.command).view);
  }

  const snapshot = session.snapshot();
  if (session.getView().awaiting !== 'ended') throw new Error(`Route did not reach an ending (stopped at ${session.getView().nodeId})`);
  if (snapshot.state.ending !== route.ending) throw new Error(`Route ending mismatch: expected ${route.ending}, got ${snapshot.state.ending}`);
  for (const [name, expected] of Object.entries(route.variables ?? {})) {
    if (snapshot.state.variables[name] !== expected) throw new Error(`Route variable mismatch for ${name}: expected ${String(expected)}, got ${String(snapshot.state.variables[name])}`);
  }
  for (const tag of route.tags ?? []) {
    if (!snapshot.state.tags.includes(tag)) throw new Error(`Route is missing expected tag ${tag}`);
  }

  return {
    storyId: story.id,
    contentVersion: story.version,
    seed,
    ending: snapshot.state.ending!,
    trace,
    snapshot,
  };
}

export async function runNarrativeRoute(args: readonly string[], io: NarrativeRouteIO): Promise<number> {
  let values: RouteCliValues;
  try {
    values = parseArgs({
      args: [...args],
      options: { story: { type: 'string' }, route: { type: 'string' }, out: { type: 'string' }, help: { type: 'boolean' } },
      strict: true,
      allowPositionals: false,
    }).values as RouteCliValues;
  } catch (cause) {
    io.error(cause instanceof Error ? cause.message : String(cause));
    return 2;
  }
  if (values.help) {
    io.log('Usage: narrative:route --story story.json --route route.json --out build/route-result.json');
    return 0;
  }
  if (!values.story || !values.route || !values.out) {
    io.error('Required: --story, --route and --out.');
    return 2;
  }

  const storyPath = resolve(values.story);
  const routePath = resolve(values.route);
  const outputPath = resolve(values.out);
  if (outputPath === storyPath || outputPath === routePath) {
    io.error('Output path must not overwrite the story or route input.');
    return 2;
  }
  try {
    const result = checkNarrativeRoute(JSON.parse(await io.readText(storyPath)), JSON.parse(await io.readText(routePath)));
    const output = `${JSON.stringify(result, null, 2)}\n`;
    await io.mkdir(dirname(outputPath));
    await io.writeText(outputPath, output);
    io.log(`Route passed: ${result.ending} (${result.trace.length} states)`);
    return 0;
  } catch (cause) {
    io.error(cause instanceof Error ? cause.message : String(cause));
    return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = await runNarrativeRoute(process.argv.slice(2), {
    readText: path => readFile(path, 'utf8'),
    writeText: (path, text) => writeFile(path, text, 'utf8'),
    mkdir: async path => { await mkdir(path, { recursive: true }); },
    log: message => console.log(message),
    error: message => console.error(message),
  });
}

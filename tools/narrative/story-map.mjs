#!/usr/bin/env node
// Offline graph analysis informed by the authoring workflow in Nilarf2/text-adventure-engine.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function requireTarget(target, from, kind, errors) {
  if (typeof target !== 'string' || !target) {
    errors.push({ code: 'EDGE_TARGET', from, kind, message: 'Edge target must be a non-empty node ID' });
    return undefined;
  }
  return { from, to: target, kind };
}

function declaredEdges(node, errors, dynamicNodes) {
  const edges = [];
  const add = (target, kind) => {
    const edge = requireTarget(target, node.id, kind, errors);
    if (edge) edges.push(edge);
  };
  switch (node.type) {
    case 'dialogue': case 'narration': case 'action': case 'scene':
      add(node.next, 'next');
      break;
    case 'choice':
      if (!Array.isArray(node.options) || node.options.length === 0) errors.push({ code: 'CHOICE_OPTIONS', from: node.id, message: 'Choice needs at least one option' });
      else node.options.forEach((option, index) => {
        if (!isRecord(option)) errors.push({ code: 'CHOICE_OPTION', from: node.id, message: `Option ${index} must be an object` });
        else add(option.next, `choice:${typeof option.id === 'string' ? option.id : index}`);
      });
      if (node.fallback !== undefined) add(node.fallback, 'fallback');
      break;
    case 'branch':
      if (!Array.isArray(node.branches) || node.branches.length === 0) errors.push({ code: 'BRANCHES', from: node.id, message: 'Branch needs at least one branch' });
      else node.branches.forEach((branch, index) => {
        if (!isRecord(branch)) errors.push({ code: 'BRANCH', from: node.id, message: `Branch ${index} must be an object` });
        else add(branch.next, `branch:${index}`);
      });
      add(node.fallback, 'fallback');
      break;
    case 'module':
      if (!isRecord(node.outcomes) || Object.keys(node.outcomes).length === 0) errors.push({ code: 'MODULE_OUTCOMES', from: node.id, message: 'Module node needs declared outcomes' });
      else for (const [name, target] of Object.entries(node.outcomes)) add(target, `module:${name}`);
      break;
    case 'end':
      break;
    default:
      if (node.type.includes(':')) {
        dynamicNodes.push(node.id);
        if (node.next !== undefined) add(node.next, 'custom-declared');
      } else errors.push({ code: 'NODE_TYPE', from: node.id, message: `Unknown node type: ${node.type}` });
  }
  return edges;
}

function walk(start, adjacency) {
  const seen = new Set();
  const pending = [start];
  while (pending.length) {
    const current = pending.pop();
    if (seen.has(current)) continue;
    seen.add(current);
    for (const next of adjacency.get(current) ?? []) if (!seen.has(next)) pending.push(next);
  }
  return seen;
}

function findCycles(nodes, adjacency) {
  let index = 0;
  const indexes = new Map();
  const low = new Map();
  const stack = [];
  const onStack = new Set();
  const cycles = [];
  const visit = id => {
    indexes.set(id, index);
    low.set(id, index++);
    stack.push(id);
    onStack.add(id);
    for (const next of adjacency.get(id) ?? []) {
      if (!indexes.has(next)) {
        visit(next);
        low.set(id, Math.min(low.get(id), low.get(next)));
      } else if (onStack.has(next)) low.set(id, Math.min(low.get(id), indexes.get(next)));
    }
    if (low.get(id) !== indexes.get(id)) return;
    const component = [];
    let current;
    do {
      current = stack.pop();
      onStack.delete(current);
      component.push(current);
    } while (current !== id);
    if (component.length > 1 || (adjacency.get(id) ?? []).includes(id)) cycles.push(component.sort());
  };
  for (const node of nodes) if (!indexes.has(node.id)) visit(node.id);
  return cycles;
}

/** Analyze declared graph structure only; conditions and module code are never evaluated. */
export function analyzeStory(story) {
  const errors = [];
  if (!isRecord(story)) throw new TypeError('Story must be a JSON object');
  if (story.schemaVersion !== '1') errors.push({ code: 'SCHEMA_VERSION', message: 'schemaVersion must be "1"' });
  if (typeof story.id !== 'string' || !story.id) errors.push({ code: 'STORY_ID', message: 'Story needs a non-empty id' });
  if (typeof story.version !== 'string' || !story.version) errors.push({ code: 'STORY_VERSION', message: 'Story needs a non-empty version' });
  if (!Array.isArray(story.nodes) || story.nodes.length === 0) throw new TypeError('Story needs a non-empty nodes array');
  if (typeof story.start !== 'string' || !story.start) errors.push({ code: 'START', message: 'Story needs a start node ID' });

  const ids = new Set();
  const validNodes = [];
  for (const node of story.nodes) {
    if (!isRecord(node) || typeof node.id !== 'string' || !node.id || typeof node.type !== 'string' || !node.type) {
      errors.push({ code: 'NODE', message: 'Each node needs a non-empty id and type' });
      continue;
    }
    if (ids.has(node.id)) {
      errors.push({ code: 'NODE_DUPLICATE', from: node.id, message: `Duplicate node ID: ${node.id}` });
      continue;
    }
    ids.add(node.id);
    validNodes.push(node);
  }
  if (!ids.has(story.start)) errors.push({ code: 'START_MISSING', from: story.start, message: `Start node does not exist: ${story.start}` });

  const dynamicNodes = [];
  const edges = validNodes.flatMap(node => declaredEdges(node, errors, dynamicNodes));
  for (const edge of edges) if (!ids.has(edge.to)) errors.push({ code: 'TARGET_MISSING', from: edge.from, to: edge.to, message: `Target node does not exist: ${edge.to}` });
  const nodeIds = new Set(validNodes.map(node => node.id));
  const validEdges = edges.filter(edge => nodeIds.has(edge.to));
  const adjacency = new Map(validNodes.map(node => [node.id, []]));
  const reverse = new Map(validNodes.map(node => [node.id, []]));
  for (const edge of validEdges) {
    adjacency.get(edge.from).push(edge.to);
    reverse.get(edge.to).push(edge.from);
  }
  const reachable = ids.has(story.start) ? walk(story.start, adjacency) : new Set();
  const endings = validNodes.filter(node => node.type === 'end').map(node => node.id);
  const canEnd = new Set();
  for (const ending of endings) for (const id of walk(ending, reverse)) canEnd.add(id);
  const reachableNodeIds = validNodes.filter(node => reachable.has(node.id)).map(node => node.id);
  const unreachableNodeIds = validNodes.filter(node => !reachable.has(node.id)).map(node => node.id);
  const cannotReachEndingNodeIds = validNodes.filter(node => !canEnd.has(node.id) && !dynamicNodes.includes(node.id)).map(node => node.id);
  const deadEndNodeIds = validNodes.filter(node => node.type !== 'end' && (adjacency.get(node.id)?.length ?? 0) === 0 && !dynamicNodes.includes(node.id)).map(node => node.id);
  const cycles = findCycles(validNodes, adjacency);
  const analysis = {
    valid: errors.length === 0,
    errors,
    nodeCount: validNodes.length,
    edgeCount: validEdges.length,
    endingNodeIds: endings,
    reachableNodeIds,
    unreachableNodeIds,
    deadEndNodeIds,
    cannotReachEndingNodeIds,
    cycles,
    dynamicNodeIds: [...new Set(dynamicNodes)],
  };
  return {
    storyId: story.id,
    contentVersion: story.version,
    title: typeof story.title === 'string' ? story.title : undefined,
    start: story.start,
    nodes: validNodes.map(node => ({ id: node.id, type: node.type })),
    edges: validEdges.map((edge, index) => ({ id: `edge-${index}`, ...edge })),
    analysis,
  };
}

function mermaidLabel(value) {
  return String(value).replaceAll('"', "'").replace(/[\r\n\[\]|]/g, ' ');
}

export function renderMermaid(map) {
  const names = new Map(map.nodes.map((node, index) => [node.id, `n${index}`]));
  const lines = ['flowchart TD'];
  for (const node of map.nodes) lines.push(`  ${names.get(node.id)}["${mermaidLabel(node.id)} · ${mermaidLabel(node.type)}"]`);
  for (const edge of map.edges) lines.push(`  ${names.get(edge.from)} -->|${mermaidLabel(edge.kind)}| ${names.get(edge.to)}`);
  return `${lines.join('\n')}\n`;
}

export async function runStoryMap(argv = process.argv.slice(2)) {
  const { values, positionals } = parseArgs({ args: argv, options: { out: { type: 'string' }, format: { type: 'string', default: 'json' }, help: { type: 'boolean' } }, allowPositionals: true });
  if (values.help) {
    console.log('node tools/narrative/story-map.mjs <story.json> [--format json|mermaid] [--out build/story-map.json]');
    return 0;
  }
  if (!positionals[0]) throw new Error('A story JSON path is required');
  if (values.format !== 'json' && values.format !== 'mermaid') throw new Error('--format must be json or mermaid');
  const input = resolve(positionals[0]);
  const output = values.format === 'mermaid' ? renderMermaid(analyzeStory(JSON.parse(await readFile(input, 'utf8')))) : `${JSON.stringify(analyzeStory(JSON.parse(await readFile(input, 'utf8'))), null, 2)}\n`;
  if (values.out) {
    const out = resolve(values.out);
    if (out === input) throw new Error('Output cannot overwrite the source story');
    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, output, 'utf8');
    console.log(`Wrote ${values.format} story map: ${out}`);
  } else process.stdout.write(output);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runStoryMap().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}

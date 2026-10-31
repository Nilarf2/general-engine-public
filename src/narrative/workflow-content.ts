// Content validation/compiler flow adapted from Nilarf2/text-adventure-engine (MIT), © 2026 Nilarf2.
import {
  assertJson,
  cloneJson,
  createModuleRegistry,
  NARRATIVE_SCHEMA_VERSION,
  NarrativeEngineError,
  type Action,
  type AdventureModule,
  type CompiledStory,
  type Condition,
  type ExtensionValidator,
  type ModuleRegistry,
  type Story,
  type StoryNode,
  type ValueExpression,
} from './workflow-types.js';

export interface NarrativeDiagnostic {
  code: string;
  message: string;
  path: string;
  severity: 'error' | 'warning';
}
export interface NarrativeValidationResult { diagnostics: NarrativeDiagnostic[]; valid: boolean }

const NODE_ID = /^[a-zA-Z][a-zA-Z0-9_.:-]*$/;
const EXTENSION_ID = /^[a-z][a-z0-9-]*:[a-zA-Z0-9_.-]+$/;
const reserved = new Set(['constructor', 'prototype', '__proto__']);
type RecordValue = Record<string, unknown>;
const object = (value: unknown): RecordValue | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : undefined;
const has = (value: object, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);

function error(diagnostics: NarrativeDiagnostic[], code: string, message: string, path: string): void {
  diagnostics.push({ code, message, path, severity: 'error' });
}
function warning(diagnostics: NarrativeDiagnostic[], code: string, message: string, path: string): void {
  diagnostics.push({ code, message, path, severity: 'warning' });
}
function requireId(value: unknown, path: string, diagnostics: NarrativeDiagnostic[]): void {
  if (typeof value !== 'string' || !value) error(diagnostics, 'NODE_REF', 'Expected node ID', path);
}

function validateExpression(value: unknown, path: string, diagnostics: NarrativeDiagnostic[]): void {
  if (typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return;
  const expr = object(value);
  if (expr && Object.keys(expr).length === 1 && typeof expr.var === 'string' && expr.var) return;
  const range = expr && object(expr.random);
  if (range && expr && Object.keys(expr).length === 1 && Object.keys(range).length === 2 &&
      Number.isInteger(range.min) && Number.isInteger(range.max) && (range.max as number) >= (range.min as number)) return;
  error(diagnostics, 'EXPRESSION', 'Expected a scalar, variable reference, or integer random range', path);
}

function validateCondition(value: unknown, path: string, diagnostics: NarrativeDiagnostic[], registry: ModuleRegistry): void {
  const condition = object(value);
  if (!condition || typeof condition.op !== 'string') {
    error(diagnostics, 'CONDITION', 'Expected condition object with op', path);
    return;
  }
  switch (condition.op) {
    case 'eq': case 'ne': case 'gt': case 'gte': case 'lt': case 'lte':
      validateExpression(condition.left, `${path}/left`, diagnostics);
      validateExpression(condition.right, `${path}/right`, diagnostics);
      return;
    case 'and': case 'or':
      if (!Array.isArray(condition.conditions) || condition.conditions.length === 0) {
        error(diagnostics, 'CONDITION', 'conditions must be a non-empty array', `${path}/conditions`);
      } else condition.conditions.forEach((child, index) => validateCondition(child, `${path}/conditions/${index}`, diagnostics, registry));
      return;
    case 'not': validateCondition(condition.condition, `${path}/condition`, diagnostics, registry); return;
    case 'tag':
      if (typeof condition.tag !== 'string' || !condition.tag) error(diagnostics, 'CONDITION', 'tag must be a non-empty string', `${path}/tag`);
      return;
    case 'visited':
      if (typeof condition.node !== 'string' || (condition.count !== undefined && (!Number.isSafeInteger(condition.count) || (condition.count as number) < 0))) {
        error(diagnostics, 'CONDITION', 'visited requires a node and non-negative integer count', path);
      }
      return;
    default: {
      const extension = registry.conditions.get(condition.op);
      if (!extension) error(diagnostics, 'CONDITION_UNKNOWN', `Unregistered condition ${condition.op}`, `${path}/op`);
      else validateExtension(extension.validate, value, path, diagnostics);
    }
  }
}

function validateExtension(validate: ExtensionValidator | undefined, value: unknown, path: string, diagnostics: NarrativeDiagnostic[]): void {
  if (!validate) return;
  try {
    for (const message of validate(value)) error(diagnostics, 'EXTENSION_DATA', message, path);
  } catch (cause) {
    error(diagnostics, 'EXTENSION_VALIDATOR', cause instanceof Error ? cause.message : String(cause), path);
  }
}

function validateAction(value: unknown, path: string, diagnostics: NarrativeDiagnostic[], registry: ModuleRegistry): void {
  const action = object(value);
  if (!action || typeof action.type !== 'string') {
    error(diagnostics, 'ACTION', 'Expected action object with type', path);
    return;
  }
  switch (action.type) {
    case 'set': case 'add':
      if (typeof action.variable !== 'string' || !action.variable) error(diagnostics, 'ACTION', 'variable must be a non-empty string', `${path}/variable`);
      validateExpression(action.value, `${path}/value`, diagnostics);
      return;
    case 'tag.add': case 'tag.remove':
      if (typeof action.tag !== 'string' || !action.tag) error(diagnostics, 'ACTION', 'tag must be a non-empty string', `${path}/tag`);
      return;
    case 'emit':
      if (typeof action.name !== 'string' || !action.name) error(diagnostics, 'ACTION', 'event name must be a non-empty string', `${path}/name`);
      return;
    case 'audio.play': case 'audio.sfx':
      if (typeof action.asset !== 'string' || !action.asset) error(diagnostics, 'ACTION', 'asset must be a non-empty logical asset ID', `${path}/asset`);
      if (action.channel !== undefined && action.channel !== 'music' && action.channel !== 'ambience') error(diagnostics, 'AUDIO_CHANNEL', 'Unknown audio channel', `${path}/channel`);
      break;
    case 'audio.stop':
      if (action.channel !== undefined && action.channel !== 'music' && action.channel !== 'ambience') error(diagnostics, 'AUDIO_CHANNEL', 'Unknown audio channel', `${path}/channel`);
      if (action.fadeMs !== undefined && (typeof action.fadeMs !== 'number' || !Number.isFinite(action.fadeMs) || action.fadeMs < 0)) error(diagnostics, 'AUDIO_FADE', 'fadeMs must be non-negative', `${path}/fadeMs`);
      return;
    case 'checkpoint':
      if (action.name !== undefined && typeof action.name !== 'string') error(diagnostics, 'CHECKPOINT', 'name must be text', `${path}/name`);
      return;
    default: {
      if (EXTENSION_ID.test(action.type)) {
        const extension = registry.actions.get(action.type);
        if (!extension) error(diagnostics, 'ACTION_UNKNOWN', `Unregistered action ${action.type}`, `${path}/type`);
        else validateExtension(extension.validate, value, path, diagnostics);
        return;
      }
      error(diagnostics, 'ACTION_UNKNOWN', `Unknown action ${action.type}`, `${path}/type`);
      return;
    }
  }
  if (action.type === 'audio.play') {
    const options = action.options === undefined ? undefined : object(action.options);
    if (action.options !== undefined && !options) error(diagnostics, 'AUDIO_OPTIONS', 'options must be an object', `${path}/options`);
    if (options?.loop !== undefined && typeof options.loop !== 'boolean') error(diagnostics, 'AUDIO_LOOP', 'loop must be boolean', `${path}/options/loop`);
    for (const [name, value] of [['volume', action.volume], ['options/volume', options?.volume]] as const) {
      if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1)) error(diagnostics, 'AUDIO_VOLUME', 'volume must be between 0 and 1', `${path}/${name}`);
    }
    for (const [name, value] of [['fadeMs', action.fadeMs], ['options/fadeMs', options?.fadeMs]] as const) {
      if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value) || value < 0)) error(diagnostics, 'AUDIO_FADE', 'fadeMs must be non-negative', `${path}/${name}`);
    }
  } else if (action.volume !== undefined && (typeof action.volume !== 'number' || !Number.isFinite(action.volume) || action.volume < 0 || action.volume > 1)) {
    error(diagnostics, 'AUDIO_VOLUME', 'volume must be between 0 and 1', `${path}/volume`);
  }
}

function validateActions(value: unknown, path: string, diagnostics: NarrativeDiagnostic[], registry: ModuleRegistry): void {
  if (!Array.isArray(value)) {
    error(diagnostics, 'ACTIONS', 'Expected an action array', path);
    return;
  }
  value.forEach((action, index) => validateAction(action, `${path}/${index}`, diagnostics, registry));
}

function validateNode(value: unknown, index: number, diagnostics: NarrativeDiagnostic[], registry: ModuleRegistry): void {
  const path = `/nodes/${index}`;
  const node = object(value);
  if (!node || typeof node.id !== 'string' || typeof node.type !== 'string') {
    error(diagnostics, 'NODE', 'Each node needs id and type', path);
    return;
  }
  if (!NODE_ID.test(node.id) || reserved.has(node.id)) error(diagnostics, 'NODE_ID', `Invalid node ID ${node.id}`, `${path}/id`);
  if (node.onEnter !== undefined) validateActions(node.onEnter, `${path}/onEnter`, diagnostics, registry);
  for (const field of ['background', 'music', 'ambience', 'resultVariable', 'text']) {
    if (node[field] !== undefined && typeof node[field] !== 'string') error(diagnostics, 'NODE_FIELD', `${field} must be text`, `${path}/${field}`);
  }
  switch (node.type) {
    case 'dialogue': case 'narration':
      if (!Array.isArray(node.lines) || node.lines.length === 0) error(diagnostics, 'DIALOGUE_LINES', 'Dialogue needs at least one line', `${path}/lines`);
      else node.lines.forEach((value, lineIndex) => {
        const line = object(value);
        if (!line || typeof line.text !== 'string') error(diagnostics, 'DIALOGUE_LINE', 'Line needs text', `${path}/lines/${lineIndex}`);
        else for (const field of ['speaker', 'expression', 'voice']) if (line[field] !== undefined && typeof line[field] !== 'string') error(diagnostics, 'DIALOGUE_LINE', `${field} must be text`, `${path}/lines/${lineIndex}/${field}`);
      });
      requireId(node.next, `${path}/next`, diagnostics);
      return;
    case 'choice':
      if (node.prompt !== undefined && typeof node.prompt !== 'string') error(diagnostics, 'CHOICE_PROMPT', 'prompt must be text', `${path}/prompt`);
      if (!Array.isArray(node.options) || node.options.length === 0) error(diagnostics, 'CHOICE_OPTIONS', 'Choice needs at least one option', `${path}/options`);
      else {
        const seen = new Set<string>();
        node.options.forEach((value, optionIndex) => {
          const optionPath = `${path}/options/${optionIndex}`;
          const option = object(value);
          if (!option || typeof option.id !== 'string' || !option.id || typeof option.text !== 'string') {
            error(diagnostics, 'CHOICE_OPTION', 'Option needs id and text', optionPath);
            return;
          }
          if (seen.has(option.id)) error(diagnostics, 'OPTION_DUPLICATE', `Duplicate option ID ${option.id}`, `${optionPath}/id`);
          seen.add(option.id);
          requireId(option.next, `${optionPath}/next`, diagnostics);
          if (option.disabledReason !== undefined && typeof option.disabledReason !== 'string') error(diagnostics, 'CHOICE_REASON', 'disabledReason must be text', `${optionPath}/disabledReason`);
          if (option.when !== undefined) validateCondition(option.when, `${optionPath}/when`, diagnostics, registry);
          if (option.disabledWhen !== undefined) validateCondition(option.disabledWhen, `${optionPath}/disabledWhen`, diagnostics, registry);
          if (option.actions !== undefined) validateActions(option.actions, `${optionPath}/actions`, diagnostics, registry);
        });
      }
      if (node.fallback !== undefined) requireId(node.fallback, `${path}/fallback`, diagnostics);
      return;
    case 'branch':
      if (!Array.isArray(node.branches) || node.branches.length === 0) error(diagnostics, 'BRANCHES', 'Branch needs at least one branch', `${path}/branches`);
      else node.branches.forEach((value, branchIndex) => {
        const branchPath = `${path}/branches/${branchIndex}`;
        const branch = object(value);
        if (!branch) { error(diagnostics, 'BRANCH', 'Expected branch object', branchPath); return; }
        validateCondition(branch.when, `${branchPath}/when`, diagnostics, registry);
        requireId(branch.next, `${branchPath}/next`, diagnostics);
      });
      requireId(node.fallback, `${path}/fallback`, diagnostics);
      return;
    case 'action':
      validateActions(node.actions, `${path}/actions`, diagnostics, registry);
      requireId(node.next, `${path}/next`, diagnostics);
      return;
    case 'scene':
      if (typeof node.scene !== 'string' || !node.scene) error(diagnostics, 'SCENE', 'scene must be a non-empty ID', `${path}/scene`);
      requireId(node.next, `${path}/next`, diagnostics);
      return;
    case 'module':
      if (typeof node.module !== 'string' || !registry.modules.has(node.module)) error(diagnostics, 'MODULE_UNKNOWN', `Module is not registered: ${String(node.module)}`, `${path}/module`);
      if (node.input !== undefined) {
        try { assertJson(node.input, `${path}/input`); } catch (cause) { error(diagnostics, 'MODULE_INPUT', cause instanceof Error ? cause.message : String(cause), `${path}/input`); }
      }
      if (!object(node.outcomes) || Object.keys(node.outcomes as object).length === 0) error(diagnostics, 'MODULE_OUTCOMES', 'Module node needs outcome destinations', `${path}/outcomes`);
      else for (const [outcome, target] of Object.entries(node.outcomes as RecordValue)) requireId(target, `${path}/outcomes/${outcome}`, diagnostics);
      return;
    case 'end':
      if (typeof node.ending !== 'string' || !node.ending) error(diagnostics, 'ENDING', 'ending must be a non-empty ID', `${path}/ending`);
      return;
    default: {
      if (!EXTENSION_ID.test(node.type)) { error(diagnostics, 'NODE_TYPE', `Unknown node type ${node.type}`, `${path}/type`); return; }
      const extension = registry.nodes.get(node.type);
      if (!extension) error(diagnostics, 'NODE_TYPE', `Unregistered node type ${node.type}`, `${path}/type`);
      else validateExtension(extension.validate, value, path, diagnostics);
    }
  }
}

/** Validate a serializable story graph and all registered extension payloads. */
export function validateStory(input: unknown, modules: readonly AdventureModule[] | ModuleRegistry = []): NarrativeValidationResult {
  const diagnostics: NarrativeDiagnostic[] = [];
  let registry: ModuleRegistry;
  try { registry = Array.isArray(modules) ? createModuleRegistry(modules) : modules as ModuleRegistry; }
  catch (cause) {
    return { diagnostics: [{ code: 'MODULE_REGISTRY', message: cause instanceof Error ? cause.message : String(cause), path: '/modules', severity: 'error' }], valid: false };
  }
  const story = object(input);
  if (!story) return { diagnostics: [{ code: 'STORY', message: 'Expected a JSON object', path: '$', severity: 'error' }], valid: false };
  try { assertJson(input); }
  catch (cause) {
    error(diagnostics, cause instanceof NarrativeEngineError ? cause.code : 'JSON', cause instanceof Error ? cause.message : String(cause), cause instanceof NarrativeEngineError ? cause.path ?? '$' : '$');
    return { diagnostics, valid: false };
  }
  if (story.schemaVersion !== NARRATIVE_SCHEMA_VERSION) error(diagnostics, 'SCHEMA_VERSION', `schemaVersion must be "${NARRATIVE_SCHEMA_VERSION}"`, '/schemaVersion');
  for (const field of ['id', 'version', 'title', 'start']) if (typeof story[field] !== 'string' || !(story[field] as string).trim()) error(diagnostics, 'REQUIRED', `${field} must be a non-empty string`, `/${field}`);
  if (story.locale !== undefined && typeof story.locale !== 'string') error(diagnostics, 'LOCALE', 'locale must be text', '/locale');
  if (!Array.isArray(story.nodes) || story.nodes.length === 0) error(diagnostics, 'NODES', 'Story needs a non-empty nodes array', '/nodes');
  for (const field of ['variables', 'assets', 'characters']) if (story[field] !== undefined && !object(story[field])) error(diagnostics, 'COLLECTION', `${field} must be an object`, `/${field}`);

  const variables = object(story.variables) ?? {};
  for (const [name, definitionValue] of Object.entries(variables)) {
    const definition = object(definitionValue);
    if (reserved.has(name)) error(diagnostics, 'VARIABLE_ID', `Reserved variable name: ${name}`, `/variables/${name}`);
    if (!definition || !['string', 'number', 'boolean'].includes(String(definition.type))) error(diagnostics, 'VARIABLE', `Invalid variable definition: ${name}`, `/variables/${name}`);
    else if ((definition.type === 'string' && typeof definition.default !== 'string') ||
      (definition.type === 'number' && (typeof definition.default !== 'number' || !Number.isFinite(definition.default))) ||
      (definition.type === 'boolean' && typeof definition.default !== 'boolean')) {
      error(diagnostics, 'VARIABLE_DEFAULT', `Default does not match type for ${name}`, `/variables/${name}/default`);
    }
  }

  const nodes = Array.isArray(story.nodes) ? story.nodes : [];
  const ids = new Set<string>();
  nodes.forEach((value, index) => {
    const node = object(value);
    if (typeof node?.id === 'string') {
      if (ids.has(node.id)) error(diagnostics, 'NODE_DUPLICATE', `Duplicate node ID ${node.id}`, `/nodes/${index}/id`);
      ids.add(node.id);
    }
    validateNode(value, index, diagnostics, registry);
  });

  const refs: { id: string; path: string; owner: number }[] = [];
  nodes.forEach((value, index) => {
    const node = object(value);
    if (!node) return;
    const add = (target: unknown, path: string): void => { if (typeof target === 'string') refs.push({ id: target, path, owner: index }); };
    if (['dialogue', 'narration', 'action', 'scene'].includes(String(node.type)) || (typeof node.type === 'string' && node.type.includes(':'))) add(node.next, `/nodes/${index}/next`);
    if (node.type === 'choice' && Array.isArray(node.options)) node.options.forEach((option, j) => add(object(option)?.next, `/nodes/${index}/options/${j}/next`));
    if (node.type === 'choice') add(node.fallback, `/nodes/${index}/fallback`);
    if (node.type === 'branch' && Array.isArray(node.branches)) node.branches.forEach((branch, j) => add(object(branch)?.next, `/nodes/${index}/branches/${j}/next`));
    if (node.type === 'branch') add(node.fallback, `/nodes/${index}/fallback`);
    if (node.type === 'module') for (const [outcome, target] of Object.entries(object(node.outcomes) ?? {})) add(target, `/nodes/${index}/outcomes/${outcome}`);
  });
  for (const ref of refs) if (!ids.has(ref.id)) error(diagnostics, 'NODE_MISSING', `Node reference not found: ${ref.id}`, ref.path);
  if (typeof story.start === 'string' && !ids.has(story.start)) error(diagnostics, 'START_MISSING', `Start node not found: ${story.start}`, '/start');

  const assetDefinitions = object(story.assets) ?? {};
  for (const [assetId, definitionValue] of Object.entries(assetDefinitions)) {
    const definition = object(definitionValue);
    if (!definition || typeof definition.src !== 'string' || !definition.src || !['image', 'audio', 'other'].includes(String(definition.type))) error(diagnostics, 'ASSET', `Invalid asset ${assetId}`, `/assets/${assetId}`);
  }
  for (const [characterId, value] of Object.entries(object(story.characters) ?? {})) {
    const character = object(value);
    if (!character || typeof character.name !== 'string' || (character.portrait !== undefined && typeof character.portrait !== 'string') ||
      (character.expressions !== undefined && (!object(character.expressions) || Object.values(object(character.expressions)!).some(asset => typeof asset !== 'string')))) {
      error(diagnostics, 'CHARACTER', `Invalid character ${characterId}`, `/characters/${characterId}`);
    }
  }

  const checkReferences = (value: unknown, path: string): void => {
    if (Array.isArray(value)) { value.forEach((child, index) => checkReferences(child, `${path}/${index}`)); return; }
    const current = object(value);
    if (!current) return;
    if ((typeof current.type === 'string' && current.type.includes(':')) || (typeof current.op === 'string' && current.op.includes(':'))) return;
    const variable = typeof current.var === 'string' ? current.var : (current.type === 'set' || current.type === 'add') ? current.variable : current.type === 'module' ? current.resultVariable : undefined;
    if (typeof variable === 'string' && !has(variables, variable)) error(diagnostics, 'VARIABLE_MISSING', `Variable is not declared: ${variable}`, path);
    if (current.type === 'add' && typeof variable === 'string' && object(variables[variable])?.type !== 'number') error(diagnostics, 'VARIABLE_TYPE', 'add requires a number variable', path);
    if (current.type === 'set' && typeof variable === 'string' && ['string', 'number', 'boolean'].includes(typeof current.value) && object(variables[variable])?.type !== typeof current.value) error(diagnostics, 'VARIABLE_TYPE', 'set value does not match variable type', `${path}/value`);
    if (current.op === 'visited' && typeof current.node === 'string' && !ids.has(current.node)) error(diagnostics, 'NODE_MISSING', `Visited node not found: ${current.node}`, `${path}/node`);
    for (const [key, child] of Object.entries(current)) if (!['input', 'data', 'payload'].includes(key)) checkReferences(child, `${path}/${key}`);
  };
  nodes.forEach((node, index) => checkReferences(node, `/nodes/${index}`));

  const reachable = new Set<string>();
  const queue = typeof story.start === 'string' ? [story.start] : [];
  const byId = new Map(nodes.map(value => [String(object(value)?.id ?? ''), object(value)]));
  const adjacency = new Map<string, string[]>();
  nodes.forEach((value, index) => {
    const id = object(value)?.id;
    if (typeof id === 'string') adjacency.set(id, refs.filter(ref => ref.owner === index).map(ref => ref.id));
  });
  while (queue.length) {
    const id = queue.pop()!;
    if (reachable.has(id)) continue;
    reachable.add(id);
    if (!byId.has(id)) continue;
    for (const next of adjacency.get(id) ?? []) queue.push(next);
  }
  nodes.forEach((value, index) => {
    const id = object(value)?.id;
    if (typeof id === 'string' && !reachable.has(id)) warning(diagnostics, 'NODE_UNREACHABLE', `Node is unreachable from start: ${id}`, `/nodes/${index}/id`);
  });
  return { diagnostics, valid: !diagnostics.some(item => item.severity === 'error') };
}

/** Validate then detach and freeze authoring data before runtime use. */
export function compileStory(input: Story, modules: readonly AdventureModule[] = []): CompiledStory {
  const registry = createModuleRegistry(modules);
  const result = validateStory(input, registry);
  const errors = result.diagnostics.filter(item => item.severity === 'error');
  if (errors.length) throw new NarrativeEngineError('STORY_INVALID', errors.map(item => `${item.path}: ${item.message}`).join('\n'));
  const story = cloneJson(input);
  const freeze = (value: unknown): void => {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
      Object.values(value).forEach(freeze);
      Object.freeze(value);
    }
  };
  freeze(story);
  return { story, nodes: new Map(story.nodes.map(node => [node.id, node])), registry };
}

export function formatDiagnostics(result: NarrativeValidationResult, format: 'text' | 'json' = 'text'): string {
  if (format === 'json') return JSON.stringify(result, null, 2);
  return result.diagnostics.map(item => `${item.severity.toUpperCase()} ${item.code} ${item.path}: ${item.message}`).join('\n') || 'No issues found.';
}

export function validateExpressionForContent(expression: ValueExpression | Condition | Action): boolean {
  return expression !== undefined;
}

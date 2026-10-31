// Deterministic narrative session flow adapted from Nilarf2/text-adventure-engine (MIT), © 2026 Nilarf2.
import { compileStory } from './workflow-content.js';
import {
  assertJson,
  cloneJson,
  NARRATIVE_ENGINE_VERSION,
  NARRATIVE_SCHEMA_VERSION,
  NarrativeEngineError,
  type Action,
  type AdventureModule,
  type AudioChannel,
  type AudioTrack,
  type BranchNode,
  type ChoiceNode,
  type CompiledStory,
  type Condition,
  type CustomNode,
  type DialogueLine,
  type DialogueNode,
  type ExecutionContext,
  type GameSession,
  type JsonValue,
  type ModuleNode,
  type PendingModuleRequest,
  type PlayerCommand,
  type RuntimeEffect,
  type RuntimeEvent,
  type SessionOptions,
  type SessionSnapshot,
  type SessionState,
  type SessionView,
  type StepResult,
  type Story,
  type StoryNode,
  type ValueExpression,
} from './workflow-types.js';

type AnyRecord = Record<string, unknown>;
const isObject = (value: unknown): value is AnyRecord => value !== null && typeof value === 'object' && !Array.isArray(value);
function fail(code: string, message: string, path?: string): never { throw new NarrativeEngineError(code, message, path); }
function required<T>(value: T | undefined, code: string, message: string): T { return value === undefined ? fail(code, message) : value; }

function checkedScalar(value: unknown): string | number | boolean {
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return fail('SCALAR', 'Expected a finite scalar');
}

function seedValue(value: number | undefined): number {
  const seed = value === undefined ? 0x6d2b79f5 : value;
  if (!Number.isFinite(seed)) fail('SEED', 'Seed must be finite');
  return (Math.trunc(seed) >>> 0) || 0x6d2b79f5;
}

function interpolate(text: string, variables: Record<string, string | number | boolean>): string {
  return text.replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_.-]*)\s*\}\}/g, (_match, name: string) => {
    const value = Object.hasOwn(variables, name) ? variables[name] : undefined;
    return value === undefined ? '' : String(value);
  });
}

function compare(left: unknown, right: unknown, op: string): boolean {
  if (op === 'eq') return left === right;
  if (op === 'ne') return left !== right;
  if (typeof left !== 'number' || typeof right !== 'number') return false;
  if (op === 'gt') return left > right;
  if (op === 'gte') return left >= right;
  if (op === 'lt') return left < right;
  return left <= right;
}

function audioTrack(asset: string, options?: { loop?: boolean; volume?: number }): AudioTrack {
  const volume = options?.volume ?? 1;
  if (!Number.isFinite(volume) || volume < 0 || volume > 1) fail('AUDIO_VOLUME', 'Audio volume must be between 0 and 1');
  return { asset, loop: options?.loop ?? true, volume };
}

function cloneState(state: SessionState): SessionState { return cloneJson(state); }

/** Create a deterministic, saveable session from content or precompiled content. */
export function createNarrativeSession(
  input: CompiledStory | Story,
  modulesOrOptions?: readonly AdventureModule[] | SessionOptions,
  maybeOptions?: SessionOptions,
): GameSession {
  const compiled = 'registry' in input && 'nodes' in input
    ? input as CompiledStory
    : compileStory(input as Story, Array.isArray(modulesOrOptions) ? modulesOrOptions : []);
  const options: SessionOptions = Array.isArray(modulesOrOptions) ? maybeOptions ?? {} : (modulesOrOptions as SessionOptions | undefined) ?? {};
  const registry = compiled.registry;
  const story = compiled.story;
  const maxAutoSteps = options.maxAutoSteps ?? 1000;
  if (!Number.isSafeInteger(maxAutoSteps) || maxAutoSteps < 1) fail('OPTIONS', 'maxAutoSteps must be a positive integer');

  const variables: Record<string, string | number | boolean> = {};
  for (const [name, definition] of Object.entries(story.variables ?? {})) variables[name] = definition.default;
  const moduleState: Record<string, { version: number; data: JsonValue }> = {};
  for (const [id, module] of registry.modules) {
    moduleState[id] = { version: module.stateVersion ?? 1, data: module.initialState === undefined ? null : cloneJson(module.initialState) };
  }
  let state: SessionState = {
    started: false,
    revision: 0,
    nodeId: story.start,
    lineIndex: 0,
    awaiting: 'start',
    variables,
    tags: [],
    visits: {},
    randomState: seedValue(options.seed),
    requestSequence: 0,
    modules: moduleState,
    audio: {},
  };
  let disposed = false;
  let busy = false;
  let notifying = false;
  const listeners = new Set<(result: StepResult) => void>();

  const nextRandom = (draft: SessionState): number => {
    draft.randomState = (Math.imul(draft.randomState, 1664525) + 1013904223) >>> 0;
    return draft.randomState / 0x100000000;
  };
  const assertLive = (): void => { if (disposed) fail('DISPOSED', 'Session has been disposed'); };
  const getNode = (id: string): StoryNode => compiled.nodes.get(id) ?? fail('NODE_MISSING', `Node not found: ${id}`);

  const setVariable = (draft: SessionState, name: string, value: unknown): void => {
    const checked = checkedScalar(value);
    const definition = required(story.variables?.[name], 'VARIABLE_MISSING', `Variable not declared: ${name}`);
    if (typeof checked !== definition.type) fail('VARIABLE_TYPE', `Variable ${name} must be ${definition.type}`);
    draft.variables[name] = checked;
  };

  const contextFor = (draft: SessionState, events: RuntimeEvent[], effects: RuntimeEffect[], mutable: boolean): ExecutionContext => ({
    getVariable: name => Object.hasOwn(draft.variables, name) ? draft.variables[name] : fail('VARIABLE_MISSING', `Variable not found: ${name}`),
    setVariable: (name, value) => {
      if (!mutable) fail('READONLY_CONTEXT', 'This context is read-only');
      setVariable(draft, name, value);
    },
    hasTag: tag => draft.tags.includes(tag),
    setTag: (tag, present) => {
      if (!mutable) fail('READONLY_CONTEXT', 'This context is read-only');
      const index = draft.tags.indexOf(tag);
      if (present && index < 0) draft.tags.push(tag);
      else if (!present && index >= 0) draft.tags.splice(index, 1);
    },
    visitCount: nodeId => draft.visits[nodeId] ?? 0,
    random: () => mutable ? nextRandom(draft) : draft.randomState / 0x100000000,
    getModuleState: moduleId => {
      const slice = draft.modules[moduleId];
      if (!slice) fail('MODULE_STATE', `Module state not found: ${moduleId}`);
      return cloneJson(slice.data);
    },
    setModuleState: (moduleId, value) => {
      if (!mutable) fail('READONLY_CONTEXT', 'This context is read-only');
      assertJson(value);
      const slice = draft.modules[moduleId];
      if (!slice) fail('MODULE_STATE', `Module state not found: ${moduleId}`);
      slice.data = cloneJson(value);
    },
    emit: event => {
      if (!mutable) fail('READONLY_CONTEXT', 'This context is read-only');
      assertJson(event);
      events.push(cloneJson(event));
    },
    effect: effect => {
      if (!mutable) fail('READONLY_CONTEXT', 'This context is read-only');
      assertJson(effect);
      effects.push(cloneJson(effect));
    },
    capability: <T>(name: `${string}:${string}`): T => {
      if (!registry.capabilities.has(name)) fail('CAPABILITY_MISSING', `Capability not found: ${name}`);
      return registry.capabilities.get(name) as T;
    },
  });

  const valueOf = (expression: ValueExpression, draft: SessionState, mutable: boolean): string | number | boolean => {
    if (typeof expression === 'string' || typeof expression === 'boolean' || typeof expression === 'number') return expression;
    const expr = isObject(expression) ? expression : undefined;
    if (expr && 'var' in expr && typeof expr.var === 'string') return Object.hasOwn(draft.variables, expr.var) ? draft.variables[expr.var] : fail('VARIABLE_MISSING', `Variable not found: ${expr.var}`);
    if (expr && 'random' in expr && isObject(expr.random)) {
      const min = expr.random.min;
      const max = expr.random.max;
      if (typeof min !== 'number' || typeof max !== 'number' || !Number.isFinite(min) || !Number.isFinite(max) || max < min) fail('RANDOM_RANGE', 'Invalid random range');
      const random = mutable ? nextRandom(draft) : draft.randomState / 0x100000000;
      return min + random * (max - min);
    }
    return fail('EXPRESSION', 'Invalid value expression');
  };

  const conditionOf = (condition: Condition, draft: SessionState, events: RuntimeEvent[], effects: RuntimeEffect[], mutable: boolean): boolean => {
    if (!isObject(condition) || typeof condition.op !== 'string') fail('CONDITION', 'Invalid condition');
    switch (condition.op) {
      case 'eq': case 'ne': case 'gt': case 'gte': case 'lt': case 'lte':
        return compare(valueOf(condition.left, draft, mutable), valueOf(condition.right, draft, mutable), condition.op);
      case 'and': return condition.conditions.every(item => conditionOf(item, draft, events, effects, mutable));
      case 'or': return condition.conditions.some(item => conditionOf(item, draft, events, effects, mutable));
      case 'not': return !conditionOf(condition.condition, draft, events, effects, mutable);
      case 'tag': return draft.tags.includes(condition.tag);
      case 'visited': return (draft.visits[condition.node] ?? 0) >= (condition.count ?? 1);
      default: {
        const extension = required(registry.conditions.get(condition.op), 'CONDITION_UNKNOWN', `Unregistered condition: ${condition.op}`);
        const errors = extension.validate?.(condition) ?? [];
        if (errors.length) fail('EXTENSION_DATA', errors.join('; '));
        return extension.handler(contextFor(draft, events, effects, mutable), condition.data);
      }
    }
  };

  const doAction = (action: Action, draft: SessionState, events: RuntimeEvent[], effects: RuntimeEffect[]): void => {
    if (!isObject(action) || typeof action.type !== 'string') fail('ACTION', 'Invalid action');
    const context = contextFor(draft, events, effects, true);
    switch (action.type) {
      case 'set': setVariable(draft, action.variable, valueOf(action.value, draft, true)); return;
      case 'add': {
        const value = valueOf(action.value, draft, true);
        const current = draft.variables[action.variable];
        if (typeof value !== 'number' || typeof current !== 'number') fail('VARIABLE_TYPE', `Variable ${action.variable} must be numeric for add`);
        setVariable(draft, action.variable, (current as number) + value);
        return;
      }
      case 'tag.add': if (!draft.tags.includes(action.tag)) draft.tags.push(action.tag); return;
      case 'tag.remove': draft.tags = draft.tags.filter(tag => tag !== action.tag); return;
      case 'emit': {
        if (action.payload !== undefined) assertJson(action.payload);
        events.push(action.payload === undefined ? { type: action.name } : { type: action.name, payload: cloneJson(action.payload) });
        return;
      }
      case 'audio.play': {
        const channel: AudioChannel = action.channel ?? 'music';
        const track = audioTrack(action.asset, action.options);
        draft.audio[channel] = track;
        effects.push(action.options?.fadeMs === undefined
          ? { type: 'audio.play', channel, track }
          : { type: 'audio.play', channel, track, fadeMs: action.options.fadeMs });
        return;
      }
      case 'audio.stop': {
        const channel: AudioChannel = action.channel ?? 'music';
        delete draft.audio[channel];
        effects.push(action.fadeMs === undefined ? { type: 'audio.stop', channel } : { type: 'audio.stop', channel, fadeMs: action.fadeMs });
        return;
      }
      case 'audio.sfx':
        if (action.volume !== undefined && (!Number.isFinite(action.volume) || action.volume < 0 || action.volume > 1)) fail('AUDIO_VOLUME', 'Audio volume must be between 0 and 1');
        effects.push(action.volume === undefined ? { type: 'audio.sfx', asset: action.asset } : { type: 'audio.sfx', asset: action.asset, volume: action.volume });
        return;
      case 'checkpoint':
        if (action.name === undefined) delete draft.checkpoint;
        else draft.checkpoint = action.name;
        effects.push(action.name === undefined ? { type: 'checkpoint' } : { type: 'checkpoint', name: action.name });
        return;
      default: {
        const extension = required(registry.actions.get(action.type), 'ACTION_UNKNOWN', `Unregistered action: ${action.type}`);
        const errors = extension.validate?.(action) ?? [];
        if (errors.length) fail('EXTENSION_DATA', errors.join('; '));
        extension.handler(context, action.data);
      }
    }
  };

  const enter = (draft: SessionState, events: RuntimeEvent[], effects: RuntimeEffect[], initialTarget: string): void => {
    let target = initialTarget;
    for (let step = 0; ; step++) {
      if (step >= maxAutoSteps) fail('AUTO_STEP_LIMIT', 'Automatic node processing exceeded the configured limit');
      const node = getNode(target);
      draft.nodeId = node.id;
      draft.lineIndex = 0;
      draft.visits[node.id] = (draft.visits[node.id] ?? 0) + 1;
      if (!Number.isSafeInteger(draft.visits[node.id])) fail('STATE_COUNTER', 'Node visit count exceeded safe integer range');
      for (const action of node.onEnter ?? []) doAction(action, draft, events, effects);
      switch (node.type) {
        case 'dialogue': case 'narration': draft.awaiting = 'continue'; return;
        case 'choice': {
          const selectable = node.options.some(option =>
            (option.when === undefined || conditionOf(option.when, draft, events, effects, false)) &&
            (option.disabledWhen === undefined || !conditionOf(option.disabledWhen, draft, events, effects, false)));
          if (!selectable) {
            if (node.fallback) { target = node.fallback; continue; }
            fail('CHOICE_EMPTY', `Choice ${node.id} has no selectable options or fallback`);
          }
          draft.awaiting = 'choice';
          return;
        }
        case 'branch': {
          const branch = (node as BranchNode).branches.find(item => conditionOf(item.when, draft, events, effects, true));
          target = branch?.next ?? (node as BranchNode).fallback;
          continue;
        }
        case 'action':
          for (const action of node.actions) doAction(action, draft, events, effects);
          target = node.next;
          continue;
        case 'scene': {
          draft.scene = node.background === undefined ? { id: node.scene } : { id: node.scene, background: node.background };
          effects.push(node.background === undefined ? { type: 'scene', scene: node.scene } : { type: 'scene', scene: node.scene, background: node.background });
          if (node.music !== undefined) {
            const track = audioTrack(node.music);
            draft.audio.music = track;
            effects.push({ type: 'audio.play', channel: 'music', track });
          }
          if (node.ambience !== undefined) {
            const track = audioTrack(node.ambience);
            draft.audio.ambience = track;
            effects.push({ type: 'audio.play', channel: 'ambience', track });
          }
          target = node.next;
          continue;
        }
        case 'module': {
          const moduleNode = node as ModuleNode;
          if (!registry.modules.has(moduleNode.module)) fail('MODULE_UNKNOWN', `Module is not registered: ${moduleNode.module}`);
          const id = `${moduleNode.module}:${++draft.requestSequence}`;
          const request: PendingModuleRequest = { id, module: moduleNode.module, nodeId: node.id, input: moduleNode.input === undefined ? null : cloneJson(moduleNode.input) };
          draft.pending = request;
          draft.awaiting = 'module';
          effects.push({ type: 'module.request', request });
          return;
        }
        case 'end': draft.awaiting = 'ended'; draft.ending = node.ending; return;
        default: {
          const extension = required(registry.nodes.get(node.type), 'NODE_TYPE', `Unregistered node type: ${node.type}`);
          const errors = extension.validate?.(node) ?? [];
          if (errors.length) fail('EXTENSION_DATA', errors.join('; '));
          const next = extension.handler(contextFor(draft, events, effects, true), node as CustomNode);
          if (typeof next !== 'string' || !next) fail('NODE_NEXT', `Custom node ${node.id} did not return a next node`);
          target = next;
        }
      }
    }
  };

  const makeView = (cursor: SessionState): SessionView => {
    const node = getNode(cursor.nodeId);
    const view: SessionView = { nodeId: cursor.nodeId, awaiting: cursor.awaiting };
    if (cursor.scene) view.scene = cloneJson(cursor.scene);
    if (cursor.pending) view.pending = cloneJson(cursor.pending);
    if (cursor.ending !== undefined && node.type === 'end') {
      view.ending = { id: cursor.ending, ...(node.text === undefined ? {} : { text: interpolate(node.text, cursor.variables) }) };
    }
    if (node.type === 'dialogue' || node.type === 'narration') {
      const line: DialogueLine | undefined = node.lines[cursor.lineIndex];
      if (line) view.line = {
        text: interpolate(line.text, cursor.variables),
        ...(line.speaker === undefined ? {} : { speaker: line.speaker }),
        ...(line.expression === undefined ? {} : { expression: line.expression }),
        ...(line.voice === undefined ? {} : { voice: line.voice }),
      };
    }
    if (node.type === 'choice') {
      const choices: NonNullable<SessionView['choices']> = [];
      for (const option of node.options) {
        if (option.when !== undefined && !conditionOf(option.when, cursor, [], [], false)) continue;
        const disabled = option.disabledWhen === undefined ? false : conditionOf(option.disabledWhen, cursor, [], [], false);
        choices.push({
          id: option.id,
          text: interpolate(option.text, cursor.variables),
          disabled,
          ...(disabled && option.disabledReason !== undefined ? { disabledReason: option.disabledReason } : {}),
        });
      }
      if (node.prompt !== undefined) view.prompt = interpolate(node.prompt, cursor.variables);
      view.choices = choices;
    }
    return cloneJson(view);
  };

  const publish = (result: StepResult): void => {
    notifying = true;
    try {
      for (const listener of [...listeners]) {
        try { listener(cloneJson(result)); }
        catch (error) { try { options.onListenerError?.(error); } catch { /* Listener errors cannot undo a committed transition. */ } }
      }
    } finally { notifying = false; }
  };

  const transact = (
    operation: (draft: SessionState, events: RuntimeEvent[], effects: RuntimeEffect[]) => void,
    notify = true,
    preserveRevision = false,
  ): StepResult => {
    assertLive();
    if (busy || notifying) fail('REENTRANT', 'Session command is already in progress');
    busy = true;
    try {
      const draft = cloneState(state);
      const events: RuntimeEvent[] = [];
      const effects: RuntimeEffect[] = [];
      operation(draft, events, effects);
      if (!preserveRevision) draft.revision = state.revision + 1;
      for (const counter of [draft.revision, draft.requestSequence, ...Object.values(draft.visits)]) {
        if (!Number.isSafeInteger(counter) || counter < 0) fail('STATE_COUNTER', 'Session counter exceeded safe integer range');
      }
      assertJson(draft);
      const result: StepResult = { state: cloneState(draft), view: makeView(draft), events: cloneJson(events), effects: cloneJson(effects) };
      state = draft;
      if (notify) publish(result);
      return result;
    } finally { busy = false; }
  };

  const dispatch = (command: PlayerCommand): StepResult => transact((draft, events, effects) => {
    if (!command || !['continue', 'choose', 'module.result', 'module.command'].includes(command.type)) fail('COMMAND_UNKNOWN', 'Unknown player command type');
    if (!draft.started) fail('NOT_STARTED', 'Call start() before dispatching commands');
    if (draft.awaiting === 'ended') fail('GAME_ENDED', 'The game has already ended');
    if (draft.awaiting === 'module' && command.type !== 'module.result') fail('MODULE_WAIT', 'Session is waiting for a module result');
    if (draft.awaiting !== 'module' && command.type === 'module.result') fail('MODULE_WAIT', 'No module result is pending');
    if (command.type === 'continue') {
      if (draft.awaiting !== 'continue') fail('COMMAND_STATE', 'Continue is only valid for dialogue');
      const node = getNode(draft.nodeId) as DialogueNode;
      if (draft.lineIndex + 1 < node.lines.length) draft.lineIndex++;
      else enter(draft, events, effects, node.next);
      return;
    }
    if (command.type === 'choose') {
      if (draft.awaiting !== 'choice') fail('COMMAND_STATE', 'Choose is only valid for choices');
      const node = getNode(draft.nodeId) as ChoiceNode;
      const option = node.options.find(item => item.id === command.optionId);
      if (!option) fail('OPTION_MISSING', `Unknown option: ${command.optionId}`);
      const selected = required(option, 'OPTION_MISSING', `Unknown option: ${command.optionId}`);
      if (selected.when !== undefined && !conditionOf(selected.when, draft, events, effects, false)) fail('OPTION_HIDDEN', 'This option is not available');
      if (selected.disabledWhen !== undefined && conditionOf(selected.disabledWhen, draft, events, effects, false)) fail('OPTION_DISABLED', selected.disabledReason ?? 'This option is disabled');
      for (const action of selected.actions ?? []) doAction(action, draft, events, effects);
      enter(draft, events, effects, selected.next);
      return;
    }
    if (command.type === 'module.result') {
      const pending = required(draft.pending, 'MODULE_REQUEST', 'No module request is pending');
      if (pending.id !== command.requestId) fail('MODULE_REQUEST', 'Module result does not match the pending request');
      const node = getNode(pending.nodeId) as ModuleNode;
      const target = node.outcomes[command.outcome];
      if (!target) fail('MODULE_OUTCOME', `Unknown module outcome: ${command.outcome}`);
      if (command.result !== undefined && node.resultVariable !== undefined) setVariable(draft, node.resultVariable, command.result);
      delete draft.pending;
      enter(draft, events, effects, target);
      return;
    }
    const extension = required(registry.commands.get(command.name), 'COMMAND_UNKNOWN', `Unregistered command: ${command.name}`);
    if (command.payload !== undefined) assertJson(command.payload);
    extension.handler(contextFor(draft, events, effects, true), command.payload);
  });

  const start = (): StepResult => transact((draft, events, effects) => {
    if (draft.started) return;
    draft.started = true;
    enter(draft, events, effects, story.start);
  });

  const snapshot = (): SessionSnapshot => {
    assertLive();
    return cloneJson({
      formatVersion: 1,
      engineVersion: NARRATIVE_ENGINE_VERSION,
      schemaVersion: NARRATIVE_SCHEMA_VERSION,
      gameId: story.id,
      contentVersion: story.version,
      moduleVersions: Object.fromEntries([...registry.modules].map(([id, module]) => [id, module.version])),
      state,
    });
  };

  const restore = (snapshotValue: SessionSnapshot): StepResult => transact((draft, _events, effects) => {
    const checked = prepareNarrativeSnapshot(snapshotValue, compiled);
    const incoming = cloneState(checked.state);
    for (const [id, module] of registry.modules) {
      const slice = required(incoming.modules[id], 'SNAPSHOT_MODULE', `Missing module state: ${id}`);
      const moduleVersionChanged = checked.moduleVersions[id] !== module.version;
      if (moduleVersionChanged || slice.version < (module.stateVersion ?? 1)) {
        if (!module.migrateState) fail('SNAPSHOT_MODULE_MIGRATION', `Module ${id} has no state migration`);
        slice.data = cloneJson(module.migrateState(cloneJson(slice.data), slice.version, module.stateVersion ?? 1));
        slice.version = module.stateVersion ?? 1;
      }
    }
    for (const key of Object.keys(draft)) delete (draft as unknown as Record<string, unknown>)[key];
    Object.assign(draft, incoming);
    if (draft.scene) effects.push(draft.scene.background === undefined
      ? { type: 'scene', scene: draft.scene.id }
      : { type: 'scene', scene: draft.scene.id, background: draft.scene.background });
    for (const channel of ['music', 'ambience'] as const) {
      const track = draft.audio[channel];
      effects.push(track ? { type: 'audio.play', channel, track } : { type: 'audio.stop', channel });
    }
    if (draft.pending) effects.push({ type: 'module.request', request: cloneJson(draft.pending) });
  }, false, true);

  return {
    start,
    dispatch,
    getView: () => { assertLive(); return makeView(state); },
    snapshot,
    restore,
    subscribe(listener) { assertLive(); listeners.add(listener); return () => listeners.delete(listener); },
    dispose() { disposed = true; listeners.clear(); },
  };
}

export const createSession = createNarrativeSession;
export default createNarrativeSession;

function prepareNarrativeSnapshot(snapshot: SessionSnapshot, compiled: CompiledStory): SessionSnapshot {
  validateNarrativeSnapshot(snapshot);
  if (snapshot.engineVersion !== NARRATIVE_ENGINE_VERSION) fail('SNAPSHOT_VERSION', 'Snapshot engine version differs');
  if (snapshot.schemaVersion !== NARRATIVE_SCHEMA_VERSION) fail('SNAPSHOT_SCHEMA', 'Snapshot schema version differs');
  if (snapshot.gameId !== compiled.story.id || snapshot.contentVersion !== compiled.story.version) fail('SNAPSHOT_CONTENT', 'Snapshot belongs to incompatible story content');
  validateSnapshotForStory(snapshot, compiled);
  for (const [id, module] of compiled.registry.modules) {
    const slice = snapshot.state.modules[id];
    if (!slice) fail('SNAPSHOT_MODULE', `Save is missing state for module: ${id}`);
    if (!Object.hasOwn(snapshot.moduleVersions, id)) fail('SNAPSHOT_MODULE', `Save is missing module version: ${id}`);
    if (slice.version > (module.stateVersion ?? 1)) fail('SNAPSHOT_MODULE_VERSION', `Module ${id} state is newer than the loaded module`);
    if (snapshot.moduleVersions[id] !== module.version && !module.migrateState) fail('SNAPSHOT_MODULE_VERSION', `Module ${id} changed without a migration`);
  }
  if ([...Object.keys(snapshot.state.modules), ...Object.keys(snapshot.moduleVersions)].some(id => !compiled.registry.modules.has(id))) fail('SNAPSHOT_MODULE', 'Save contains unavailable module state');
  return cloneJson(snapshot);
}

function validateSnapshotForStory(snapshot: SessionSnapshot, compiled: CompiledStory): void {
  const state = snapshot.state;
  const node = compiled.nodes.get(state.nodeId);
  if (!node) fail('SNAPSHOT_NODE', `Save refers to missing node: ${state.nodeId}`);
  if (!state.started) {
    if (state.awaiting !== 'start' || state.nodeId !== compiled.story.start || state.lineIndex !== 0 || state.pending || state.ending) fail('SNAPSHOT_STATE', 'Invalid unstarted cursor');
  } else {
    if (state.awaiting === 'start') fail('SNAPSHOT_STATE', 'Started session cannot await start');
    if (state.awaiting === 'continue') {
      if (node.type !== 'dialogue' && node.type !== 'narration') fail('SNAPSHOT_STATE', 'Invalid dialogue cursor');
      if (state.lineIndex >= node.lines.length) fail('SNAPSHOT_STATE', 'Invalid dialogue cursor');
    }
    if (state.awaiting === 'choice' && node.type !== 'choice') fail('SNAPSHOT_STATE', 'Invalid choice cursor');
    if (state.awaiting === 'ended') {
      if (node.type !== 'end' || state.ending !== node.ending) fail('SNAPSHOT_STATE', 'Invalid ending cursor');
    }
    if (state.awaiting !== 'continue' && state.lineIndex !== 0) fail('SNAPSHOT_STATE', 'Unexpected line cursor');
  }
  if ((state.awaiting === 'module') !== Boolean(state.pending)) fail('SNAPSHOT_STATE', 'Pending request and wait state disagree');
  if (state.pending) {
    if (node.type !== 'module' || state.pending.nodeId !== state.nodeId || state.pending.module !== node.module ||
      state.pending.id !== `${state.pending.module}:${state.requestSequence}` || state.requestSequence < 1 || !compiled.registry.modules.has(state.pending.module)) {
      fail('SNAPSHOT_STATE', 'Pending request does not match the current module node');
    }
  }
  if (state.awaiting !== 'ended' && state.ending !== undefined) fail('SNAPSHOT_STATE', 'Unexpected ending state');
  for (const id of Object.keys(state.visits)) if (!compiled.nodes.has(id)) fail('SNAPSHOT_NODE', `Unknown visited node: ${id}`);
  for (const [name, definition] of Object.entries(compiled.story.variables ?? {})) {
    if (typeof state.variables[name] !== definition.type) fail('SNAPSHOT_VARIABLE', `Variable ${name} is missing or has the wrong type`);
  }
  for (const name of Object.keys(state.variables)) if (!Object.hasOwn(compiled.story.variables ?? {}, name)) fail('SNAPSHOT_VARIABLE', `Undeclared variable: ${name}`);
}

function validateNarrativeSnapshot(value: unknown): asserts value is SessionSnapshot {
  assertJson(value);
  const snapshot = isObject(value) ? value : undefined;
  const state = snapshot && isObject(snapshot.state) ? snapshot.state : undefined;
  if (!snapshot || !state || snapshot.formatVersion !== 1 || typeof snapshot.engineVersion !== 'string' ||
      snapshot.schemaVersion !== NARRATIVE_SCHEMA_VERSION || typeof snapshot.gameId !== 'string' ||
      typeof snapshot.contentVersion !== 'string' || !isObject(snapshot.moduleVersions)) fail('SNAPSHOT_SHAPE', 'Invalid narrative snapshot header');
  if (!isObject(state.variables) || !isObject(state.visits) || !isObject(state.modules) || !isObject(state.audio) ||
      typeof state.started !== 'boolean' || !Number.isSafeInteger(state.revision) || (state.revision as number) < 0 ||
      typeof state.nodeId !== 'string' || !Number.isSafeInteger(state.lineIndex) || (state.lineIndex as number) < 0 ||
      !['start', 'continue', 'choice', 'module', 'ended'].includes(String(state.awaiting)) ||
      !Array.isArray(state.tags) || state.tags.some(tag => typeof tag !== 'string') ||
      !Number.isSafeInteger(state.randomState) || (state.randomState as number) < 0 || (state.randomState as number) > 0xffffffff ||
      !Number.isSafeInteger(state.requestSequence) || (state.requestSequence as number) < 0) fail('SNAPSHOT_SHAPE', 'Invalid narrative session state');
  for (const [key, value] of Object.entries(state.variables)) if (typeof value !== 'string' && typeof value !== 'boolean' && (typeof value !== 'number' || !Number.isFinite(value))) fail('SNAPSHOT_SHAPE', `Invalid variable ${key}`);
  for (const [key, value] of Object.entries(state.visits)) if (!Number.isSafeInteger(value) || (value as number) < 0) fail('SNAPSHOT_SHAPE', `Invalid visit counter ${key}`);
  for (const [id, moduleState] of Object.entries(state.modules)) {
    if (!isObject(moduleState) || !Number.isSafeInteger(moduleState.version) || (moduleState.version as number) < 1 || !Object.hasOwn(moduleState, 'data')) fail('SNAPSHOT_SHAPE', `Invalid module state ${id}`);
    assertJson(moduleState.data);
  }
  for (const [channel, track] of Object.entries(state.audio)) {
    if (channel !== 'music' && channel !== 'ambience') fail('SNAPSHOT_SHAPE', `Unknown audio channel ${channel}`);
    if (!isObject(track) || typeof track.asset !== 'string' || typeof track.loop !== 'boolean' || typeof track.volume !== 'number' || track.volume < 0 || track.volume > 1) fail('SNAPSHOT_SHAPE', `Invalid audio track ${channel}`);
  }
  for (const [id, version] of Object.entries(snapshot.moduleVersions)) if (typeof version !== 'string' || !version) fail('SNAPSHOT_SHAPE', `Invalid module version ${id}`);
  if (state.pending !== undefined) {
    const pending = isObject(state.pending) ? state.pending : undefined;
    if (!pending || typeof pending.id !== 'string' || typeof pending.module !== 'string' || typeof pending.nodeId !== 'string' || !Object.hasOwn(pending, 'input')) fail('SNAPSHOT_SHAPE', 'Invalid pending module request');
    assertJson(pending.input);
  }
  if (state.scene !== undefined && (!isObject(state.scene) || typeof state.scene.id !== 'string' || (state.scene.background !== undefined && typeof state.scene.background !== 'string'))) fail('SNAPSHOT_SHAPE', 'Invalid scene state');
  if (state.ending !== undefined && typeof state.ending !== 'string') fail('SNAPSHOT_SHAPE', 'Invalid ending state');
  if (state.checkpoint !== undefined && typeof state.checkpoint !== 'string') fail('SNAPSHOT_SHAPE', 'Invalid checkpoint state');
}

export function parseNarrativeSnapshot(serialized: string): SessionSnapshot {
  let parsed: unknown;
  try { parsed = JSON.parse(serialized) as unknown; }
  catch (cause) { throw new NarrativeEngineError('SNAPSHOT_PARSE', cause instanceof Error ? cause.message : 'Invalid JSON'); }
  validateNarrativeSnapshot(parsed);
  return cloneJson(parsed);
}

export function serializeNarrativeSnapshot(snapshot: SessionSnapshot): string {
  validateNarrativeSnapshot(snapshot);
  return JSON.stringify(cloneJson(snapshot));
}

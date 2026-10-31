// Narrative snapshot and save workflow adapted from Nilarf2/text-adventure-engine (MIT), © 2026 Nilarf2.
import {
  assertJson,
  cloneJson,
  NARRATIVE_ENGINE_VERSION,
  NARRATIVE_SCHEMA_VERSION,
  NarrativeEngineError,
  type CompiledStory,
  type GameSession,
  type JsonValue,
  type ModuleSlice,
  type SessionSnapshot,
} from './workflow-types.js';

export interface NarrativeSaveRecord {
  slotId: string;
  snapshot: SessionSnapshot;
  savedAt: string;
  label?: string;
}
export interface NarrativeSaveEntry {
  slotId: string;
  gameId: string;
  contentVersion: string;
  savedAt: string;
  label?: string;
}
export interface NarrativeSaveStore {
  list(gameId?: string): Promise<NarrativeSaveEntry[]>;
  read(slotId: string): Promise<NarrativeSaveRecord | null>;
  write(record: NarrativeSaveRecord): Promise<void>;
  delete(slotId: string): Promise<boolean>;
}
export type ContentMigration = (snapshot: SessionSnapshot, compiled: CompiledStory) => SessionSnapshot;
export interface PrepareSnapshotOptions {
  migrateContent?: ContentMigration;
  isModuleVersionCompatible?: (savedVersion: string, currentVersion: string) => boolean;
  isEngineVersionCompatible?: (savedVersion: string, currentVersion: string) => boolean;
}

type RecordValue = Record<string, unknown>;
const object = (value: unknown): RecordValue | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : undefined;
function fail(code: string, message: string, path?: string): never { throw new NarrativeEngineError(code, message, path); }

function nonEmpty(value: unknown, path: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) fail('SNAPSHOT_SHAPE', 'Expected a non-empty string', path);
}
function integer(value: unknown, path: string, minimum = 0): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) fail('SNAPSHOT_SHAPE', `Expected an integer >= ${minimum}`, path);
}
function stringRecord(value: unknown, path: string): asserts value is Record<string, string> {
  const record = object(value);
  if (!record) fail('SNAPSHOT_SHAPE', 'Expected an object', path);
  for (const [key, child] of Object.entries(record)) nonEmpty(child, `${path}/${key}`);
}

function validateTrack(value: unknown, path: string): void {
  const track = object(value);
  if (!track) fail('SNAPSHOT_SHAPE', 'Expected an object', path);
  nonEmpty(track.asset, `${path}/asset`);
  if (typeof track.loop !== 'boolean') fail('SNAPSHOT_SHAPE', 'Expected a boolean', `${path}/loop`);
  if (typeof track.volume !== 'number' || !Number.isFinite(track.volume) || track.volume < 0 || track.volume > 1) fail('SNAPSHOT_SHAPE', 'Expected a volume between 0 and 1', `${path}/volume`);
}

/** Validate only the JSON/save envelope. Story cursor checks are separate. */
export function validateNarrativeSnapshot(value: unknown): asserts value is SessionSnapshot {
  assertJson(value);
  const snapshot = object(value);
  if (!snapshot) fail('SNAPSHOT_SHAPE', 'Expected an object');
  if (snapshot.formatVersion !== 1) fail('SNAPSHOT_FORMAT', 'Unsupported save format version', '$/formatVersion');
  nonEmpty(snapshot.engineVersion, '$/engineVersion');
  if (snapshot.schemaVersion !== NARRATIVE_SCHEMA_VERSION) fail('SNAPSHOT_SCHEMA', 'Unsupported narrative schema', '$/schemaVersion');
  nonEmpty(snapshot.gameId, '$/gameId');
  nonEmpty(snapshot.contentVersion, '$/contentVersion');
  stringRecord(snapshot.moduleVersions, '$/moduleVersions');
  const state = object(snapshot.state);
  if (!state) fail('SNAPSHOT_SHAPE', 'Expected an object', '$/state');
  if (typeof state.started !== 'boolean') fail('SNAPSHOT_SHAPE', 'Expected a boolean', '$/state/started');
  integer(state.revision, '$/state/revision');
  nonEmpty(state.nodeId, '$/state/nodeId');
  integer(state.lineIndex, '$/state/lineIndex');
  if (!['start', 'continue', 'choice', 'module', 'ended'].includes(String(state.awaiting))) fail('SNAPSHOT_SHAPE', 'Unknown runtime wait state', '$/state/awaiting');
  const variables = object(state.variables);
  if (!variables) fail('SNAPSHOT_SHAPE', 'Expected an object', '$/state/variables');
  for (const [name, variable] of Object.entries(variables)) if (typeof variable !== 'string' && typeof variable !== 'boolean' && (typeof variable !== 'number' || !Number.isFinite(variable))) fail('SNAPSHOT_SHAPE', 'Expected a scalar variable value', `$/state/variables/${name}`);
  if (!Array.isArray(state.tags) || state.tags.some(tag => typeof tag !== 'string')) fail('SNAPSHOT_SHAPE', 'Expected an array of strings', '$/state/tags');
  const visits = object(state.visits);
  if (!visits) fail('SNAPSHOT_SHAPE', 'Expected an object', '$/state/visits');
  for (const [node, count] of Object.entries(visits)) integer(count, `$/state/visits/${node}`);
  integer(state.randomState, '$/state/randomState');
  if (state.randomState > 0xffffffff) fail('SNAPSHOT_SHAPE', 'PRNG state must be uint32', '$/state/randomState');
  integer(state.requestSequence, '$/state/requestSequence');
  const modules = object(state.modules);
  if (!modules) fail('SNAPSHOT_SHAPE', 'Expected an object', '$/state/modules');
  for (const [id, value] of Object.entries(modules)) {
    const slice = object(value);
    if (!slice) fail('SNAPSHOT_SHAPE', 'Expected an object', `$/state/modules/${id}`);
    integer(slice.version, `$/state/modules/${id}/version`, 1);
    if (!Object.hasOwn(slice, 'data')) fail('SNAPSHOT_SHAPE', 'Missing module state data', `$/state/modules/${id}/data`);
    assertJson(slice.data, `$/state/modules/${id}/data`);
  }
  const audio = object(state.audio);
  if (!audio) fail('SNAPSHOT_SHAPE', 'Expected an object', '$/state/audio');
  for (const [channel, track] of Object.entries(audio)) {
    if (channel !== 'music' && channel !== 'ambience') fail('SNAPSHOT_SHAPE', 'Unknown audio channel', `$/state/audio/${channel}`);
    validateTrack(track, `$/state/audio/${channel}`);
  }
  if (state.pending !== undefined) {
    const pending = object(state.pending);
    if (!pending) fail('SNAPSHOT_SHAPE', 'Expected an object', '$/state/pending');
    nonEmpty(pending.id, '$/state/pending/id');
    nonEmpty(pending.module, '$/state/pending/module');
    nonEmpty(pending.nodeId, '$/state/pending/nodeId');
    if (!Object.hasOwn(pending, 'input')) fail('SNAPSHOT_SHAPE', 'Missing module request input', '$/state/pending/input');
    assertJson(pending.input, '$/state/pending/input');
  }
  if (state.scene !== undefined) {
    const scene = object(state.scene);
    if (!scene) fail('SNAPSHOT_SHAPE', 'Expected an object', '$/state/scene');
    nonEmpty(scene.id, '$/state/scene/id');
    if (scene.background !== undefined && typeof scene.background !== 'string') fail('SNAPSHOT_SHAPE', 'Expected a string', '$/state/scene/background');
  }
  if (state.ending !== undefined && typeof state.ending !== 'string') fail('SNAPSHOT_SHAPE', 'Expected a string', '$/state/ending');
  if (state.checkpoint !== undefined && typeof state.checkpoint !== 'string') fail('SNAPSHOT_SHAPE', 'Expected a string', '$/state/checkpoint');
}

/** Validate cursor invariants against the currently compiled story. */
export function validateNarrativeSnapshotForStory(snapshot: SessionSnapshot, compiled: CompiledStory): void {
  validateNarrativeSnapshot(snapshot);
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
    if (node.type !== 'module' || state.pending.nodeId !== state.nodeId || state.pending.module !== node.module || state.pending.id !== `${state.pending.module}:${state.requestSequence}`) fail('SNAPSHOT_STATE', 'Pending request does not match current node');
  }
  if (state.awaiting !== 'ended' && state.ending !== undefined) fail('SNAPSHOT_STATE', 'Unexpected ending state');
  for (const id of Object.keys(state.visits)) if (!compiled.nodes.has(id)) fail('SNAPSHOT_NODE', `Unknown visited node: ${id}`);
  for (const [name, definition] of Object.entries(compiled.story.variables ?? {})) if (typeof state.variables[name] !== definition.type) fail('SNAPSHOT_VARIABLE', `Variable ${name} is missing or has the wrong type`);
  for (const name of Object.keys(state.variables)) if (!Object.hasOwn(compiled.story.variables ?? {}, name)) fail('SNAPSHOT_VARIABLE', `Undeclared variable: ${name}`);
}

function majorCompatible(saved: string, current: string): boolean {
  if (saved === current) return true;
  const savedMajor = /^(\d+)\./.exec(saved)?.[1];
  const currentMajor = /^(\d+)\./.exec(current)?.[1];
  return savedMajor !== undefined && savedMajor === currentMajor;
}

/** Validate, migrate and detach a save before handing it to a session. */
export function prepareNarrativeSnapshot(input: SessionSnapshot, compiled: CompiledStory, options: PrepareSnapshotOptions = {}): SessionSnapshot {
  validateNarrativeSnapshot(input);
  const engineCompatible = options.isEngineVersionCompatible ?? majorCompatible;
  if (!engineCompatible(input.engineVersion, NARRATIVE_ENGINE_VERSION)) fail('SNAPSHOT_VERSION', `Engine version ${input.engineVersion} is incompatible with ${NARRATIVE_ENGINE_VERSION}`);
  let snapshot = cloneJson(input);
  if (snapshot.gameId !== compiled.story.id) fail('SNAPSHOT_GAME', 'Save belongs to another game');
  if (snapshot.contentVersion !== compiled.story.version) {
    if (!options.migrateContent) fail('SNAPSHOT_CONTENT', 'Save content version differs and no content migration was provided');
    snapshot = options.migrateContent(snapshot, compiled);
    validateNarrativeSnapshot(snapshot);
    if (snapshot.gameId !== compiled.story.id || snapshot.contentVersion !== compiled.story.version) fail('SNAPSHOT_CONTENT_MIGRATION', 'Content migration did not target the loaded game version');
  }
  const moduleCompatible = options.isModuleVersionCompatible ?? majorCompatible;
  const registry = compiled.registry.modules;
  for (const moduleId of Object.keys(snapshot.state.modules)) {
    if (!registry.has(moduleId) || !Object.hasOwn(snapshot.moduleVersions, moduleId)) fail('SNAPSHOT_MODULE', `Save contains unavailable or unversioned module state: ${moduleId}`);
  }
  for (const moduleId of Object.keys(snapshot.moduleVersions)) {
    if (!registry.has(moduleId) || !snapshot.state.modules[moduleId]) fail('SNAPSHOT_MODULE', `Save requires unavailable module: ${moduleId}`);
  }
  for (const [moduleId, module] of registry) {
    const targetVersion = module.stateVersion ?? 1;
    const savedVersion = snapshot.moduleVersions[moduleId];
    let slice = snapshot.state.modules[moduleId];
    if (savedVersion === undefined || !slice) {
      snapshot.moduleVersions[moduleId] = module.version;
      snapshot.state.modules[moduleId] = { version: targetVersion, data: module.initialState === undefined ? null : cloneJson(module.initialState) };
      continue;
    }
    if (!moduleCompatible(savedVersion, module.version)) fail('SNAPSHOT_MODULE_VERSION', `Module ${moduleId} version ${savedVersion} is incompatible with ${module.version}`);
    if (slice.version > targetVersion) fail('SNAPSHOT_MODULE_STATE_VERSION', `Module ${moduleId} state is newer than this module`);
    if (slice.version < targetVersion) {
      if (!module.migrateState) fail('SNAPSHOT_MODULE_MIGRATION', `Module ${moduleId} has no state migration`);
      const migrate = module.migrateState;
      if (!migrate) fail('SNAPSHOT_MODULE_MIGRATION', `Module ${moduleId} has no state migration`);
      const migrated = migrate(cloneJson(slice.data), slice.version, targetVersion);
      assertJson(migrated, `$/state/modules/${moduleId}/data`);
      slice = { version: targetVersion, data: cloneJson(migrated) };
      snapshot.state.modules[moduleId] = slice;
    }
    snapshot.moduleVersions[moduleId] = module.version;
  }
  validateNarrativeSnapshotForStory(snapshot, compiled);
  snapshot.engineVersion = NARRATIVE_ENGINE_VERSION;
  return cloneJson(snapshot);
}

export function serializeNarrativeSnapshot(snapshot: SessionSnapshot): string {
  validateNarrativeSnapshot(snapshot);
  return JSON.stringify(cloneJson(snapshot));
}
export function parseNarrativeSnapshot(serialized: string): SessionSnapshot {
  let value: unknown;
  try { value = JSON.parse(serialized) as unknown; }
  catch (cause) { throw new NarrativeEngineError('SNAPSHOT_PARSE', cause instanceof Error ? cause.message : 'Invalid JSON'); }
  validateNarrativeSnapshot(value);
  return cloneJson(value);
}

export const validateSnapshot = validateNarrativeSnapshot;
export const validateSnapshotForStory = validateNarrativeSnapshotForStory;
export const prepareSnapshot = prepareNarrativeSnapshot;
export const serializeSnapshot = serializeNarrativeSnapshot;
export const parseSnapshot = parseNarrativeSnapshot;

function validSlotId(slotId: string): void {
  if (typeof slotId !== 'string' || slotId.trim().length === 0 || slotId.length > 180) fail('SAVE_SLOT', 'Save slot ID must contain 1 to 180 characters');
}
function validateRecord(value: unknown, expectedSlot?: string): NarrativeSaveRecord {
  const record = object(value);
  if (!record) fail('SAVE_RECORD', 'Invalid save record');
  if (typeof record.slotId !== 'string' || (expectedSlot !== undefined && record.slotId !== expectedSlot)) fail('SAVE_RECORD', 'Save slot ID does not match its key');
  validSlotId(record.slotId);
  if (typeof record.savedAt !== 'string' || !Number.isFinite(Date.parse(record.savedAt))) fail('SAVE_DATE', 'Invalid save timestamp');
  if (record.label !== undefined && typeof record.label !== 'string') fail('SAVE_LABEL', 'Save label must be text');
  validateNarrativeSnapshot(record.snapshot);
  return cloneJson(record as unknown as NarrativeSaveRecord);
}

export class MemoryNarrativeSaveStore implements NarrativeSaveStore {
  private readonly records = new Map<string, NarrativeSaveRecord>();
  async list(gameId?: string): Promise<NarrativeSaveEntry[]> {
    return [...this.records.values()].filter(record => gameId === undefined || record.snapshot.gameId === gameId).map(record => ({ slotId: record.slotId, gameId: record.snapshot.gameId, contentVersion: record.snapshot.contentVersion, savedAt: record.savedAt, ...(record.label === undefined ? {} : { label: record.label }) })).sort((left, right) => right.savedAt.localeCompare(left.savedAt));
  }
  async read(slotId: string): Promise<NarrativeSaveRecord | null> { validSlotId(slotId); const record = this.records.get(slotId); return record ? cloneJson(record) : null; }
  async write(record: NarrativeSaveRecord): Promise<void> { const valid = validateRecord(record); this.records.set(valid.slotId, valid); }
  async delete(slotId: string): Promise<boolean> { validSlotId(slotId); return this.records.delete(slotId); }
}

export class LocalStorageNarrativeSaveStore implements NarrativeSaveStore {
  private storage?: Pick<Storage, 'length' | 'key' | 'getItem' | 'setItem' | 'removeItem'>;
  private readonly memory = new Map<string, NarrativeSaveRecord>();
  constructor(storage?: Pick<Storage, 'length' | 'key' | 'getItem' | 'setItem' | 'removeItem'>, private readonly prefix = 'general-engine:narrative:v1:') {
    try { this.storage = storage ?? globalThis.localStorage; } catch { this.storage = undefined; }
  }
  async list(gameId?: string): Promise<NarrativeSaveEntry[]> {
    const entries: NarrativeSaveEntry[] = [];
    for (const record of this.memory.values()) entries.push(this.toEntry(record));
    try {
      if (this.storage) for (let index = 0; index < this.storage.length; index++) {
        const key = this.storage.key(index);
        if (!key?.startsWith(this.prefix)) continue;
        try {
          const slotId = decodeURIComponent(key.slice(this.prefix.length));
          const raw = this.storage.getItem(key);
          if (raw === null) continue;
          const record = validateRecord(JSON.parse(raw), slotId);
          this.memory.set(slotId, record);
          entries.push(this.toEntry(record));
        } catch { /* A corrupt slot is omitted from a listing; read reports its error. */ }
      }
    } catch { this.storage = undefined; }
    const unique = new Map<string, NarrativeSaveEntry>();
    for (const entry of entries) if (gameId === undefined || entry.gameId === gameId) unique.set(entry.slotId, entry);
    return [...unique.values()].sort((left, right) => right.savedAt.localeCompare(left.savedAt));
  }
  async read(slotId: string): Promise<NarrativeSaveRecord | null> {
    validSlotId(slotId);
    const memory = this.memory.get(slotId);
    let raw: string | null | undefined;
    try { raw = this.storage?.getItem(this.key(slotId)); }
    catch {
      this.storage = undefined;
      return memory ? cloneJson(memory) : null;
    }
    if (raw !== undefined && raw !== null) {
      const record = validateRecord(JSON.parse(raw), slotId);
      this.memory.set(slotId, record);
      return cloneJson(record);
    }
    return memory ? cloneJson(memory) : null;
  }
  async write(record: NarrativeSaveRecord): Promise<void> {
    const valid = validateRecord(record);
    this.memory.set(valid.slotId, valid);
    try { this.storage?.setItem(this.key(valid.slotId), JSON.stringify(valid)); }
    catch { this.storage = undefined; }
  }
  async delete(slotId: string): Promise<boolean> {
    validSlotId(slotId);
    const removed = this.memory.delete(slotId);
    const key = this.key(slotId);
    try {
      if (this.storage && this.storage.getItem(key) !== null) { this.storage.removeItem(key); return true; }
    } catch { this.storage = undefined; }
    return removed;
  }
  private toEntry(record: NarrativeSaveRecord): NarrativeSaveEntry {
    return { slotId: record.slotId, gameId: record.snapshot.gameId, contentVersion: record.snapshot.contentVersion, savedAt: record.savedAt, ...(record.label === undefined ? {} : { label: record.label }) };
  }
  private key(slotId: string): string { return `${this.prefix}${encodeURIComponent(slotId)}`; }
}

export interface SessionSaveOptions { label?: string; savedAt?: string }
export async function saveSession(store: NarrativeSaveStore, slotId: string, session: GameSession, options: SessionSaveOptions = {}): Promise<NarrativeSaveRecord> {
  const record: NarrativeSaveRecord = { slotId, snapshot: session.snapshot(), savedAt: options.savedAt ?? new Date().toISOString(), ...(options.label === undefined ? {} : { label: options.label }) };
  await store.write(record);
  return cloneJson(record);
}

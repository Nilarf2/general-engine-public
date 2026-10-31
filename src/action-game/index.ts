import type { Disposer, Entity, Json, Plugin, Vec3 } from '../core/index.js';
import { validateEntity } from '../core/index.js';
import { validateId } from '../core/validation.js';

export interface ActionWindow {
  readonly start: number;
  readonly end: number;
}
export interface ActionHitbox {
  readonly window: ActionWindow;
  /** Sphere center offset in the actor's local space. */
  readonly offset?: Vec3;
  readonly radius: number;
  readonly damage: number;
}
export interface ActionCue {
  readonly at: number;
  readonly kind: 'effect' | 'camera' | 'sound';
  readonly name: string;
  readonly payload?: Record<string, Json>;
}

export interface ActionDisplacement {
  readonly at: number;
  /** Local-space displacement requested from the host's character motor. */
  readonly delta: Vec3;
  readonly duration: number;
}

export interface ActionCancelWindow extends ActionWindow {
  /** Omit to allow any action to cancel during this window. */
  readonly actions?: readonly string[];
}

export interface ActionDefinition {
  readonly id: string;
  readonly duration: number;
  readonly cooldown?: number;
  readonly cost?: number;
  readonly kind?: 'attack' | 'dodge' | 'skill';
  readonly cancelWindows?: readonly ActionCancelWindow[];
  readonly invulnerability?: readonly ActionWindow[];
  readonly hitboxes?: readonly ActionHitbox[];
  readonly cues?: readonly ActionCue[];
  readonly displacements?: readonly ActionDisplacement[];
}

export interface CombatantDefinition {
  readonly actorId: string;
  readonly faction: string;
  readonly maxHealth: number;
  readonly health?: number;
  readonly maxResource?: number;
  readonly resource?: number;
  readonly hurtRadius?: number;
}

export interface ActionGameOptions {
  readonly actions: readonly ActionDefinition[];
  readonly inputBufferSeconds?: number;
  readonly maxBufferedInputs?: number;
  readonly combatants?: readonly CombatantDefinition[];
}

export interface ActiveActionSnapshot {
  readonly actionId: string;
  readonly kind: NonNullable<ActionDefinition['kind']>;
  readonly elapsed: number;
  readonly duration: number;
}

export interface CombatantSnapshot {
  readonly actorId: string;
  readonly faction: string;
  readonly health: number;
  readonly maxHealth: number;
  readonly resource: number;
  readonly maxResource: number;
  readonly hurtRadius: number;
  readonly defeated: boolean;
  readonly activeAction?: ActiveActionSnapshot;
  readonly cooldowns: Readonly<Record<string, number>>;
  readonly bufferedInputs: readonly string[];
}

export interface ActionGameEventMap {
  'action-game:combatant-registered': CombatantSnapshot;
  'action-game:combatant-removed': { readonly actorId: string };
  'action-game:action-start': { readonly actorId: string; readonly actionId: string; readonly kind: NonNullable<ActionDefinition['kind']>; readonly sequence: number; readonly resource: number };
  'action-game:action-cancel': { readonly actorId: string; readonly actionId: string; readonly nextActionId?: string; readonly elapsed: number; readonly reason: 'cancel-window' | 'combatant-removed' };
  'action-game:action-end': { readonly actorId: string; readonly actionId: string; readonly elapsed: number };
  'action-game:input-buffered': { readonly actorId: string; readonly actionId: string; readonly expiresAt: number };
  'action-game:input-expired': { readonly actorId: string; readonly actionId: string };
  'action-game:resource': { readonly actorId: string; readonly previous: number; readonly value: number; readonly max: number; readonly delta: number };
  'action-game:dodge': { readonly actorId: string; readonly actionId: string; readonly duration: number };
  'action-game:displacement': { readonly actorId: string; readonly actionId: string; readonly at: number; readonly localDelta: Vec3; readonly delta: Vec3; readonly duration: number };
  'action-game:effect': { readonly actorId: string; readonly actionId: string; readonly name: string; readonly at: number; readonly payload: Record<string, Json> };
  'action-game:sound': { readonly actorId: string; readonly actionId: string; readonly name: string; readonly at: number; readonly payload: Record<string, Json> };
  'action-game:camera': { readonly actorId: string; readonly actionId: string; readonly name: string; readonly at: number; readonly payload: Record<string, Json> };
  'action-game:hit': { readonly sourceId: string; readonly targetId: string; readonly actionId: string; readonly damage: number; readonly health: number; readonly maxHealth: number };
  'action-game:damage': { readonly sourceId: string; readonly targetId: string; readonly actionId: string; readonly damage: number; readonly health: number; readonly maxHealth: number };
  'action-game:evade': { readonly attackerId: string; readonly targetId: string; readonly actionId: string };
  'action-game:defeat': { readonly actorId: string; readonly sourceId: string; readonly actionId: string };
}

export type ActionGameEventName = keyof ActionGameEventMap;

export interface ActionInputReceipt {
  readonly actorId: string;
  readonly actionId: string;
  readonly status: 'started' | 'buffered' | 'rejected';
  readonly reason?: 'buffer-full' | 'defeated' | 'removed';
}

export interface ActionGameService {
  registerCombatant(definition: CombatantDefinition): CombatantSnapshot;
  unregisterCombatant(actorId: string): boolean;
  input(actorId: string, actionId: string): ActionInputReceipt;
  adjustResource(actorId: string, amount: number): number;
  get(actorId: string): CombatantSnapshot | undefined;
  inspect(): readonly CombatantSnapshot[];
  isInvulnerable(actorId: string): boolean;
  on<K extends ActionGameEventName>(type: K, listener: (payload: ActionGameEventMap[K]) => void): Disposer;
}

interface RuntimeWindow {
  readonly start: number;
  readonly end: number;
}

interface RuntimeStepRange {
  readonly start: number;
  readonly end: number;
  readonly startInclusive: boolean;
  readonly endInclusive: boolean;
}

interface RuntimeHitbox {
  readonly window: RuntimeWindow;
  readonly offset: Vec3;
  readonly radius: number;
  readonly damage: number;
}

interface RuntimeCue {
  readonly at: number;
  readonly kind: 'effect' | 'camera' | 'sound';
  readonly name: string;
  readonly payload: Record<string, Json>;
}

interface RuntimeDisplacement {
  readonly at: number;
  readonly delta: Vec3;
  readonly duration: number;
}

interface RuntimeAction extends Omit<ActionDefinition, 'cancelWindows' | 'invulnerability' | 'hitboxes' | 'cues' | 'displacements'> {
  readonly kind: NonNullable<ActionDefinition['kind']>;
  readonly cooldown: number;
  readonly cost: number;
  readonly cancelWindows: readonly (RuntimeWindow & { readonly actions?: readonly string[] })[];
  readonly invulnerability: readonly RuntimeWindow[];
  readonly hitboxes: readonly RuntimeHitbox[];
  readonly cues: readonly RuntimeCue[];
  readonly displacements: readonly RuntimeDisplacement[];
}

interface BufferedInput {
  readonly actionId: string;
  readonly expiresAt: number;
}

interface ActiveAction {
  readonly definition: RuntimeAction;
  elapsed: number;
  previousElapsed: number;
  cancelled: boolean;
  nextCue: number;
  nextDisplacement: number;
  readonly hitTargets: Set<string>;
  readonly evadedTargets: Set<string>;
}

interface Combatant {
  readonly actorId: string;
  readonly faction: string;
  readonly maxHealth: number;
  health: number;
  readonly maxResource: number;
  resource: number;
  readonly hurtRadius: number;
  readonly cooldowns: Map<string, number>;
  readonly inputBuffer: BufferedInput[];
  active?: ActiveAction;
  transitioning: boolean;
}

const epsilon = 1e-9;
const maxMagnitude = 1_000_000;
const compareIds = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

function finite(value: unknown, label: string, min = 0, max = maxMagnitude): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new TypeError(`${label} must be a finite number in [${min}, ${max}]`);
  }
  return value;
}

function vector(value: unknown, label: string): Vec3 {
  if (!Array.isArray(value) || value.length !== 3) throw new TypeError(`${label} must contain three finite numbers`);
  return [finite(value[0], `${label}[0]`, -maxMagnitude), finite(value[1], `${label}[1]`, -maxMagnitude), finite(value[2], `${label}[2]`, -maxMagnitude)];
}

function window(value: unknown, label: string, duration: number): RuntimeWindow {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  const candidate = value as Record<string, unknown>;
  const start = finite(candidate.start, `${label}.start`, 0, duration);
  const end = finite(candidate.end, `${label}.end`, 0, duration);
  if (end <= start) throw new RangeError(`${label}.end must be greater than start`);
  return { start, end };
}

function cloneJsonObject(value: unknown, label: string): Record<string, Json> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be a JSON object`);
  return validateEntity({ id: 'action-payload', data: value }).data;
}

function compileActions(definitions: readonly ActionDefinition[]): ReadonlyMap<string, RuntimeAction> {
  if (!Array.isArray(definitions) || definitions.length === 0) throw new TypeError('At least one action definition is required');
  const actions = new Map<string, RuntimeAction>();
  const pendingCancels: { actionId: string; targetId: string }[] = [];
  for (const source of definitions) {
    if (!source || typeof source !== 'object') throw new TypeError('Action definitions must be objects');
    const id = validateId(source.id, 'action.id');
    if (actions.has(id)) throw new TypeError(`Duplicate action: ${id}`);
    const duration = finite(source.duration, `${id}.duration`, Number.EPSILON, 60);
    const cooldown = finite(source.cooldown ?? 0, `${id}.cooldown`, 0, 600);
    const cost = finite(source.cost ?? 0, `${id}.cost`);
    const kind = source.kind ?? 'attack';
    if (kind !== 'attack' && kind !== 'dodge' && kind !== 'skill') throw new TypeError(`${id}.kind is unknown`);

    const cancelWindows: RuntimeAction['cancelWindows'] = (source.cancelWindows ?? []).map((item: ActionCancelWindow, index: number) => {
      const area = window(item, `${id}.cancelWindows[${index}]`, duration);
      if (item.actions !== undefined && !Array.isArray(item.actions)) throw new TypeError(`${id}.cancelWindows[${index}].actions must be an array`);
      const allowed = item.actions?.map((target: string) => {
        validateId(target, `${id}.cancelWindows[${index}].actions`);
        pendingCancels.push({ actionId: id, targetId: target });
        return target;
      });
      return { ...area, ...(allowed ? { actions: [...allowed] } : {}) };
    });
    const invulnerability: RuntimeAction['invulnerability'] = (source.invulnerability ?? []).map((item: ActionWindow, index: number) => window(item, `${id}.invulnerability[${index}]`, duration));
    const hitboxes: RuntimeAction['hitboxes'] = (source.hitboxes ?? []).map((item: ActionHitbox, index: number) => ({
      window: window(item.window, `${id}.hitboxes[${index}].window`, duration),
      offset: item.offset === undefined ? [0, 0, 0] as Vec3 : vector(item.offset, `${id}.hitboxes[${index}].offset`),
      radius: finite(item.radius, `${id}.hitboxes[${index}].radius`, Number.EPSILON, maxMagnitude),
      damage: finite(item.damage, `${id}.hitboxes[${index}].damage`, Number.EPSILON, maxMagnitude),
    }));
    const cues: RuntimeAction['cues'] = (source.cues ?? []).map((item: ActionCue, index: number) => {
      const at = finite(item.at, `${id}.cues[${index}].at`, 0, duration);
      if (at >= duration) throw new RangeError(`${id}.cues[${index}].at must be less than duration`);
      if (item.kind !== 'effect' && item.kind !== 'camera' && item.kind !== 'sound') throw new TypeError(`${id}.cues[${index}].kind must be effect, camera, or sound`);
      return { at, kind: item.kind, name: validateId(item.name, `${id}.cues[${index}].name`), payload: cloneJsonObject(item.payload ?? {}, `${id}.cues[${index}].payload`) };
    }).sort((a: RuntimeCue, b: RuntimeCue) => a.at - b.at);
    const displacements: RuntimeAction['displacements'] = (source.displacements ?? []).map((item: ActionDisplacement, index: number) => {
      const at = finite(item.at, `${id}.displacements[${index}].at`, 0, duration);
      if (at >= duration) throw new RangeError(`${id}.displacements[${index}].at must be less than duration`);
      return { at, delta: vector(item.delta, `${id}.displacements[${index}].delta`), duration: finite(item.duration, `${id}.displacements[${index}].duration`, Number.EPSILON, 10) };
    }).sort((a: RuntimeDisplacement, b: RuntimeDisplacement) => a.at - b.at);
    actions.set(id, {
      id, duration, cooldown, cost, kind,
      cancelWindows,
      invulnerability,
      hitboxes,
      cues,
      displacements,
    });
  }
  for (const { actionId, targetId } of pendingCancels) {
    if (!actions.has(targetId)) throw new TypeError(`${actionId} cancel window references unknown action ${targetId}`);
  }
  return actions;
}

function compileCombatant(definition: CombatantDefinition, world: Parameters<Plugin['setup']>[0]): Combatant {
  if (!definition || typeof definition !== 'object') throw new TypeError('Combatant definitions must be objects');
  const actorId = validateId(definition.actorId, 'combatant.actorId');
  if (!world.get(actorId)) throw new Error(`Combatant entity does not exist: ${actorId}`);
  if (typeof definition.faction !== 'string' || !definition.faction.trim() || definition.faction.length > 128) throw new TypeError('combatant.faction must be a nonempty string');
  const maxHealth = finite(definition.maxHealth, 'combatant.maxHealth', Number.EPSILON);
  const health = finite(definition.health ?? maxHealth, 'combatant.health', Number.EPSILON, maxHealth);
  const maxResource = finite(definition.maxResource ?? 100, 'combatant.maxResource');
  const resource = finite(definition.resource ?? maxResource, 'combatant.resource', 0, maxResource);
  const hurtRadius = finite(definition.hurtRadius ?? 0.45, 'combatant.hurtRadius', Number.EPSILON);
  return { actorId, faction: definition.faction, maxHealth, health, maxResource, resource, hurtRadius, cooldowns: new Map(), inputBuffer: [], transitioning: false };
}

function snapshot(actor: Combatant, actions: ReadonlyMap<string, RuntimeAction>): CombatantSnapshot {
  const active = actor.active;
  const cooldowns = Object.fromEntries([...actor.cooldowns.entries()].sort(([a], [b]) => compareIds(a, b)));
  return {
    actorId: actor.actorId,
    faction: actor.faction,
    health: actor.health,
    maxHealth: actor.maxHealth,
    resource: actor.resource,
    maxResource: actor.maxResource,
    hurtRadius: actor.hurtRadius,
    defeated: actor.health <= 0,
    ...(active ? { activeAction: { actionId: active.definition.id, kind: active.definition.kind, elapsed: active.elapsed, duration: active.definition.duration } } : {}),
    cooldowns,
    bufferedInputs: actor.inputBuffer.map(input => input.actionId),
  };
}
function rotateLocalOffset(entity: Entity, offset: Vec3): Vec3 {
  const [x, y, z, w] = entity.rotation;
  const tx = 2 * (y * offset[2] - z * offset[1]);
  const ty = 2 * (z * offset[0] - x * offset[2]);
  const tz = 2 * (x * offset[1] - y * offset[0]);
  return [
    offset[0] + w * tx + y * tz - z * ty,
    offset[1] + w * ty + z * tx - x * tz,
    offset[2] + w * tz + x * ty - y * tx,
  ];
}

function inside(windowArea: RuntimeWindow, elapsed: number): boolean {
  return elapsed + epsilon >= windowArea.start && elapsed < windowArea.end - epsilon;
}

function windowStepRange(windowArea: RuntimeWindow, previous: number, current: number, dt: number): RuntimeStepRange | undefined {
  if (current <= previous + epsilon) return inside(windowArea, current) ? { start: 1, end: 1, startInclusive: true, endInclusive: true } : undefined;
  if (windowArea.end <= previous + epsilon || windowArea.start > current + epsilon) return undefined;
  const from = Math.max(windowArea.start, previous);
  const to = Math.min(windowArea.end, current);
  if (from > to + epsilon) return undefined;
  const start = Math.max(0, Math.min(1, (from - previous) / dt));
  const end = Math.max(0, Math.min(1, (to - previous) / dt));
  const startInclusive = true;
  const endInclusive = to < windowArea.end - epsilon;
  if (Math.abs(start - end) <= epsilon && !(startInclusive && endInclusive)) return undefined;
  return { start, end, startInclusive, endInclusive };
}

function rangesOverlap(a: RuntimeStepRange, b: RuntimeStepRange): boolean {
  if (a.end < b.start - epsilon || b.end < a.start - epsilon) return false;
  if (Math.abs(a.end - b.start) <= epsilon && !(a.endInclusive && b.startInclusive)) return false;
  if (Math.abs(b.end - a.start) <= epsilon && !(b.endInclusive && a.startInclusive)) return false;
  return true;
}

/** Install deterministic action/combat rules on the CPU-only fixed-step World. */
export function createActionGamePlugin(options: ActionGameOptions): Plugin {
  const actions = compileActions(options.actions);
  const inputBufferSeconds = finite(options.inputBufferSeconds ?? 0.25, 'inputBufferSeconds', 0, 10);
  const maxBufferedInputs = options.maxBufferedInputs ?? 8;
  if (!Number.isSafeInteger(maxBufferedInputs) || maxBufferedInputs < 1 || maxBufferedInputs > 128) throw new TypeError('maxBufferedInputs must be an integer in [1, 128]');
  const initialCombatants = [...(options.combatants ?? [])];

  return {
    id: 'action-game',
    setup(world, scope) {
      if (world.services.has('action-game')) throw new Error('Action game service is already installed');
      const actors = new Map<string, Combatant>();
      const serviceListeners = new Set<Disposer>();
      let disposed = false;
      let actionSequence = 0;
      const assertLive = () => { if (disposed) throw new Error('Action game service is disposed'); };
      const emit = <K extends ActionGameEventName>(type: K, payload: ActionGameEventMap[K]) => world.events.emit(type, payload);

      const activeInvulnerability = (actor: Combatant): boolean => {
        const active = actor.active;
        return !!active && active.definition.invulnerability.some(area => inside(area, active.elapsed));
      };

      const startAction = (actor: Combatant, action: RuntimeAction): boolean => {
        if (actor.transitioning || actors.get(actor.actorId) !== actor) return false;
        if (actor.resource + epsilon < action.cost) throw new Error(`Insufficient resource for action ${action.id}`);
        actor.transitioning = true;
        try {
          const previous = actor.active;
          if (previous) {
            previous.cancelled = true;
            actor.active = undefined;
            emit('action-game:action-cancel', { actorId: actor.actorId, actionId: previous.definition.id, nextActionId: action.id, elapsed: previous.elapsed, reason: 'cancel-window' });
            if (actors.get(actor.actorId) !== actor) return false;
          }
          if (actor.resource + epsilon < action.cost) return false;
          const previousResource = actor.resource;
          actor.resource = Math.max(0, actor.resource - action.cost);
          if (actor.resource !== previousResource) emit('action-game:resource', { actorId: actor.actorId, previous: previousResource, value: actor.resource, max: actor.maxResource, delta: actor.resource - previousResource });
          if (actors.get(actor.actorId) !== actor) return false;
          if (action.cooldown > 0) actor.cooldowns.set(action.id, action.cooldown);
          const active: ActiveAction = { definition: action, elapsed: 0, previousElapsed: 0, cancelled: false, nextCue: 0, nextDisplacement: 0, hitTargets: new Set(), evadedTargets: new Set() };
          actor.active = active;
          actionSequence++;
          emit('action-game:action-start', { actorId: actor.actorId, actionId: action.id, kind: action.kind, sequence: actionSequence, resource: actor.resource });
          if (actors.get(actor.actorId) !== actor) return false;
          if (action.kind === 'dodge') emit('action-game:dodge', { actorId: actor.actorId, actionId: action.id, duration: action.duration });
          while (active.nextCue < action.cues.length && action.cues[active.nextCue]!.at <= epsilon) emitCue(actor, active, action.cues[active.nextCue++]!);
          while (active.nextDisplacement < action.displacements.length && action.displacements[active.nextDisplacement]!.at <= epsilon) emitDisplacement(actor, active, action.displacements[active.nextDisplacement++]!);
          return true;
        } finally {
          actor.transitioning = false;
        }
      };

      const canCancelTo = (actor: Combatant, actionId: string, stepDelta?: number): boolean => {
        const active = actor.active;
        if (!active) return true;
        return active.definition.cancelWindows.some(area => {
          const open = inside(area, active.elapsed) || (stepDelta !== undefined && windowStepRange(area, active.previousElapsed, active.elapsed, stepDelta) !== undefined);
          return open && (!area.actions || area.actions.includes(actionId));
        });
      };

      const completingActors = new Set<string>();
      const tryStart = (actor: Combatant, action: RuntimeAction, stepDelta?: number): boolean => {
        if (actor.transitioning || completingActors.has(actor.actorId) || actor.health <= 0 || !canCancelTo(actor, action.id, stepDelta)) return false;
        if ((actor.cooldowns.get(action.id) ?? 0) > epsilon || actor.resource + epsilon < action.cost) return false;
        return startAction(actor, action);
      };

      const service: ActionGameService = {
        registerCombatant(definition) {
          assertLive();
          const actor = compileCombatant(definition, world);
          if (actors.has(actor.actorId)) throw new Error(`Combatant already registered: ${actor.actorId}`);
          actors.set(actor.actorId, actor);
          const result = snapshot(actor, actions);
          emit('action-game:combatant-registered', result);
          return result;
        },
        unregisterCombatant(actorId) {
          assertLive();
          validateId(actorId, 'actorId');
          const actor = actors.get(actorId);
          if (!actor) return false;
          actors.delete(actorId);
          if (actor.active) emit('action-game:action-cancel', { actorId, actionId: actor.active.definition.id, elapsed: actor.active.elapsed, reason: 'combatant-removed' });
          emit('action-game:combatant-removed', { actorId });
          return true;
        },
        input(actorId, actionId) {
          assertLive();
          validateId(actorId, 'actorId');
          validateId(actionId, 'actionId');
          const actor = actors.get(actorId);
          if (!actor) throw new Error(`Unknown combatant: ${actorId}`);
          const action = actions.get(actionId);
          if (!action) throw new Error(`Unknown action: ${actionId}`);
          if (actor.health <= 0) return { actorId, actionId, status: 'rejected', reason: 'defeated' };
          if (tryStart(actor, action)) return { actorId, actionId, status: 'started' };
          if (actors.get(actorId) !== actor) return { actorId, actionId, status: 'rejected', reason: 'removed' };
          if (actor.inputBuffer.some(input => input.actionId === actionId)) return { actorId, actionId, status: 'buffered' };
          if (actor.inputBuffer.length >= maxBufferedInputs) return { actorId, actionId, status: 'rejected', reason: 'buffer-full' };
          actor.inputBuffer.push({ actionId, expiresAt: world.time + inputBufferSeconds });
          emit('action-game:input-buffered', { actorId, actionId, expiresAt: world.time + inputBufferSeconds });
          return { actorId, actionId, status: 'buffered' };
        },
        adjustResource(actorId, amount) {
          assertLive();
          validateId(actorId, 'actorId');
          finite(amount, 'resource amount', -maxMagnitude);
          const actor = actors.get(actorId);
          if (!actor) throw new Error(`Unknown combatant: ${actorId}`);
          if (actor.health <= 0) throw new Error(`Combatant is defeated: ${actorId}`);
          const previous = actor.resource;
          actor.resource = Math.min(actor.maxResource, Math.max(0, previous + amount));
          if (actor.resource !== previous) emit('action-game:resource', { actorId, previous, value: actor.resource, max: actor.maxResource, delta: actor.resource - previous });
          return actor.resource;
        },
        get(actorId) {
          assertLive();
          const actor = actors.get(actorId);
          return actor ? snapshot(actor, actions) : undefined;
        },
        inspect() {
          assertLive();
          return [...actors.values()].sort((a, b) => compareIds(a.actorId, b.actorId)).map(actor => snapshot(actor, actions));
        },
        isInvulnerable(actorId) {
          assertLive();
          const actor = actors.get(actorId);
          return actor ? activeInvulnerability(actor) : false;
        },
        on(type, listener) {
          assertLive();
          const unsubscribe = world.events.on<ActionGameEventMap[typeof type]>(type, listener);
          serviceListeners.add(unsubscribe);
          return () => {
            if (!serviceListeners.delete(unsubscribe)) return;
            unsubscribe();
          };
        },
      };

      function emitCue(actor: Combatant, active: ActiveAction, cue: RuntimeCue): void {
        const payload = { actorId: actor.actorId, actionId: active.definition.id, name: cue.name, at: cue.at, payload: cloneJsonObject(cue.payload, `${active.definition.id}.${cue.name}.payload`) };
        if (cue.kind === 'effect') emit('action-game:effect', payload);
        else if (cue.kind === 'sound') emit('action-game:sound', payload);
        else emit('action-game:camera', payload);
      }

      function emitDisplacement(actor: Combatant, active: ActiveAction, displacement: RuntimeDisplacement): void {
        const entity = world.get(actor.actorId);
        if (!entity) return;
        emit('action-game:displacement', {
          actorId: actor.actorId,
          actionId: active.definition.id,
          at: displacement.at,
          localDelta: [...displacement.delta] as Vec3,
          delta: rotateLocalOffset(entity, displacement.delta),
          duration: displacement.duration,
        });
      }

      const spawnCombatant = (definition: CombatantDefinition) => service.registerCombatant(definition);
      for (const definition of initialCombatants) spawnCombatant(definition);
      world.services.set('action-game', service);
      scope.defer(() => {
        disposed = true;
        for (const unsubscribe of [...serviceListeners].reverse()) unsubscribe();
        serviceListeners.clear();
        actors.clear();
        if (world.services.get('action-game') === service) world.services.delete('action-game');
      });
      scope.defer(world.events.on<Entity>('entity:remove', entity => { service.unregisterCombatant(entity.id); }));
      scope.defer(world.registerCommand('action-game:register', command => service.registerCombatant({
        actorId: command.actorId as string,
        faction: command.faction as string,
        maxHealth: command.maxHealth as number,
        ...(command.health === undefined ? {} : { health: command.health as number }),
        ...(command.maxResource === undefined ? {} : { maxResource: command.maxResource as number }),
        ...(command.resource === undefined ? {} : { resource: command.resource as number }),
        ...(command.hurtRadius === undefined ? {} : { hurtRadius: command.hurtRadius as number }),
      })));
      scope.defer(world.registerCommand('action-game:unregister', command => ({ removed: service.unregisterCombatant(command.actorId as string) })));
      scope.defer(world.registerCommand('action-game:input', command => service.input(command.actorId as string, command.actionId as string)));
      scope.defer(world.registerCommand('action-game:resource', command => ({ resource: service.adjustResource(command.actorId as string, command.amount as number) })));
      scope.defer(world.registerCommand('action-game:inspect', command => command.actorId === undefined ? service.inspect() : service.get(command.actorId as string) ?? null));
      scope.defer(world.addSystem({
        id: 'action-game-tick',
        phase: 'afterPhysics',
        update(_world, dt) {
          const actionSteps = new Map<string, { active: ActiveAction; previous: number; current: number }[]>();
          const completedActions: { actor: Combatant; active: ActiveAction }[] = [];
          const ordered = [...actors.values()].sort((a, b) => compareIds(a.actorId, b.actorId));
          for (const actor of ordered) {
            for (const [id, remaining] of actor.cooldowns) {
              const next = remaining - dt;
              if (next <= epsilon) actor.cooldowns.delete(id);
              else actor.cooldowns.set(id, next);
            }
            const active = actor.active;
            let finishing: ActiveAction | undefined;
            if (active) {
              const previous = active.elapsed;
              active.previousElapsed = previous;
              active.elapsed = Math.min(active.definition.duration, active.elapsed + dt);
              const step = actionSteps.get(actor.actorId) ?? [];
              step.push({ active, previous, current: active.elapsed });
              actionSteps.set(actor.actorId, step);
              while (active.nextCue < active.definition.cues.length && active.definition.cues[active.nextCue]!.at <= active.elapsed + epsilon) {
                const cue = active.definition.cues[active.nextCue++]!;
                if (cue.at > previous + epsilon) emitCue(actor, active, cue);
              }
              while (active.nextDisplacement < active.definition.displacements.length && active.definition.displacements[active.nextDisplacement]!.at <= active.elapsed + epsilon) {
                const displacement = active.definition.displacements[active.nextDisplacement++]!;
                if (displacement.at > previous + epsilon) emitDisplacement(actor, active, displacement);
              }
              if (active.elapsed + epsilon >= active.definition.duration) {
                finishing = active;
              }
            }
            if (finishing && actor.active === finishing) {
              actor.active = undefined;
              completingActors.add(actor.actorId);
              completedActions.push({ actor, active: finishing });
            }
            if (actor.active && !actionSteps.get(actor.actorId)?.some(step => step.active === actor.active)) {
              const step = actionSteps.get(actor.actorId) ?? [];
              step.push({ active: actor.active, previous: 0, current: 0 });
              actionSteps.set(actor.actorId, step);
            }
          }

          for (const actor of ordered) {
            if (actor.health <= 0) continue;
            const sourceEntity = world.get(actor.actorId);
            if (!sourceEntity) continue;
            const steps = actionSteps.get(actor.actorId) ?? [];
            for (const step of steps) {
              const { active } = step;
              if (active.cancelled) continue;
              for (const hitbox of active.definition.hitboxes) {
              const hitRange = windowStepRange(hitbox.window, step.previous, step.current, dt);
              if (!hitRange) continue;
              const rotated = rotateLocalOffset(sourceEntity, hitbox.offset);
              const center: Vec3 = [sourceEntity.position[0] + rotated[0], sourceEntity.position[1] + rotated[1], sourceEntity.position[2] + rotated[2]];
              for (const target of ordered) {
                if (active.cancelled) break;
                if (target.actorId === actor.actorId || target.faction === actor.faction || target.health <= 0 || active.hitTargets.has(target.actorId)) continue;
                const targetEntity = world.get(target.actorId);
                if (!targetEntity) continue;
                const dx = center[0] - targetEntity.position[0];
                const dy = center[1] - targetEntity.position[1];
                const dz = center[2] - targetEntity.position[2];
                const reach = hitbox.radius + target.hurtRadius;
                if (dx * dx + dy * dy + dz * dz > reach * reach + epsilon) continue;
                const targetSteps = actionSteps.get(target.actorId) ?? [];
                const invulnerableDuringHit = targetSteps.some(targetStep => targetStep.active.definition.invulnerability.some(area => {
                  const invulnerabilityRange = windowStepRange(area, targetStep.previous, targetStep.current, dt);
                  return invulnerabilityRange !== undefined && rangesOverlap(hitRange, invulnerabilityRange);
                }));
                if (invulnerableDuringHit) {
                  if (!active.evadedTargets.has(target.actorId)) {
                    active.evadedTargets.add(target.actorId);
                    emit('action-game:evade', { attackerId: actor.actorId, targetId: target.actorId, actionId: active.definition.id });
                  }
                  continue;
                }
                active.hitTargets.add(target.actorId);
                const previousHealth = target.health;
                target.health = Math.max(0, target.health - hitbox.damage);
                const hit = { sourceId: actor.actorId, targetId: target.actorId, actionId: active.definition.id, damage: previousHealth - target.health, health: target.health, maxHealth: target.maxHealth };
                emit('action-game:hit', { ...hit });
                emit('action-game:damage', { ...hit });
                if (target.health <= 0) {
                  if (target.active) target.active.cancelled = true;
                  for (const targetStep of actionSteps.get(target.actorId) ?? []) targetStep.active.cancelled = true;
                  target.active = undefined;
                  target.inputBuffer.length = 0;
                  emit('action-game:defeat', { actorId: target.actorId, sourceId: actor.actorId, actionId: active.definition.id });
                }
              }
            }
            }
          }
          for (const completed of completedActions) {
            try {
              if (!completed.active.cancelled) emit('action-game:action-end', { actorId: completed.actor.actorId, actionId: completed.active.definition.id, elapsed: completed.active.definition.duration });
            } finally {
              completingActors.delete(completed.actor.actorId);
            }
          }
          for (const actor of ordered) {
            if (actor.health <= 0) continue;
            for (let index = 0; index < actor.inputBuffer.length;) {
              const input = actor.inputBuffer[index]!;
              if (input.expiresAt + epsilon < world.time) {
                actor.inputBuffer.splice(index, 1);
                emit('action-game:input-expired', { actorId: actor.actorId, actionId: input.actionId });
                continue;
              }
              if (tryStart(actor, actions.get(input.actionId)!, dt)) {
                actor.inputBuffer.splice(index, 1);
                break;
              }
              index++;
            }
          }
        },
      }));
    },
  };
}

import { World } from '../../src/core/World.js';
import { createActionGamePlugin, type ActionGameOptions } from '../../src/action-game/index.js';
import { createCompositionRuntime, createWorldCompositionModule, type CompositionGraph, type JsonValue } from '../../src/composition/index.js';

export interface HeadlessComboResult {
  readonly worldTick: number;
  readonly playerHealth: number;
  readonly enemyHealth: number;
  readonly events: readonly string[];
}

const actionGame: ActionGameOptions = {
  inputBufferSeconds: 0.3,
  combatants: [
    { actorId: 'player', faction: 'hero', maxHealth: 100, maxResource: 100 },
    { actorId: 'training-target', faction: 'enemy', maxHealth: 100, maxResource: 0 },
  ],
  actions: [
    {
      id: 'quick-cut', duration: 0.34, kind: 'attack',
      cancelWindows: [{ start: 0.12, end: 0.3, actions: ['rising-strike', 'evade'] }],
      hitboxes: [{ window: { start: 0.04, end: 0.17 }, offset: [0, 0, -0.35], radius: 0.45, damage: 12 }],
      cues: [
        { at: 0.08, kind: 'effect', name: 'short-arc', payload: { color: '#62d8ff' } },
        { at: 0.08, kind: 'sound', name: 'light-impact' },
      ],
    },
    {
      id: 'rising-strike', duration: 0.5, kind: 'skill', cooldown: 1.2, cost: 25,
      cancelWindows: [{ start: 0.25, end: 0.42, actions: ['evade'] }],
      invulnerability: [{ start: 0.02, end: 0.15 }],
      hitboxes: [{ window: { start: 0.14, end: 0.27 }, offset: [0, 0.2, -0.5], radius: 0.7, damage: 26 }],
      cues: [
        { at: 0, kind: 'camera', name: 'attack-punch', payload: { strength: 0.25, seconds: 0.12 } },
        { at: 0.14, kind: 'effect', name: 'rising-trail' },
        { at: 0.14, kind: 'sound', name: 'heavy-hit' },
      ],
    },
    {
      id: 'evade', duration: 0.28, kind: 'dodge', cooldown: 0.4,
      invulnerability: [{ start: 0, end: 0.2 }],
      displacements: [{ at: 0, delta: [0, 0, -1.4], duration: 0.12 }],
      cues: [{ at: 0, kind: 'effect', name: 'evade-flash' }],
    },
  ],
};

/** Run a short deterministic combo against an authored dummy with no DOM or renderer. */
export async function runHeadlessCombo(): Promise<HeadlessComboResult> {
  const world = new World({ fixedDelta: 1 / 60 });
  const eventNames: string[] = [];
  for (const type of ['action-game:action-start', 'action-game:action-cancel', 'action-game:action-end', 'action-game:hit', 'action-game:effect', 'action-game:sound', 'action-game:camera']) {
    world.events.on(type, () => eventNames.push(type));
  }
  world.spawn({ id: 'player', position: [0, 0, 0], rotation: [0, 0, 0, 1] });
  world.spawn({ id: 'training-target', position: [0, 0, -0.85], rotation: [0, 0, 0, 1] });
  const graph: CompositionGraph = {
    id: 'headless-action-combo',
    version: 1,
    start: 'start-quick-cut',
    nodes: [
      commandNode('start-quick-cut', { type: 'action-game:input', actorId: 'player', actionId: 'quick-cut' }, 'advance-light'),
      { id: 'advance-light', type: 'module', module: 'world', input: { from: 'literal', value: { type: 'step', count: 4 } }, edges: [{ to: 'queue-rising-strike' }] },
      commandNode('queue-rising-strike', { type: 'action-game:input', actorId: 'player', actionId: 'rising-strike' }, 'advance-combo'),
      { id: 'advance-combo', type: 'module', module: 'world', input: { from: 'literal', value: { type: 'step', count: 36 } } },
    ],
  };
  const runtime = await createCompositionRuntime({
    graph,
    modules: [createWorldCompositionModule({ world, plugins: [createActionGamePlugin(actionGame)] })],
    initialState: {},
  });

  try {
    await runtime.run();
    const player = world.command({ type: 'action-game:inspect', actorId: 'player' }) as { health: number };
    const enemy = world.command({ type: 'action-game:inspect', actorId: 'training-target' }) as { health: number };
    const result: HeadlessComboResult = {
      worldTick: world.tick,
      playerHealth: player.health,
      enemyHealth: enemy.health,
      events: eventNames,
    };
    return result;
  } finally {
    await runtime.dispose();
    world.dispose();
  }
}

function commandNode(id: string, command: Record<string, JsonValue>, next: string) {
  return {
    id,
    type: 'module' as const,
    module: 'world',
    input: { from: 'literal' as const, value: { type: 'command', command } },
    edges: [{ to: next }],
  };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const result = await runHeadlessCombo();
  console.log(`tick ${result.worldTick}: target ${result.enemyHealth}/100; ${result.events.filter(event => event === 'action-game:hit').length} hits; ${result.events.length} gameplay cues/events`);
}

import { World, createWorldCompositionModule } from '@general-engine/engine';
import { createActionGamePlugin } from '@general-engine/engine/action-game';
import { createCompositionRuntime } from '@general-engine/engine/composition';

const world = new World({ fixedDelta: 1 / 60 });
world.spawn({ id: 'player', position: [0, 0, 0], rotation: [0, 0, 0, 1] });
world.spawn({ id: 'training-target', position: [0, 0, -0.85], rotation: [0, 0, 0, 1] });

const plugin = createActionGamePlugin({
  combatants: [
    { actorId: 'player', faction: 'hero', maxHealth: 100, maxResource: 100 },
    { actorId: 'training-target', faction: 'enemy', maxHealth: 100, maxResource: 0 },
  ],
  actions: [
    {
      id: 'quick-cut', duration: 0.34,
      cancelWindows: [{ start: 0.12, end: 0.3, actions: ['rising-strike'] }],
      hitboxes: [{ window: { start: 0.04, end: 0.17 }, offset: [0, 0, -0.35], radius: 0.45, damage: 12 }],
      cues: [{ at: 0.08, kind: 'sound', name: 'light-impact' }],
    },
    {
      id: 'rising-strike', duration: 0.5, kind: 'skill', cooldown: 1.2, cost: 25,
      hitboxes: [{ window: { start: 0.14, end: 0.27 }, offset: [0, 0.2, -0.5], radius: 0.7, damage: 26 }],
      cues: [{ at: 0, kind: 'camera', name: 'attack-punch' }],
    },
  ],
});

const graph = {
  id: 'headless-action-combo',
  version: 1,
  start: 'start',
  nodes: [
    { id: 'start', type: 'module', module: 'world', input: { from: 'literal', value: { type: 'command', command: { type: 'action-game:input', actorId: 'player', actionId: 'quick-cut' } } }, edges: [{ to: 'advance' }] },
    { id: 'advance', type: 'module', module: 'world', input: { from: 'literal', value: { type: 'step', count: 4 } }, edges: [{ to: 'queue' }] },
    { id: 'queue', type: 'module', module: 'world', input: { from: 'literal', value: { type: 'command', command: { type: 'action-game:input', actorId: 'player', actionId: 'rising-strike' } } }, edges: [{ to: 'finish' }] },
    { id: 'finish', type: 'module', module: 'world', input: { from: 'literal', value: { type: 'step', count: 36 } } },
  ],
};

const runtime = await createCompositionRuntime({
  graph,
  modules: [createWorldCompositionModule({ world, plugins: [plugin] })],
  initialState: {},
});

try {
  await runtime.run();
  const target = world.command({ type: 'action-game:inspect', actorId: 'training-target' });
  console.log(`tick ${world.tick}: target ${target.health}/100`);
} finally {
  await runtime.dispose();
  world.dispose();
}

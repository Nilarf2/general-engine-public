import assert from 'node:assert/strict';
import test from 'node:test';
import { World } from '../src/core/World.js';
import { createActionGamePlugin, type ActionGameService } from '../src/action-game/index.js';
import { runHeadlessCombo } from '../examples/action-game/headless-combo.js';

function createWorld() {
  const world = new World({ fixedDelta: 0.1 });
  world.spawn({ id: 'hero' });
  world.spawn({ id: 'foe', position: [0, 0, -0.8] });
  const events: { type: string; payload: any }[] = [];
  for (const type of ['action-game:action-start', 'action-game:action-cancel', 'action-game:input-buffered', 'action-game:hit', 'action-game:defeat', 'action-game:effect', 'action-game:camera', 'action-game:sound', 'action-game:displacement', 'action-game:dodge', 'action-game:evade']) {
    world.events.on(type, payload => events.push({ type, payload }));
  }
  world.install(createActionGamePlugin({
    inputBufferSeconds: 0.5,
    combatants: [
      { actorId: 'hero', faction: 'blue', maxHealth: 100, maxResource: 100 },
      { actorId: 'foe', faction: 'red', maxHealth: 40, maxResource: 0 },
    ],
    actions: [
      {
        id: 'jab', duration: 0.4,
        cancelWindows: [{ start: 0.2, end: 0.4, actions: ['heavy', 'dodge'] }],
        hitboxes: [{ window: { start: 0.1, end: 0.3 }, offset: [0, 0, -0.2], radius: 0.3, damage: 10 }],
        cues: [{ at: 0.1, kind: 'effect', name: 'arc' }, { at: 0.1, kind: 'sound', name: 'swing' }],
      },
      {
        id: 'heavy', duration: 0.3, kind: 'skill', cost: 25, cooldown: 0.5,
        invulnerability: [{ start: 0, end: 0.2 }],
        hitboxes: [{ window: { start: 0.1, end: 0.2 }, radius: 0.5, damage: 40 }],
        cues: [{ at: 0, kind: 'camera', name: 'punch' }],
      },
      {
        id: 'dodge', duration: 0.3, kind: 'dodge',
        invulnerability: [{ start: 0, end: 0.2 }],
        displacements: [{ at: 0, delta: [0, 0, -1], duration: 0.1 }],
      },
      {
        id: 'incoming', duration: 0.3,
        hitboxes: [{ window: { start: 0, end: 0.2 }, radius: 1, damage: 5 }],
      },
    ],
  }));
  return { world, events };
}

test('combo input buffers until a cancel window, consumes resource, hits once and emits host cues', t => {
  const { world, events } = createWorld();
  t.after(() => world.dispose());
  assert.deepEqual(world.command({ type: 'action-game:input', actorId: 'hero', actionId: 'jab' }), { actorId: 'hero', actionId: 'jab', status: 'started' });
  world.step();
  assert.deepEqual(world.command({ type: 'action-game:input', actorId: 'hero', actionId: 'heavy' }), { actorId: 'hero', actionId: 'heavy', status: 'buffered' });
  world.step(2);
  const hero = world.command({ type: 'action-game:inspect', actorId: 'hero' }) as any;
  assert.equal(hero.activeAction.actionId, 'heavy');
  assert.equal(hero.resource, 75);
  assert.equal(hero.cooldowns.heavy, 0.4);
  assert.deepEqual(hero.bufferedInputs, []);
  assert.ok(events.some(event => event.type === 'action-game:action-cancel' && event.payload.actionId === 'jab'));
  assert.ok(events.some(event => event.type === 'action-game:hit' && event.payload.targetId === 'foe' && event.payload.damage === 30));
  assert.equal((world.command({ type: 'action-game:inspect', actorId: 'foe' }) as any).health, 0);
  assert.ok(events.some(event => event.type === 'action-game:effect'));
  assert.ok(events.some(event => event.type === 'action-game:camera'));
  assert.ok(events.some(event => event.type === 'action-game:sound'));
  assert.deepEqual(world.command({ type: 'action-game:input', actorId: 'foe', actionId: 'jab' }), { actorId: 'foe', actionId: 'jab', status: 'rejected', reason: 'defeated' });
});
test('dodge exposes invulnerability and a deterministic local displacement request', t => {
  const { world, events } = createWorld();
  t.after(() => world.dispose());
  world.get('hero')!.rotation = [0, Math.SQRT1_2, 0, Math.SQRT1_2];
  world.command({ type: 'action-game:input', actorId: 'hero', actionId: 'dodge' });
  world.command({ type: 'action-game:input', actorId: 'foe', actionId: 'incoming' });
  const service = world.services.get('action-game') as ActionGameService;
  let typedEvade = false;
  const unsubscribe = service.on('action-game:evade', event => { typedEvade = event.targetId === 'hero'; });
  t.after(unsubscribe);
  assert.equal(service.isInvulnerable('hero'), true);
  assert.ok(events.some(event => event.type === 'action-game:dodge'));
  const displacement = events.find(event => event.type === 'action-game:displacement')!.payload.delta as number[];
  assert.ok(Math.abs(displacement[0]! + 1) < 1e-6);
  assert.ok(Math.abs(displacement[2]!) < 1e-6);
  world.step(2);
  assert.equal(service.isInvulnerable('hero'), false);
  assert.equal((world.command({ type: 'action-game:inspect', actorId: 'hero' }) as any).health, 100);
  assert.equal(typedEvade, true);
  assert.ok(events.some(event => event.type === 'action-game:evade' && event.payload.targetId === 'hero'));
});

test('plugin validates action references and hit windows, and unregisters removed entities', t => {
  assert.throws(() => createActionGamePlugin({ actions: [{ id: 'one', duration: 1, cancelWindows: [{ start: 0.1, end: 0.2, actions: ['missing'] }] }] }), /unknown action/);
  assert.throws(() => createActionGamePlugin({ actions: [{ id: 'bad', duration: 1, invulnerability: [{ start: 0.5, end: 1.1 }] }] }), /bad.invulnerability/);
  const { world } = createWorld();
  t.after(() => world.dispose());
  world.remove('hero');
  assert.equal((world.services.get('action-game') as { get(id: string): unknown }).get('hero'), undefined);
  assert.throws(() => world.command({ type: 'action-game:input', actorId: 'hero', actionId: 'jab' }), /Unknown combatant/);
});

test('sub-step hit and cancel windows are observed, including an action that ends in the same tick', t => {
  const world = new World({ fixedDelta: 0.1 });
  t.after(() => world.dispose());
  world.spawn({ id: 'hero' });
  world.spawn({ id: 'foe', position: [0, 0, -0.5] });
  const events: string[] = [];
  world.events.on('action-game:hit', () => events.push('hit'));
  world.events.on('action-game:action-end', () => events.push('end'));
  world.install(createActionGamePlugin({
    combatants: [
      { actorId: 'hero', faction: 'blue', maxHealth: 100 },
      { actorId: 'foe', faction: 'red', maxHealth: 100 },
    ],
    actions: [
      { id: 'short', duration: 0.05, hitboxes: [{ window: { start: 0.01, end: 0.04 }, radius: 1, damage: 10 }] },
      { id: 'wide', duration: 0.5, cancelWindows: [{ start: 0.05, end: 0.06, actions: ['follow-up'] }] },
      { id: 'follow-up', duration: 0.2, hitboxes: [{ window: { start: 0.05, end: 0.06 }, radius: 1, damage: 10 }] },
    ],
  }));

  world.command({ type: 'action-game:input', actorId: 'hero', actionId: 'short' });
  world.step();
  assert.equal((world.command({ type: 'action-game:inspect', actorId: 'foe' }) as any).health, 90);
  assert.deepEqual(events, ['hit', 'end']);

  world.command({ type: 'action-game:input', actorId: 'hero', actionId: 'wide' });
  world.command({ type: 'action-game:input', actorId: 'hero', actionId: 'follow-up' });
  assert.equal((world.command({ type: 'action-game:inspect', actorId: 'hero' }) as any).bufferedInputs[0], 'follow-up');
  world.step();
  assert.equal((world.command({ type: 'action-game:inspect', actorId: 'hero' }) as any).activeAction.actionId, 'follow-up');
  world.step();
  assert.equal((world.command({ type: 'action-game:inspect', actorId: 'foe' }) as any).health, 80);
});

test('evades are in-range only and emitted once per attacker/action/target', t => {
  const world = new World({ fixedDelta: 0.1 });
  t.after(() => world.dispose());
  world.spawn({ id: 'attacker' });
  world.spawn({ id: 'near', position: [0, 0, -0.5] });
  world.spawn({ id: 'far', position: [0, 0, -20] });
  let nearEvades = 0;
  let farEvades = 0;
  world.events.on<{ targetId: string }>('action-game:evade', event => {
    if (event.targetId === 'near') nearEvades++;
    if (event.targetId === 'far') farEvades++;
  });
  world.install(createActionGamePlugin({
    combatants: [
      { actorId: 'attacker', faction: 'red', maxHealth: 100 },
      { actorId: 'near', faction: 'blue', maxHealth: 100 },
      { actorId: 'far', faction: 'blue', maxHealth: 100 },
    ],
    actions: [
      { id: 'sweep', duration: 0.3, hitboxes: [{ window: { start: 0, end: 0.3 }, radius: 1, damage: 10 }] },
      { id: 'dodge', duration: 0.3, kind: 'dodge', invulnerability: [{ start: 0, end: 0.3 }] },
    ],
  }));
  world.command({ type: 'action-game:input', actorId: 'attacker', actionId: 'sweep' });
  world.command({ type: 'action-game:input', actorId: 'near', actionId: 'dodge' });
  world.command({ type: 'action-game:input', actorId: 'far', actionId: 'dodge' });
  world.step(3);
  assert.equal(nearEvades, 1);
  assert.equal(farEvades, 0);
});

test('adjacent end-exclusive hit and invulnerability windows do not overlap', t => {
  const world = new World({ fixedDelta: 0.1 });
  t.after(() => world.dispose());
  world.spawn({ id: 'attacker' });
  world.spawn({ id: 'defender', position: [0, 0, -0.5] });
  let evadeCount = 0;
  world.events.on('action-game:evade', () => evadeCount++);
  world.install(createActionGamePlugin({
    combatants: [
      { actorId: 'attacker', faction: 'red', maxHealth: 100 },
      { actorId: 'defender', faction: 'blue', maxHealth: 100 },
    ],
    actions: [
      { id: 'strike', duration: 0.2, hitboxes: [{ window: { start: 0, end: 0.05 }, radius: 1, damage: 10 }] },
      { id: 'dodge', duration: 0.2, kind: 'dodge', invulnerability: [{ start: 0.05, end: 0.1 }] },
    ],
  }));
  world.command({ type: 'action-game:input', actorId: 'attacker', actionId: 'strike' });
  world.command({ type: 'action-game:input', actorId: 'defender', actionId: 'dodge' });
  world.step();
  assert.equal((world.command({ type: 'action-game:inspect', actorId: 'defender' }) as any).health, 90);
  assert.equal(evadeCount, 0);
});

test('invulnerability beginning exactly at the current fixed-step boundary protects the hit', t => {
  const world = new World({ fixedDelta: 0.1 });
  t.after(() => world.dispose());
  world.spawn({ id: 'attacker' });
  world.spawn({ id: 'defender', position: [0, 0, -0.5] });
  let evadeCount = 0;
  world.events.on('action-game:evade', () => evadeCount++);
  world.install(createActionGamePlugin({
    combatants: [
      { actorId: 'attacker', faction: 'red', maxHealth: 100 },
      { actorId: 'defender', faction: 'blue', maxHealth: 100 },
    ],
    actions: [
      { id: 'strike', duration: 0.3, hitboxes: [{ window: { start: 0.1, end: 0.2 }, radius: 1, damage: 10 }] },
      { id: 'dodge', duration: 0.3, kind: 'dodge', invulnerability: [{ start: 0.1, end: 0.2 }] },
    ],
  }));
  world.command({ type: 'action-game:input', actorId: 'attacker', actionId: 'strike' });
  world.command({ type: 'action-game:input', actorId: 'defender', actionId: 'dodge' });
  world.step();
  assert.equal((world.command({ type: 'action-game:inspect', actorId: 'defender' }) as any).health, 100);
  assert.equal(evadeCount, 1);
});

test('a buffered cancel is applied at the tick boundary after that tick action output', t => {
  const world = new World({ fixedDelta: 0.1 });
  t.after(() => world.dispose());
  world.spawn({ id: 'hero' });
  world.spawn({ id: 'foe', position: [0, 0, -0.5] });
  const events: string[] = [];
  world.events.on('action-game:hit', () => events.push('hit'));
  world.events.on('action-game:effect', () => events.push('effect'));
  world.events.on('action-game:action-cancel', () => events.push('cancel'));
  world.events.on<{ actionId: string }>('action-game:action-start', event => { if (event.actionId === 'follow-up') events.push('follow-up'); });
  world.install(createActionGamePlugin({
    combatants: [
      { actorId: 'hero', faction: 'blue', maxHealth: 100 },
      { actorId: 'foe', faction: 'red', maxHealth: 100 },
    ],
    actions: [
      { id: 'swing', duration: 0.5, cancelWindows: [{ start: 0.02, end: 0.04, actions: ['follow-up'] }], hitboxes: [{ window: { start: 0.01, end: 0.02 }, radius: 1, damage: 10 }], cues: [{ at: 0.08, kind: 'effect', name: 'trail' }] },
      { id: 'follow-up', duration: 0.2 },
    ],
  }));
  world.command({ type: 'action-game:input', actorId: 'hero', actionId: 'swing' });
  world.command({ type: 'action-game:input', actorId: 'hero', actionId: 'follow-up' });
  world.step();
  assert.equal((world.command({ type: 'action-game:inspect', actorId: 'foe' }) as any).health, 90);
  assert.ok(events.includes('effect'));
  assert.ok(events.indexOf('cancel') > events.indexOf('hit'));
  assert.ok(events.indexOf('follow-up') > events.indexOf('cancel'));
});

test('inputs triggered from a cancel listener are buffered without replacing the requested action', t => {
  const { world, events } = createWorld();
  t.after(() => world.dispose());
  const service = world.services.get('action-game') as ActionGameService;
  let nestedStatus: string | undefined;
  const off = service.on('action-game:action-cancel', event => {
    if (event.actorId === 'hero' && event.reason === 'cancel-window') nestedStatus = service.input('hero', 'jab').status;
  });
  t.after(off);
  service.input('hero', 'jab');
  world.step();
  service.input('hero', 'heavy');
  world.step(2);
  const hero = service.get('hero')!;
  assert.equal(nestedStatus, 'buffered');
  assert.equal(hero.activeAction?.actionId, 'heavy');
  assert.deepEqual(hero.bufferedInputs, ['jab']);
  assert.equal(hero.resource, 75);
  assert.ok(events.filter(event => event.type === 'action-game:action-start' && event.payload.actionId === 'heavy').length === 1);
});

test('cancel listeners cannot partially fund a skill by changing resource after the affordability check', t => {
  const { world } = createWorld();
  t.after(() => world.dispose());
  world.command({ type: 'action-game:resource', actorId: 'hero', amount: -75 });
  const service = world.services.get('action-game') as ActionGameService;
  let callbackResourceEvent: any;
  world.events.on<any>('action-game:resource', event => {
    if (event.delta === -5) callbackResourceEvent = event;
  });
  const off = service.on('action-game:action-cancel', event => {
    if (event.actorId === 'hero' && event.reason === 'cancel-window') service.adjustResource('hero', -5);
  });
  t.after(off);
  service.input('hero', 'jab');
  world.step();
  service.input('hero', 'heavy');
  world.step(2);
  assert.equal(service.get('hero')?.activeAction, undefined);
  assert.ok(service.get('hero')?.bufferedInputs.includes('heavy'));
  assert.equal(callbackResourceEvent.previous, 25);
  assert.equal(callbackResourceEvent.value, 20);
  assert.equal(callbackResourceEvent.delta, -5);
});

test('a cancel listener that unregisters the combatant prevents the pending action start', t => {
  const { world, events } = createWorld();
  t.after(() => world.dispose());
  const service = world.services.get('action-game') as ActionGameService;
  const off = service.on('action-game:action-cancel', event => {
    if (event.actorId === 'hero' && event.reason === 'cancel-window') service.unregisterCombatant('hero');
  });
  t.after(off);
  service.input('hero', 'jab');
  world.step();
  service.input('hero', 'heavy');
  world.step(2);
  assert.equal(service.get('hero'), undefined);
  assert.equal(events.some(event => event.type === 'action-game:action-start' && event.payload.actionId === 'heavy'), false);
});

test('an action cancelled by a hit listener cannot continue hitting later targets', t => {
  const world = new World({ fixedDelta: 0.1 });
  t.after(() => world.dispose());
  world.spawn({ id: 'a-attacker' });
  world.spawn({ id: 'b-first', position: [0, 0, -0.5] });
  world.spawn({ id: 'c-second', position: [0, 0, -0.5] });
  world.spawn({ id: 'd-dummy' });
  let chained = false;
  world.install(createActionGamePlugin({
    combatants: [
      { actorId: 'a-attacker', faction: 'red', maxHealth: 100 },
      { actorId: 'b-first', faction: 'blue', maxHealth: 100 },
      { actorId: 'c-second', faction: 'blue', maxHealth: 100 },
      { actorId: 'd-dummy', faction: 'red', maxHealth: 100 },
    ],
    actions: [
      { id: 'strike', duration: 0.5, cancelWindows: [{ start: 0.1, end: 0.3, actions: ['follow'] }], hitboxes: [{ window: { start: 0, end: 0.3 }, radius: 1, damage: 10 }] },
      { id: 'follow', duration: 0.2 },
    ],
  }));
  const service = world.services.get('action-game') as ActionGameService;
  const off = service.on('action-game:hit', event => {
    if (event.sourceId === 'a-attacker' && !chained) {
      chained = true;
      service.input('a-attacker', 'follow');
    }
  });
  t.after(off);
  service.input('a-attacker', 'strike');
  world.step();
  assert.equal((service.get('b-first') as any).health, 90);
  assert.equal((service.get('c-second') as any).health, 100);
  assert.equal(service.get('a-attacker')?.activeAction?.actionId, 'follow');
});

test('action-end is emitted before a follow-up starts from the final-tick hit listener', t => {
  const world = new World({ fixedDelta: 0.1 });
  t.after(() => world.dispose());
  world.spawn({ id: 'attacker' });
  world.spawn({ id: 'target', position: [0, 0, -0.5] });
  const order: string[] = [];
  world.events.on('action-game:action-end', () => order.push('end'));
  world.events.on<any>('action-game:action-start', event => { if (event.actionId === 'follow') order.push('follow'); });
  world.install(createActionGamePlugin({
    combatants: [
      { actorId: 'attacker', faction: 'red', maxHealth: 100 },
      { actorId: 'target', faction: 'blue', maxHealth: 100 },
    ],
    actions: [
      { id: 'short', duration: 0.05, hitboxes: [{ window: { start: 0.01, end: 0.04 }, radius: 1, damage: 10 }] },
      { id: 'follow', duration: 0.2 },
    ],
  }));
  const service = world.services.get('action-game') as ActionGameService;
  const off = service.on('action-game:hit', event => {
    if (event.sourceId === 'attacker') service.input('attacker', 'follow');
  });
  t.after(off);
  service.input('attacker', 'short');
  world.step();
  assert.deepEqual(order, ['end', 'follow']);
  assert.equal(service.get('attacker')?.activeAction?.actionId, 'follow');
});

test('a throwing action-end listener does not leave the actor transition-locked', t => {
  const world = new World({ fixedDelta: 0.1 });
  t.after(() => world.dispose());
  world.spawn({ id: 'hero' });
  world.install(createActionGamePlugin({
    combatants: [{ actorId: 'hero', faction: 'blue', maxHealth: 100 }],
    actions: [{ id: 'short', duration: 0.05 }, { id: 'follow', duration: 0.2 }],
  }));
  const service = world.services.get('action-game') as ActionGameService;
  const off = world.events.on('action-game:action-end', () => { throw new Error('listener failed'); });
  service.input('hero', 'short');
  assert.throws(() => world.step(), /listener failed/);
  off();
  assert.deepEqual(service.input('hero', 'follow'), { actorId: 'hero', actionId: 'follow', status: 'started' });
  assert.equal(service.get('hero')?.activeAction?.actionId, 'follow');
});

test('event listeners cannot mutate authored cue or displacement data', t => {
  const world = new World({ fixedDelta: 0.1 });
  t.after(() => world.dispose());
  world.spawn({ id: 'hero' });
  world.spawn({ id: 'foe', position: [0, 0, -10] });
  const effects: any[] = [];
  const displacements: any[] = [];
  world.events.on<any>('action-game:effect', event => {
    effects.push(event.payload);
    if (effects.length === 1) event.payload.power = 999;
  });
  world.events.on<any>('action-game:displacement', event => {
    displacements.push(event);
    if (displacements.length === 1) {
      event.localDelta[0] = 999;
      event.delta[0] = 999;
    }
  });
  world.install(createActionGamePlugin({
    combatants: [
      { actorId: 'hero', faction: 'blue', maxHealth: 100 },
      { actorId: 'foe', faction: 'red', maxHealth: 100 },
    ],
    actions: [{
      id: 'dash', duration: 0.2, displacements: [{ at: 0.1, delta: [1, 0, 0], duration: 0.1 }],
      cues: [{ at: 0.1, kind: 'effect', name: 'flash', payload: { power: 2 } }],
    }],
  }));
  for (let i = 0; i < 2; i++) {
    world.command({ type: 'action-game:input', actorId: 'hero', actionId: 'dash' });
    world.step(2);
  }
  assert.equal(effects[1].power, 2);
  assert.equal(displacements[1].localDelta[0], 1);
  assert.equal(displacements[1].delta[0], 1);
});

test('headless example composes a buffered combo without browser APIs', async () => {
  const result = await runHeadlessCombo();
  assert.equal(result.worldTick, 40);
  assert.equal(result.enemyHealth, 62);
  assert.equal(result.playerHealth, 100);
  assert.ok(result.events.includes('action-game:camera'));
  assert.ok(result.events.includes('action-game:sound'));
});

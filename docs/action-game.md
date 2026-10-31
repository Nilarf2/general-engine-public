# Action Game Plugin · 动作游戏插件

`@general-engine/engine/action-game` adds a deterministic, renderer-independent action layer to the fixed-step `World`. It is intended as a reusable foundation for 3D action games: an application owns models, animation, camera implementation, audio and presentation, while the plugin owns timing and combat decisions.

`@general-engine/engine/action-game` 为固定步长 `World` 增加确定性的、与渲染器无关的动作层。它适合作为 3D 动作游戏的可复用基础：应用负责模型、动画、相机实现、音频和表现，插件负责时序与战斗判定。

## Install and compose · 安装与组合

```ts
import { World } from '@general-engine/engine';
import { createActionGamePlugin } from '@general-engine/engine/action-game';

const world = new World({ fixedDelta: 1 / 60 });
world.spawn({ id: 'player', position: [0, 0, 0], rotation: [0, 0, 0, 1] });
world.spawn({ id: 'enemy', position: [0, 0, -1] });
world.install(createActionGamePlugin({
  actions: [{
    id: 'slash', duration: 0.35,
    hitboxes: [{ window: { start: 0.1, end: 0.2 }, offset: [0, 0, -0.4], radius: 0.5, damage: 20 }],
    cues: [{ at: 0.1, kind: 'effect', name: 'slash-trail' }],
  }],
  combatants: [
    { actorId: 'player', faction: 'hero', maxHealth: 100 },
    { actorId: 'enemy', faction: 'enemy', maxHealth: 50 },
  ],
}));
world.command({ type: 'action-game:input', actorId: 'player', actionId: 'slash' });
world.step(30);
```

The plugin also installs `action-game:input`, `action-game:register`, `action-game:unregister`, `action-game:resource` and `action-game:inspect` commands. Those commands can be called through `createWorldCompositionModule` so a composition graph can schedule input and steps. The packaged [headless composition example](../examples/action-game/headless-combo.mjs) runs directly with Node after installation.

插件同时注册 `action-game:input`、`action-game:register`、`action-game:unregister`、`action-game:resource` 和 `action-game:inspect` 命令。这些命令可以通过 `createWorldCompositionModule` 调用，使组合图能够调度输入和步进。随包提供的[无头组合示例](../examples/action-game/headless-combo.mjs)安装后可直接用 Node 运行。

## Data-driven timing · 数据驱动时序

An action has a duration, optional cooldown/resource cost, cancel windows, invulnerability windows, spherical hitboxes, and presentation cues. Inputs that cannot start immediately are retained for `inputBufferSeconds` and are retried in actor ID order after each fixed step. A successful hit is applied once per target per action. Factions prevent friendly fire. Defeated actors cannot start new actions and have their active action and buffer cleared.

动作定义包括持续时间、可选冷却/资源消耗、取消窗口、无敌窗口、球形命中体和表现提示。不能立即开始的输入会保留 `inputBufferSeconds`，并在每个固定步之后按角色 ID 顺序重试。一次动作对同一目标只造成一次成功命中；阵营阻止友军伤害。倒地角色不能开始新动作，当前动作和输入缓冲会清空。

Three-dimensional hit testing uses the actor entity position plus a quaternion-rotated local sphere offset. The target uses a spherical hurt radius. This is a deterministic narrow-phase query, not a replacement for Rapier body collision or a navigation system.

三维命中检测使用角色实体位置加四元数旋转后的局部球形偏移，目标使用球形受击半径。这是确定性的窄相位查询，不替代 Rapier 刚体碰撞或导航系统。

## Events and adapters · 事件与适配器

The plugin emits `action-game:action-start`, `action-game:action-cancel`, `action-game:action-end`, `action-game:hit`, `action-game:damage`, `action-game:evade`, `action-game:defeat`, `action-game:resource`, `action-game:dodge`, `action-game:displacement`, `action-game:effect`, `action-game:sound`, `action-game:camera`, `action-game:input-buffered` and `action-game:input-expired`. `effect`, `sound`, and `camera` payloads are intent records; hosts decide how to instantiate VFX, play audio, shake or blend the camera, and drive animation. Displacement is also an intent record so a character motor can apply it through its own movement/physics contract. The `ActionGameService.on()` helper provides typed listeners for these events.

插件会发出 `action-game:action-start`、`action-game:action-cancel`、`action-game:action-end`、`action-game:hit`、`action-game:damage`、`action-game:evade`、`action-game:defeat`、`action-game:resource`、`action-game:dodge`、`action-game:displacement`、`action-game:effect`、`action-game:sound`、`action-game:camera`、`action-game:input-buffered` 和 `action-game:input-expired`。`effect`、`sound`、`camera` 负载是意图记录；宿主决定如何创建特效、播放声音、执行相机震动/混合并驱动动画。位移同样是意图记录，由角色移动器通过自身的移动/物理合同应用。`ActionGameService.on()` 提供这些事件的类型化监听。

## Boundaries · 边界

The plugin does not own animation graphs, renderer objects, physics bodies, pathfinding, networking, persistence, or a character motor. Hitboxes are spheres for a small, predictable CPU core. Applications that need capsules, swept volumes, terrain obstruction, rollback netcode, or animation marker synchronization should add an adapter or a specialized plugin and keep the action service as the timing/event authority.

插件不拥有动画图、渲染对象、物理刚体、寻路、网络、存档或角色移动器。命中体使用球形以保持 CPU 核心小而可预测。需要胶囊体、扫掠体积、地形阻挡、回滚网络或动画标记同步的应用，应增加适配器或专用插件，并让动作服务继续作为时序/事件权威。

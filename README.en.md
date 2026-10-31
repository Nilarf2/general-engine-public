<p align="right"><a href="README.md">中文</a></p>

# General Engine

**A modular TypeScript engine for reusable browser game applications.** General Engine separates deterministic simulation, application lifecycle, scene transitions, physics, asset loading, narrative workflows, module composition and graphics into explicit capabilities. Applications opt into the modules they need while retaining ownership of their rules, UI, input, content and platform integration.

[Quick start](#quick-start) · [Capabilities](#capabilities) · [Architecture boundaries](#architecture-boundaries) · [Documentation](#documentation) · [License](#license-and-attribution)

## What this project is

General Engine is intended for developers building browser-based 3D games or integrating reusable lifecycle and tooling modules into an existing Three.js application. It provides independently importable CPU simulation, a native-scene application host, WebGPU/WebGL views, optional Rapier physics, asset and actor utilities, deterministic narrative workflows, spatial queries, an action-game plugin and a declarative composition runtime.

The engine does not require every game to use one architecture. A new project can use the fixed-step World and browser facade; an existing application can retain its own Scene, Camera, renderer, postprocessing and game state while using the application host for scene transitions and resource disposal. Simulation, validation, narrative and composition workflows remain testable in Node.js without a graphics adapter.

The current version is **0.3.0-alpha.0**. It is experimental: use the interfaces for prototypes and evaluation, then validate each game against its target browsers, devices, performance budget, save compatibility and deployment platform. Tests and hardware records cover only the scope stated in their documents and do not constitute platform certification for a game or device.

## Quick start

Node.js 22.12 or newer is required.

```sh
git clone https://github.com/Nilarf2/general-engine-public.git
cd general-engine-public
npm ci
npm test
npm run build
```

Generate an independent starter application:

```sh
npm run create-game -- ../my-game
cd ../my-game
npm install
npm run validate
npm run simulate
npm run dev
```

The generator packages the current engine into `vendor/engine.tgz` and supplies a demo scene, player movement, camera, build configuration and license notices. The generated game can be installed, built and moved independently. The generator never overwrites a non-empty destination and does not choose a game's story, UI or publishing platform.

The smallest declarative entry point looks like this:

```ts
import { createGame } from '@general-engine/engine/browser';
import { validateScene } from '@general-engine/engine';

const game = await createGame({
  canvas: document.querySelector('canvas')!,
  scene: validateScene(sceneJson),
  mode: 'pathtrace',
  physics: true,
  trace: { backend: 'quality', width: 640, height: 360, maxBounces: 8 },
});
```

For an existing Three.js game, use `createApplication()` to manage loading, restoration, asynchronous transitions, update clocks and cleanup while the application continues to own its shared renderer, UI and input.

## Capabilities

| Module | Scope |
| --- | --- |
| Core / World | GPU-free fixed-step simulation, entities, validation, commands, events, plugins and resource lifetimes. Deterministic behavior is suitable for Node.js tests. |
| Application | Loading, restoration, latest-request-wins asynchronous transitions, seconds-based updates, and orderly disposal for an application's existing scenes and shared services. |
| Browser | `createGame()` facade connecting the World, fixed-step loop, optional physics, rendering views, resizing and teardown. |
| Composition | Versioned manifests, dependency/capability registration, conditional/event/parallel graphs, deterministic routing, conflict detection, transactional state and an effect outbox. |
| Agent tools | Content-addressed catalogs, bounded JSON contracts, explicit permissions, revision checks, byte limits and an offline gateway. Handlers are trusted host functions. |
| Narrative | JSON validation and compilation, deterministic sessions, save migrations, storage adapters, route replay and static story-map export. |
| Action game | Renderer-independent fixed-step action layer with action windows, input buffering, cancels, resources, cooldowns, deterministic spherical hits, invulnerability and presentation events. |
| Physics | Optional Rapier rigid bodies, collisions and character movement. Games still connect physics to their own input and gameplay rules. |
| Assets | Shared loading and cancellation, resource ownership, GLB/Meshopt processing and actor-instance helpers. |
| Spatial | CPU broad-phase queries for rotated rectangles; it is not a navigation system or a replacement for application collision rules. |
| Rendering | Three.js WebGPU/WebGL2 raster views, a WebGPU path-tracing adapter and a compact reference tracer. Each backend has its own material and dynamic-geometry limits. |

Import the core from `@general-engine/engine`; browser, application, physics, assets, narrative, spatial, composition, action-game, raster and tracing capabilities are exposed through separate package entries. See [Architecture](docs/ARCHITECTURE.md) and `package.json` for the complete export map.

## Architecture boundaries

- **The application owns game rules.** Levels, quests, character values, UI, controllers, platform SDKs, commercial logic and story content belong in the independent game project.
- **The core stays testable.** The fixed-step World does not depend on the DOM or GPU; a host application can provide its own scenes, renderer and clock.
- **Capabilities are explicit.** Optional modules connect through interfaces and lifetimes; composition graphs describe dependencies, conditions, events, parallel branches and transactional data rather than implicitly loading code.
- **Permissions are host-granted.** The Agent gateway calls only host-registered handlers and does not grant ambient filesystem, network, GPU or credential access. It is a tool-contract layer, not a process sandbox for untrusted JavaScript.
- **Ownership is explicit.** Views that borrow application resources do not dispose the shared renderer, source assets or device behind the application's back; dependent resources are released after asynchronous cleanup finishes.
- **Performance claims have scope.** Functional checks, software adapters and measurements on one device do not replace acceptance on the target hardware. The path tracers do not claim a standard hardware RT-core API.

## Rendering and devices

Raster mode uses the Three.js WebGPU renderer and can explicitly select a WebGL2 compatibility backend. The quality path-tracing adapter bridges Three.js scenes, materials, textures, lights and HDR environments; the compact reference tracer targets a smaller constant-material and static-geometry subset. WebGPU normally requires HTTPS or a `localhost` secure context.

Path tracing does not automatically solve every application conversion: custom shaders, continuous deformation, dynamic geometry and special materials require explicit application synchronization or conversion. Optional OIDN static-image refinement uses separately distributed weights with an Apache-2.0 license. Follow the asset manifest and notices, and validate on the target device before claiming support.

## Documentation

- [Development guide](docs/DEVELOPMENT.md): independent games, scenes, assets and rendering workflow.
- [Application contract](docs/APPLICATION.md): native scenes, clocks, transitions, cancellation, ownership and save compatibility.
- [Architecture](docs/ARCHITECTURE.md): modules, exports, resource ownership and rendering structure.
- [Composition core](docs/composition-core.md): graphs, parallel transactions, conflicts and effect boundaries.
- [Agent workflow](docs/agent/README.md): catalog format, permissions, offline contracts and limits.
- [Narrative workflow](docs/narrative-workflow.md): JSON stories, compilation, route checks and save migrations.
- [Action-game plugin](docs/action-game.md): action contracts, timing windows and host presentation responsibilities.
- [Blender asset workflow](docs/BLENDER.md): GLB export, loading, materials and ownership.
- [API and scene schema](docs/scene.schema.json): scene data structure.
- [Release notes](docs/RELEASE_NOTES.md): current and historical changes.
- [Validation record](docs/VALIDATION.md): checks performed, scope and known limits.
- [License and attribution](NOTICE.md): engine, reused code, dependencies and asset notices.

## Verification

```sh
npm test
npm run test:agent
npm run test:narrative-tools
npm run build
npm run test:action-game-example
npm run check:consumer
```

`npm run check` combines the regular tests and build. Browser rendering checks require a browser and graphics adapter; hardware checks should be run independently on the target machine using [the hardware procedure](docs/HARDWARE_VALIDATION.md). Historical records apply only to the commits and scenes stated in them.

## License and attribution

General Engine is released under the MIT license. Dependency notices, OIDN weight licensing and reused-asset provenance are listed in [LICENSE](LICENSE), [NOTICE.md](NOTICE.md) and `public/licenses/`. Preserve the applicable copyright and license files when redistributing.

The engine does not automatically collect or upload game content, levels, player data or application assets. Deployment and data-handling behavior belongs to the application using the engine.

# 0.3.0-alpha.0 experimental alpha · 实验性版本

This checkpoint turns the inherited browser engine into an Agent-native modular foundation. It adds a versioned composition runtime for dependency, condition, event, dataflow and parallel-branch orchestration; transaction rollback and conflict detection; an explicit Agent catalog/tool gateway; an AVG runtime with save migrations and browser adapters; offline route and story-map tools; a World bridge; and a unified offline check command. Harbor-derived rendering and application capabilities retain their existing package boundaries and provenance.

The alpha also includes `@general-engine/engine/action-game`, a CPU/Node-compatible 3D action plugin with data-driven action windows, buffered cancels, cooldown/resource checks, deterministic spherical hit queries, dodge invulnerability, displacement intents and camera/effect/sound events. A composition-driven headless combo and focused tests cover its public contract. It is a reusable gameplay layer, not a complete renderer, character motor, animation system or network solution.

本阶段在继承的浏览器引擎基础上建立面向 Agent 的模块化底座，加入版本化组合运行时、条件/事件/数据流/并行分支、事务回滚与冲突检测、显式 Agent 工具目录与权限网关、AVG 运行时与存档迁移、离线路线/剧情地图工具和 World 桥接，并把核心检查纳入统一命令。继承的渲染与应用能力保留原有包边界和来源记录。

本阶段还加入 `@general-engine/engine/action-game`：兼容 CPU/Node 的 3D 动作插件，提供数据驱动动作窗口、连段输入缓冲、冷却/资源检查、确定性球形命中、闪避无敌、位移意图及相机/特效/声音事件。组合驱动的无头连段示例与聚焦测试覆盖公共合同。它是可复用玩法层，不是完整渲染器、角色移动器、动画系统或网络方案。

This is an experimental engine alpha, not a completed game-development release. It does not include game-specific story content, a visual story editor, platform certification, a browser game consumer or media publishing automation.

- `@general-engine/engine/composition`: conditional/event/parallel composition with versioned modules, capability ownership, conflict-aware state and explicit World adapter.
- `@general-engine/engine/narrative`: validated JSON content, deterministic transactional sessions, versioned snapshots, migration hooks, save stores and browser adapters.
- Agent tool catalog and offline gateway require exact permission grants and bounded JSON data.
- Narrative authoring commands validate/inspect/compile JSON, replay expected routes and export static JSON/Mermaid graph analysis.
- Generic composition and narrative examples are included without game-specific source content.
- Verification: 130 engine tests, 6 Agent tests, 3 narrative graph-tool tests, typecheck, engine/browser build, package consumer install, scene simulation and package export checks. Hardware evidence remains limited to historical inherited records and does not certify the new paths.

# 0.2.0 experimental alpha · 实验性版本

新增原生场景应用宿主，已有游戏可保留 Three.js Scene、Camera、TSL 材质、后处理与碰撞规则。应用和引擎通过公开包集成，无需跨仓库导入源码。游戏内容与平台发布属于应用。

The native-scene application host lets existing games retain their Three.js scenes, cameras, TSL materials, postprocessing and collision rules. Applications integrate through the public package without cross-repository source imports. Game content and platform publishing stay in the application.

- `@general-engine/engine/application`：`createApplication`、`SceneManager`、`FrameLoop` 与类型；以秒更新、RAF 最大步长、恢复不补墙钟。`createGame()` 的固定 tick 行为保留。 / Native-scene host, latest-load-wins transitions, seconds-based updates and visibility clock resets; existing fixed-tick behavior is preserved.
- 候选场景 load/restore/enter 失败时旧场景保持活动；取消信号立即可见，晚到候选等待 GPU/view 释放后再清理资产；根释放等待 pending 和共享服务。 / Preparation/activation failures retain the active scene; cancellation is immediate and late candidate views drain before deferred assets; root disposal awaits pending loads and services.
- Scope 新增 `signal`、`defer`、`listen`，保留逆序一次性清理；原始 `SaveStore<T>` 保留旧 key/JSON schema，存储权限失败切换内存。 / Scope gains cancellation/listeners without changing reverse cleanup; raw saves retain exact keys/schemas with truthful memory fallback.
- `@general-engine/engine/narrative` 与 `@general-engine/engine/spatial`：稳定剧情检查点和旋转矩形空间粗筛；物理精筛仍归游戏。 / Stable story checkpoints and rotated-rectangle broad phase; exact game collision remains application-owned.
- 原生借用视图默认逐帧以有限 megakernel tile 完成完整分辨率样本，保留应用 renderer/device 与来源资产；场景 revision 取消陈旧细化，同源 OIDN large FP32 提供静帧降噪。 / Borrowed native views complete a full-resolution sample through bounded tiles, retain application resources, invalidate stale refinement and support same-origin OIDN large FP32.
- 公共 README、应用合同与协作说明提供中英双语。 / Public README, application contract and contributor guidance provide Chinese and English.

核心新增 16 项行为测试已通过，覆盖切场景竞态、回滚、异步释放、时钟、Scope、raw save 兼容、剧情与空间查询。新增原生视图的 GTX 1070 32 × 24 功能验收通过；它不代表完整城市帧率或高清降噪延迟。集成、硬件与发行产物的最终状态见 [VALIDATION.md](VALIDATION.md)。

Sixteen new core behavior tests pass, covering transition races, rollback, async disposal, clocks, Scope, raw save compatibility, story and spatial queries. The new native view passed its GTX 1070 32 × 24 functional fixture; this does not establish full-city FPS or HD denoising latency. See the validation record for final integration, hardware and release artifact status.

## v0.1.0-alpha · 历史版本 / Historical release

Harbor's first alpha establishes a reusable browser-game foundation that can be developed on a computer without a dedicated GPU. Game simulation runs separately from rendering; a new project receives its own engine package, scene, controls, camera, build configuration, and notices.

## Included

- Strict scene data, stable entity IDs, seeded randomness, fixed simulation ticks, commands, and scoped plugins.
- Optional Rapier rigid-body physics and a character controller with movement, stairs, gravity, and jumping.
- A default native WebGPU quality path-tracing adapter reusing `three-gpu-pathtracer`, with full Three scene access for textured assets, HDR lighting, physical materials, and camera controls.
- An explicit compact WGSL reference tracer and a separate Three WebGPU/WebGL2 raster view.
- Shared asset ownership, embedded GLB/Meshopt loading, skeletal actor instances, and portable game generation.
- Offline GLB inspection and lossless Meshopt optimization, with metadata preservation, validation, delivery-size reports, and no source overwrites.
- Browser storage fallback, static build/export tooling, English development documentation, and a CPU-oriented GitHub check/build workflow.

## Scope and evidence

This is an experimental alpha. Acceptance includes 58 Node tests, 49 lifecycle assertions, a complete extracted-demo browser run, and an independently generated game running both quality WebGPU tracing and WebGL2. Embedded textured Meshopt GLB loading, physical camera controls, resource ownership, responsive canvases, and shutdown with pending GPU reads were checked. Detailed scope is recorded in [VALIDATION.md](VALIDATION.md). Software graphics checks are not real-device performance measurements.

The quality renderer's upstream API is broader than Harbor's tested feature set. Its BVH preparation may block the CPU, moving content resets accumulation, and imported animated deformation requires explicit synchronization. Optional denoising/upscaling hooks do not include model weights or a validated denoising mode. The compact backend has narrower constant-material/static-conversion support, documented separately.

Bilibili Toy and VibeHub publishing/SDK integration, VRM/retargeting/IK, navigation, automatic LOD/streaming, KTX2 decoder packaging, and real desktop/mobile performance acceptance are not included in this alpha. No Tidewater visual or performance parity is claimed.

## Distribution

The release provides source, a static demo ZIP, a compiled engine tarball, and an external SHA-256 checksum file. The package manifest identifies `@general-engine/engine` version `0.1.0`; this release's alpha status is explicit in its tag and documentation. Blender-authored models enter through embedded GLB exports; the included guide covers materials, scale, loading, and separately declared gameplay colliders.

General Engine and the inherited Harbor source use MIT; reused packages and assets retain the notices listed in [NOTICE.md](../NOTICE.md).

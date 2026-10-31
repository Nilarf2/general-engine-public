<p align="right"><a href="README.en.md">English</a></p>

# General Engine 通用游戏引擎

**一套供独立游戏应用复用的 TypeScript 模块化引擎。** 它将确定性模拟、游戏循环、场景生命周期、物理、资源加载、叙事、模块组合和图形渲染拆成边界清晰的能力。应用按需组合这些能力，并继续拥有自己的规则、界面、输入、剧情内容和平台集成。

[快速开始](#快速开始) · [能力总览](#能力总览) · [架构边界](#架构边界) · [文档导航](#文档导航) · [许可](#许可与来源)

## 项目定位

General Engine 适合希望逐步构建浏览器 3D 游戏、或把已有 Three.js 游戏接入可复用生命周期与工具模块的开发者。它提供可以单独导入的 CPU 模拟、原生场景宿主、WebGPU/WebGL 视图、可选 Rapier 物理、资产与角色工具、确定性剧情流程、空间查询、动作游戏插件，以及声明式的模块组合运行时。

引擎不要求所有游戏采用同一种架构。新项目可以选择引擎提供的固定步长 World 和浏览器门面；既有应用也可以保留自己的 Scene、Camera、渲染器、后处理和游戏状态，并通过应用宿主接入场景切换与资源释放。没有图形适配器时，模拟、数据验证、剧情和组合流程仍可在 Node.js 中开发与测试。

当前版本为 **0.3.0-alpha.0**。这是实验性版本：核心接口和模块可用于试验与原型，但游戏项目仍应针对目标浏览器、设备、性能、存档兼容和部署平台完成自己的验收。现有测试与硬件记录只覆盖文档中列明的范围，不代表任何游戏或设备获得平台认证。

## 快速开始

需要 Node.js 22.12 或更新版本。

```sh
git clone https://github.com/Nilarf2/general-engine-public.git
cd general-engine-public
npm ci
npm test
npm run build
```

创建一个独立的最小游戏应用：

```sh
npm run create-game -- ../my-game
cd ../my-game
npm install
npm run validate
npm run simulate
npm run dev
```

生成器会将当前引擎打包进新应用的 `vendor/engine.tgz`，并提供演示场景、角色移动、相机、构建配置和许可说明。新游戏可以独立安装、构建和移动；生成器不会覆盖非空目标目录，也不会替应用选择故事、用户界面或发布平台。

最小的声明式游戏入口如下：

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

需要接入已有 Three.js 场景时，可使用 `createApplication()` 管理场景装载、恢复、切换、更新时钟和异步释放，而由应用继续控制共享渲染器、界面和输入。

## 能力总览

| 模块 | 功能与适用范围 |
| --- | --- |
| Core / World | 不依赖 GPU 的固定步长模拟、实体、验证、命令、事件、插件和资源生命周期。确定性行为便于 Node.js 测试。 |
| Application | 为应用已有的场景提供加载、恢复、最新请求优先的异步切换、以秒为单位的更新，以及等待场景与共享服务释放的生命周期。 |
| Browser | `createGame()` 浏览器门面，连接 World、游戏循环、可选物理、渲染视图、尺寸变化和清理。 |
| Composition | 版本化模块清单、依赖与能力注册、条件/事件/并行图、确定性路由、冲突检测、事务回滚与副作用 outbox。 |
| Agent tools | 内容寻址的模块目录、受限 JSON 合同、显式权限授权、修订校验、输入输出大小限制与离线调用网关。工具运行在宿主提供的受信任处理函数中。 |
| Narrative | JSON 剧情校验与编译、确定性会话、存档版本迁移、保存适配器、路线回放与静态剧情图导出。 |
| Action game | 与渲染无关的固定步长动作层，包括动作窗口、输入缓冲、取消窗口、资源与冷却、确定性球形命中、无敌时段和表现事件。 |
| Physics | 可选 Rapier 刚体、碰撞和角色移动。游戏仍负责将物理能力与自身输入和玩法规则连接。 |
| Assets | 共享加载与取消、资源所有权、GLB/Meshopt 处理和角色实例辅助能力。 |
| Spatial | 旋转矩形的 CPU 空间粗筛；它不是完整导航系统，也不替代应用的精确碰撞规则。 |
| Rendering | Three.js WebGPU/WebGL2 光栅视图、WebGPU 路径追踪适配器，以及小型参考追踪器。不同后端有不同材质和动态几何边界。 |

可从 `@general-engine/engine` 导入核心；浏览器、应用、物理、资产、叙事、空间、组合、动作游戏、光栅和追踪能力分别通过包导出入口导入。完整入口列表见 [包结构](docs/ARCHITECTURE.md) 和 `package.json`。

## 架构边界

- **游戏规则归应用所有。** 关卡、任务、角色数值、用户界面、控制器、平台 SDK、商业逻辑和故事内容都应放在独立游戏项目中。
- **核心保持可测试。** World 的固定步长模拟不依赖 DOM 或 GPU；宿主应用可用自己的场景、渲染器和时钟。
- **能力明确组合。** 可选模块通过接口和生命周期连接；组合图负责依赖、条件、事件、并行分支和事务化数据，而不是隐式加载代码。
- **权限由宿主授予。** Agent 工具网关只调用宿主注册的处理器，不自动赋予文件系统、网络、GPU 或凭据访问权。它是工具合同层，不是运行不受信任 JavaScript 的进程沙箱。
- **资源归属清楚。** 借用应用资源的视图不会擅自释放共享渲染器、原始资产或设备；异步清理完成后，应用再释放相关依赖。
- **性能声明有边界。** 功能测试、软件图形适配器和单一设备的测量不能替代目标硬件性能验收。路径追踪功能不意味着使用了标准硬件 RT-core API。

## 渲染与设备支持

光栅模式使用 Three.js WebGPU 渲染器，并可显式选择 WebGL2 兼容后端。高质量路径追踪适配器桥接 Three.js 场景、材质、贴图、灯光和 HDR 环境；紧凑参考追踪器面向较小的常量材质与静态几何子集。WebGPU 通常需要 HTTPS 或 `localhost` 安全上下文。

路径追踪并不会自动解决所有应用场景转换：自定义着色器、连续变形、动态几何和特殊材质需要应用明确同步或转换。可选的 OIDN 静态图像精修依赖单独分发的权重文件及其 Apache-2.0 许可，应用应遵照资源清单和许可证提供文件。请阅读对应渲染指南和验证记录，确认与目标设备相符后再声明支持。

## 文档导航

- [开发指南](docs/DEVELOPMENT.md)：创建独立游戏、场景、模型与渲染工作流。
- [应用宿主合同](docs/APPLICATION.md)：原生场景接入、时钟、切换、取消、所有权和存档兼容。
- [架构说明](docs/ARCHITECTURE.md)：模块、导出、资源管理与渲染结构。
- [组合核心](docs/composition-core.md)：图、并行事务、冲突和副作用边界。
- [Agent 工具工作流](docs/agent/README.md)：目录格式、权限合同、离线工具调用与局限。
- [剧情工作流](docs/narrative-workflow.md)：剧情 JSON、编译、路线检查和存档迁移。
- [动作游戏插件](docs/action-game.md)：动作合同、时序窗口和宿主表现职责。
- [Blender 资产流程](docs/BLENDER.md)：GLB 导出、加载、材质与资源所有权。
- [API 与场景 Schema](docs/scene.schema.json)：场景数据结构。
- [版本说明](docs/RELEASE_NOTES.md)：当前与历史版本的变更。
- [验证记录](docs/VALIDATION.md)：执行过的测试范围、结果和已知限制。
- [许可证与来源](NOTICE.md)：引擎、复用代码、依赖和资源的许可证与归属。

## 验证

```sh
npm test
npm run test:agent
npm run test:narrative-tools
npm run build
npm run test:action-game-example
npm run check:consumer
```

`npm run check` 汇总常规测试与构建。浏览器渲染测试还需要可用的浏览器和图形适配器；硬件测试应按照 [硬件验证流程](docs/HARDWARE_VALIDATION.md) 在目标机器单独运行。旧版本记录仅对其标明的提交和场景有效。

## 许可与来源

General Engine 使用 MIT 许可证。仓库中的依赖许可证、OIDN 权重许可证和复用资产来源分别列在 [LICENSE](LICENSE)、[NOTICE.md](NOTICE.md) 与 `public/licenses/`。重新分发时应保留相应版权声明与许可证文件。

游戏内容、关卡、玩家数据以及应用自身的素材不由本引擎自动收集或上传。部署与数据处理方式由使用引擎的应用负责。

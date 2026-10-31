# Validation and limits · 验证与边界

This document describes the reproducible checks maintained for the public repository. It is intentionally scoped to software behavior and documented test fixtures. It does not publish workstation identities, local paths, account information, hardware inventories, transfer archives, checksums, or private diagnostic logs.

本文档只记录公开仓库可以复现的软件检查、测试范围和已知边界，不发布工作站身份、本地路径、账号信息、硬件清单、传输包、校验值或私有诊断日志。

## Standard checks · 常规检查

Run the following from a clean checkout with Node.js 22.12 or newer:

```sh
npm ci
npm test
npm run test:agent
npm run test:narrative-tools
npm run build
npm run test:action-game-example
npm run check:consumer
```

The checks cover the deterministic simulation core, lifecycle and resource ownership, composition contracts, narrative tooling, action-game timing, package declarations, production bundling, and installation of an independent consumer outside the engine checkout. `npm run check` combines the primary test and build commands.

这些检查覆盖确定性模拟核心、应用生命周期与资源归属、组合合同、剧情工具、动作游戏时序、包声明、生产构建，以及在引擎目录之外安装独立消费者。`npm run check` 汇总主要测试和构建命令。

## Browser checks · 浏览器检查

`npm run test:browser` and `npm run test:render` exercise the browser-facing views when a compatible local browser and graphics adapter are available. They check canvas creation, resize and device-pixel-ratio handling, WebGL2/WebGPU fallback behavior, scene updates, sample progress, resource cleanup and error collection. These tests are functional checks for the included fixtures; they are not a benchmark or a browser certification matrix.

When WebGPU is unavailable, CPU-only simulation, validation, narrative compilation and composition workflows remain testable in Node.js. A browser test that succeeds on one adapter does not prove support for every browser, driver, operating system or device.

`npm run test:browser` 和 `npm run test:render` 在具备兼容浏览器及图形适配器时检查浏览器视图，包括画布创建、缩放与设备像素比、WebGL2/WebGPU 后端、场景更新、采样进度、资源清理和错误收集。它们是随仓库夹具的功能检查，不是性能基准，也不是浏览器兼容性认证。

没有 WebGPU 时，CPU 模拟、数据校验、剧情编译和组合流程仍可在 Node.js 中测试。某个适配器上的浏览器检查通过，不代表所有浏览器、驱动、操作系统或设备都受支持。

## Rendering and hardware procedure · 渲染与硬件流程

Use [HARDWARE_VALIDATION.md](HARDWARE_VALIDATION.md) for a target-device run. Record the browser and runtime versions, adapter class, canvas and internal resolution, scene complexity, material and texture features, bounce/sample budgets, elapsed time, device-loss behavior and collected errors. Keep the report tied to the exact source revision and test fixture.

Do not publish user names, account identifiers, home-directory paths, IP addresses, credentials, browser profiles, private network names or unrelated machine inventory. If a report needs to identify a device for an internal comparison, use a redacted label and keep the detailed record outside the public repository.

在目标设备上运行时，请参阅[硬件验证流程](HARDWARE_VALIDATION.md)，记录浏览器和运行时版本、适配器类别、画布与内部分辨率、场景复杂度、材质和纹理特性、反弹与采样预算、耗时、设备丢失行为及错误集合，并将报告绑定到明确的源代码版本和测试夹具。

公开报告不得包含用户名、账号标识、用户目录路径、IP 地址、凭据、浏览器配置目录、私有网络名称或无关的机器清单。若内部对比需要标记设备，请使用脱敏标签，详细记录留在公开仓库之外。

## Evidence policy · 证据规范

A validation result is meaningful only with its scope. Reports should state:

- the command or test entry point;
- the source revision and fixture used;
- whether the run used a software adapter or hardware adapter;
- the observed result and error count;
- known exclusions and follow-up work.

Do not turn a short fixture run into a general frame-rate, memory, thermal, mobile-support or platform-certification claim. Path tracing and WebGPU support also depend on application content, browser implementation, driver behavior and device limits.

验证结果必须带有适用范围。报告应说明：

- 执行的命令或测试入口；
- 使用的源代码版本和测试夹具；
- 使用软件适配器还是硬件适配器；
- 实测结果和错误数量；
- 已知未覆盖内容及后续工作。

不要把短时夹具测试包装成通用帧率、内存、温度、移动端支持或平台认证结论。路径追踪和 WebGPU 支持还取决于应用内容、浏览器实现、驱动行为及设备限制。

## Current public status · 当前公开状态

The repository contains automated checks and reproducible procedures, but it remains an experimental alpha release. Every application should run its own acceptance on its target browsers, devices, content scale, save format and deployment environment before public release.

本仓库提供自动化检查和可复现流程，但当前仍是实验性 alpha 版本。任何应用在公开发布前，都应针对自己的目标浏览器、设备、内容规模、存档格式和部署环境完成独立验收。

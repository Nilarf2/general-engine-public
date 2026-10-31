export * from './types.js';
export { createModuleRegistry, ModuleScope, createSetupContext } from './modules.js';
export type { ModuleRegistry, CapabilityMap } from './modules.js';
export { createCompositionRuntime, validateCompositionGraph } from './runtime.js';
export { createWorldCompositionModule } from './world.js';
export type { WorldCompositionModuleOptions, WorldCompositionOperation } from './world.js';

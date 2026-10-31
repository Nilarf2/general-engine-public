export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonSchema = { [key: string]: JsonValue };

export interface AgentModuleManifest {
  readonly id: string;
  readonly version: string;
  readonly apiVersion: 1;
  readonly requires: Readonly<Record<string, string>>;
  readonly provides: readonly string[];
}

export interface AgentModuleDescriptor {
  readonly manifest: AgentModuleManifest;
  readonly description: string;
  readonly tags: readonly string[];
  readonly permissions: readonly string[];
  readonly inputSchema: JsonSchema;
  readonly outputSchema: JsonSchema;
}

export interface AgentCatalog {
  readonly apiVersion: 1;
  readonly revision: string;
  readonly modules: readonly AgentModuleDescriptor[];
}

export interface AgentToolContext {
  readonly signal: AbortSignal;
  readonly revision: string;
  readonly moduleId: string;
}

export type AgentHandler = (input: JsonValue, context: AgentToolContext) => JsonValue | Promise<JsonValue>;
export type AgentHandlers = ReadonlyMap<string, AgentHandler> | Readonly<Record<string, AgentHandler>>;

export interface AgentGatewayOptions {
  readonly catalog: AgentCatalog;
  readonly handlers: AgentHandlers;
  readonly grantedPermissions?: readonly string[];
  readonly maxInputBytes?: number;
  readonly maxOutputBytes?: number;
  readonly maxCalls?: number;
}

export interface AgentToolGateway {
  readonly catalog: AgentCatalog;
  readonly tools: readonly AgentToolContract[];
  call(name: string, args: JsonValue, options?: { signal?: AbortSignal }): Promise<JsonValue>;
}

export interface AgentToolContract {
  readonly name: string;
  readonly description: string;
  readonly sideEffects: 'none' | 'module-defined';
  readonly inputSchema: JsonSchema;
  readonly outputSchema: JsonSchema;
}

export class AgentGatewayError extends Error {
  constructor(code: string, message: string, details?: unknown);
  readonly code: string;
  readonly details?: unknown;
}

export const TOOL_CONTRACTS: readonly AgentToolContract[];
export function createAgentCatalog(entries: readonly AgentModuleDescriptor[]): AgentCatalog;
export function validateAgentCatalog(value: unknown): AgentCatalog;
export function createAgentToolGateway(options: AgentGatewayOptions): AgentToolGateway;

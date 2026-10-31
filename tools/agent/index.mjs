import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const MAX_SCHEMA_DEPTH = 64;
const DEFAULT_MAX_INPUT_BYTES = 1_000_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1_000_000;
const DEFAULT_MAX_CALLS = 100;
const RESERVED_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const SCHEMA_ANNOTATIONS = new Set([
  '$schema', '$id', 'title', 'description', 'default', 'examples', 'deprecated', 'readOnly', 'writeOnly', 'comment'
]);
const SCHEMA_KEYWORDS = new Set([
  'type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const',
  'minLength', 'maxLength', 'pattern', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum',
  'minItems', 'maxItems', 'uniqueItems', 'minProperties', 'maxProperties', 'allOf', 'anyOf', 'oneOf'
]);

const contractPath = fileURLToPath(new URL('../../docs/agent/tool-contracts.json', import.meta.url));
export const TOOL_CONTRACTS = deepFreeze(JSON.parse(readFileSync(contractPath, 'utf8')));

export class AgentGatewayError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'AgentGatewayError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

/** Build a sorted immutable catalog and a stable SHA-256 revision for optimistic concurrency. */
export function createAgentCatalog(entries) {
  if (!Array.isArray(entries)) throw new AgentGatewayError('CATALOG_INVALID', 'Catalog modules must be an array');
  const ids = new Set();
  const modules = entries.map(validateModuleDescriptor).sort((left, right) => left.manifest.id.localeCompare(right.manifest.id));
  for (const module of modules) {
    const id = module.manifest.id;
    if (ids.has(id)) throw new AgentGatewayError('CATALOG_DUPLICATE', `Duplicate module ${id}`);
    ids.add(id);
  }
  const revision = createHash('sha256').update(stableStringify(modules)).digest('hex');
  return deepFreeze({ apiVersion: 1, revision, modules });
}

/** Validate a serialized catalog and verify its content revision before trusting it. */
export function validateAgentCatalog(value) {
  if (!isRecord(value) || value.apiVersion !== 1 || typeof value.revision !== 'string' || !Array.isArray(value.modules)) {
    throw new AgentGatewayError('CATALOG_INVALID', 'Catalog must contain apiVersion, revision and modules');
  }
  assertOnlyKeys(value, ['apiVersion', 'revision', 'modules'], 'catalog');
  const catalog = createAgentCatalog(value.modules);
  if (value.revision !== catalog.revision) {
    throw new AgentGatewayError('REVISION_MISMATCH', 'Catalog revision does not match its contents', {
      expectedRevision: value.revision,
      actualRevision: catalog.revision,
    });
  }
  return catalog;
}

/**
 * Create a host-side tool gateway. Handler code and permission grants must come from trusted host configuration.
 * No handler path or permission grant is accepted from tool-call arguments.
 */
export function createAgentToolGateway({
  catalog,
  handlers,
  grantedPermissions = [],
  maxInputBytes = DEFAULT_MAX_INPUT_BYTES,
  maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
  maxCalls = DEFAULT_MAX_CALLS,
} = {}) {
  const checkedCatalog = validateAgentCatalog(catalog);
  const handlerMap = normalizeHandlers(handlers);
  for (const module of checkedCatalog.modules) {
    if (!handlerMap.has(module.manifest.id)) {
      throw new AgentGatewayError('HANDLER_MISSING', `No trusted handler is registered for ${module.manifest.id}`);
    }
  }
  const permissions = normalizePermissions(grantedPermissions, 'grantedPermissions');
  assertLimit(maxInputBytes, 'maxInputBytes');
  assertLimit(maxOutputBytes, 'maxOutputBytes');
  assertLimit(maxCalls, 'maxCalls');
  const granted = new Set(permissions);
  let calls = 0;

  async function call(name, args, options = {}) {
    const contract = TOOL_CONTRACTS.find(tool => tool.name === name);
    if (!contract) throw new AgentGatewayError('TOOL_NOT_FOUND', `Unknown agent tool ${String(name)}`);
    const argumentIssues = validateValue(args, contract.inputSchema);
    if (argumentIssues.length) throw new AgentGatewayError('TOOL_ARGUMENTS_INVALID', 'Tool arguments do not match the tool schema', argumentIssues);
    const checkedArgs = cloneJson(args);
    const { revision } = checkedCatalog;

    if (name === 'engine.catalog.list') {
      checkOptionalRevision(checkedArgs.expectedRevision, revision);
      const query = checkedArgs.query?.toLocaleLowerCase();
      const modules = checkedCatalog.modules.filter(module => {
        if (checkedArgs.capability && !module.manifest.provides.includes(checkedArgs.capability)) return false;
        if (!query) return true;
        const searchable = [module.manifest.id, module.description, ...module.tags, ...module.manifest.provides].join(' ').toLocaleLowerCase();
        return searchable.includes(query);
      }).map(module => ({
        manifest: module.manifest,
        description: module.description,
        tags: module.tags,
        permissions: module.permissions,
      }));
      return checkedToolOutput(contract, { revision, modules });
    }

    if (name === 'engine.catalog.describe') {
      checkOptionalRevision(checkedArgs.expectedRevision, revision);
      const module = findModule(checkedCatalog, checkedArgs.moduleId);
      return checkedToolOutput(contract, { revision, module });
    }

    checkRequiredRevision(checkedArgs.revision, revision);
    const module = findModule(checkedCatalog, checkedArgs.moduleId);
    const missing = module.permissions.filter(permission => !granted.has(permission));
    if (missing.length) {
      throw new AgentGatewayError('PERMISSION_DENIED', `Host has not granted all permissions for ${module.manifest.id}`, {
        required: module.permissions,
        missing,
      });
    }
    if (options.signal?.aborted) throw new AgentGatewayError('CANCELLED', 'Invocation was cancelled before execution');
    assertByteLimit(checkedArgs.input, maxInputBytes, 'INPUT_LIMIT');
    const inputIssues = validateValue(checkedArgs.input, module.inputSchema);
    if (inputIssues.length) throw new AgentGatewayError('INPUT_INVALID', `Input does not match ${module.manifest.id} inputSchema`, inputIssues);
    if (calls >= maxCalls) throw new AgentGatewayError('CALL_LIMIT', `Gateway invocation limit of ${maxCalls} has been reached`);
    calls++;

    let output;
    try {
      output = await handlerMap.get(module.manifest.id)(cloneJson(checkedArgs.input), Object.freeze({
        signal: options.signal ?? new AbortController().signal,
        revision,
        moduleId: module.manifest.id,
      }));
    } catch (error) {
      if (error instanceof AgentGatewayError) throw error;
      throw new AgentGatewayError('MODULE_FAILED', `Module ${module.manifest.id} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (output === undefined) throw new AgentGatewayError('OUTPUT_INVALID', `Module ${module.manifest.id} returned undefined`);
    assertByteLimit(output, maxOutputBytes, 'OUTPUT_LIMIT');
    const outputIssues = validateValue(output, module.outputSchema);
    if (outputIssues.length) throw new AgentGatewayError('OUTPUT_INVALID', `Output does not match ${module.manifest.id} outputSchema`, outputIssues);
    return checkedToolOutput(contract, { revision, moduleId: module.manifest.id, output: cloneJson(output) });
  }

  return Object.freeze({
    catalog: checkedCatalog,
    tools: TOOL_CONTRACTS,
    call,
  });
}

function validateModuleDescriptor(value) {
  if (!isRecord(value) || !isRecord(value.manifest)) throw new AgentGatewayError('MODULE_INVALID', 'Module descriptor needs a manifest object');
  assertOnlyKeys(value, ['manifest', 'description', 'tags', 'permissions', 'inputSchema', 'outputSchema'], 'module descriptor');
  const manifest = value.manifest;
  assertOnlyKeys(manifest, ['id', 'version', 'apiVersion', 'requires', 'provides'], 'module manifest');
  assertIdentifier(manifest.id, 'manifest.id');
  if (typeof manifest.version !== 'string' || !manifest.version.trim()) throw new AgentGatewayError('MODULE_INVALID', `${manifest.id} needs a nonempty version`);
  if (manifest.apiVersion !== 1) throw new AgentGatewayError('MODULE_INVALID', `${manifest.id} uses unsupported apiVersion`);
  const requires = manifest.requires ?? {};
  if (!isRecord(requires)) throw new AgentGatewayError('MODULE_INVALID', `${manifest.id} requires must be a version map`);
  const normalizedRequires = {};
  for (const [id, version] of Object.entries(requires).sort(([a], [b]) => a.localeCompare(b))) {
    assertIdentifier(id, `${manifest.id}.requires key`);
    if (typeof version !== 'string' || !version.trim()) throw new AgentGatewayError('MODULE_INVALID', `Invalid dependency version ${manifest.id} -> ${id}`);
    normalizedRequires[id] = version;
  }
  const provides = manifest.provides ?? [];
  if (!Array.isArray(provides) || provides.some(value => typeof value !== 'string')) throw new AgentGatewayError('MODULE_INVALID', `${manifest.id} provides must be a string array`);
  for (const capability of provides) {
    if (!/^[a-z][a-z0-9-]*:[A-Za-z0-9_.-]+$/.test(capability) || !capability.startsWith(`${manifest.id}:`)) {
      throw new AgentGatewayError('MODULE_INVALID', `${manifest.id} has invalid or unowned capability ${capability}`);
    }
  }
  if (new Set(provides).size !== provides.length) throw new AgentGatewayError('MODULE_INVALID', `${manifest.id} has duplicate capabilities`);
  if (typeof value.description !== 'string' || !value.description.trim()) throw new AgentGatewayError('MODULE_INVALID', `${manifest.id} needs a description`);
  const tags = value.tags ?? [];
  if (!Array.isArray(tags) || tags.some(tag => typeof tag !== 'string' || !/^[a-z][a-z0-9-]*$/.test(tag))) throw new AgentGatewayError('MODULE_INVALID', `${manifest.id} tags must be lowercase identifiers`);
  if (new Set(tags).size !== tags.length) throw new AgentGatewayError('MODULE_INVALID', `${manifest.id} has duplicate tags`);
  const permissions = normalizePermissions(value.permissions, `${manifest.id}.permissions`);
  validateSchemaDefinition(value.inputSchema, `${manifest.id}.inputSchema`);
  validateSchemaDefinition(value.outputSchema, `${manifest.id}.outputSchema`);
  const normalized = {
    manifest: {
      id: manifest.id,
      version: manifest.version,
      apiVersion: 1,
      requires: normalizedRequires,
      provides: [...provides].sort(),
    },
    description: value.description,
    tags: [...tags].sort(),
    permissions,
    inputSchema: cloneJson(value.inputSchema),
    outputSchema: cloneJson(value.outputSchema),
  };
  return normalized;
}

function normalizeHandlers(handlers) {
  const entries = handlers instanceof Map ? [...handlers.entries()] : isRecord(handlers) ? Object.entries(handlers) : null;
  if (!entries) throw new AgentGatewayError('HANDLERS_INVALID', 'handlers must be a Map or plain object of trusted functions');
  const result = new Map();
  for (const [id, handler] of entries) {
    assertIdentifier(id, 'handler id');
    if (typeof handler !== 'function') throw new AgentGatewayError('HANDLERS_INVALID', `Handler ${id} must be a function`);
    if (result.has(id)) throw new AgentGatewayError('HANDLERS_INVALID', `Duplicate handler ${id}`);
    result.set(id, handler);
  }
  return result;
}

function normalizePermissions(value, label) {
  if (!Array.isArray(value)) throw new AgentGatewayError('PERMISSIONS_INVALID', `${label} must be an explicit array`);
  const copy = [...value];
  for (const permission of copy) {
    if (typeof permission !== 'string' || !/^[a-z][a-z0-9-]*(?::[A-Za-z0-9][A-Za-z0-9._/-]*)?$/.test(permission) || permission.includes('*')) {
      throw new AgentGatewayError('PERMISSIONS_INVALID', `${label} contains an invalid permission`);
    }
  }
  if (new Set(copy).size !== copy.length) throw new AgentGatewayError('PERMISSIONS_INVALID', `${label} contains duplicates`);
  return copy.sort();
}

function assertIdentifier(value, label) {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9-]*$/.test(value) || RESERVED_KEYS.has(value)) {
    throw new AgentGatewayError('IDENTIFIER_INVALID', `${label} must be a lowercase module identifier`);
  }
}

function validateSchemaDefinition(schema, label, depth = 0) {
  if (depth > MAX_SCHEMA_DEPTH || !isRecord(schema)) throw new AgentGatewayError('SCHEMA_INVALID', `${label} must be a JSON Schema object`);
  try { assertJson(schema); } catch (error) { throw new AgentGatewayError('SCHEMA_INVALID', `${label} must be JSON: ${error.message}`); }
  for (const keyword of Object.keys(schema)) {
    if (!SCHEMA_KEYWORDS.has(keyword) && !SCHEMA_ANNOTATIONS.has(keyword)) {
      throw new AgentGatewayError('SCHEMA_UNSUPPORTED', `${label} uses unsupported or external-reference keyword ${keyword}`);
    }
  }
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.length || types.some(type => !['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'].includes(type))) {
      throw new AgentGatewayError('SCHEMA_INVALID', `${label}.type is invalid`);
    }
    if (new Set(types).size !== types.length) throw new AgentGatewayError('SCHEMA_INVALID', `${label}.type contains duplicates`);
  }
  if (schema.properties !== undefined) {
    if (!isRecord(schema.properties)) throw new AgentGatewayError('SCHEMA_INVALID', `${label}.properties must be an object`);
    for (const [key, child] of Object.entries(schema.properties)) {
      if (RESERVED_KEYS.has(key)) throw new AgentGatewayError('SCHEMA_INVALID', `${label}.properties contains a reserved key`);
      validateSchemaDefinition(child, `${label}.properties.${key}`, depth + 1);
    }
  }
  if (schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.some(key => typeof key !== 'string') || new Set(schema.required).size !== schema.required.length)) {
    throw new AgentGatewayError('SCHEMA_INVALID', `${label}.required must contain unique strings`);
  }
  if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== 'boolean') {
    validateSchemaDefinition(schema.additionalProperties, `${label}.additionalProperties`, depth + 1);
  }
  if (schema.items !== undefined) validateSchemaDefinition(schema.items, `${label}.items`, depth + 1);
  for (const keyword of ['allOf', 'anyOf', 'oneOf']) {
    if (schema[keyword] !== undefined) {
      if (!Array.isArray(schema[keyword]) || !schema[keyword].length) throw new AgentGatewayError('SCHEMA_INVALID', `${label}.${keyword} must be a nonempty schema array`);
      schema[keyword].forEach((child, index) => validateSchemaDefinition(child, `${label}.${keyword}[${index}]`, depth + 1));
    }
  }
  if (schema.enum !== undefined && (!Array.isArray(schema.enum) || !schema.enum.length)) throw new AgentGatewayError('SCHEMA_INVALID', `${label}.enum must be a nonempty array`);
  if (schema.pattern !== undefined) {
    if (typeof schema.pattern !== 'string') throw new AgentGatewayError('SCHEMA_INVALID', `${label}.pattern must be a string`);
    try { new RegExp(schema.pattern, 'u'); } catch { throw new AgentGatewayError('SCHEMA_INVALID', `${label}.pattern is not a valid regular expression`); }
  }
  for (const keyword of ['minLength', 'maxLength', 'minItems', 'maxItems', 'minProperties', 'maxProperties']) {
    if (schema[keyword] !== undefined && (!Number.isSafeInteger(schema[keyword]) || schema[keyword] < 0)) throw new AgentGatewayError('SCHEMA_INVALID', `${label}.${keyword} must be a nonnegative integer`);
  }
  for (const keyword of ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum']) {
    if (schema[keyword] !== undefined && (typeof schema[keyword] !== 'number' || !Number.isFinite(schema[keyword]))) throw new AgentGatewayError('SCHEMA_INVALID', `${label}.${keyword} must be finite`);
  }
  if (schema.uniqueItems !== undefined && typeof schema.uniqueItems !== 'boolean') throw new AgentGatewayError('SCHEMA_INVALID', `${label}.uniqueItems must be boolean`);
}

function validateValue(value, schema, path = '$') {
  const issues = [];
  try { assertJson(value); } catch (error) { return [{ path, message: error.message }]; }
  visit(value, schema, path, issues);
  return issues;
}

function visit(value, schema, path, issues) {
  const schemaTypes = schema.type === undefined ? null : Array.isArray(schema.type) ? schema.type : [schema.type];
  if (schemaTypes && !schemaTypes.some(type => matchesType(value, type))) {
    issues.push({ path, message: `must be ${schemaTypes.join(' or ')}` });
    return;
  }
  if (schema.const !== undefined && !jsonEqual(value, schema.const)) issues.push({ path, message: 'must equal const' });
  if (schema.enum && !schema.enum.some(item => jsonEqual(value, item))) issues.push({ path, message: 'must match an enum value' });
  if (typeof value === 'string') {
    const length = [...value].length;
    if (schema.minLength !== undefined && length < schema.minLength) issues.push({ path, message: `must have at least ${schema.minLength} characters` });
    if (schema.maxLength !== undefined && length > schema.maxLength) issues.push({ path, message: `must have at most ${schema.maxLength} characters` });
    if (schema.pattern !== undefined && !new RegExp(schema.pattern, 'u').test(value)) issues.push({ path, message: 'must match pattern' });
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) issues.push({ path, message: `must be >= ${schema.minimum}` });
    if (schema.maximum !== undefined && value > schema.maximum) issues.push({ path, message: `must be <= ${schema.maximum}` });
    if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) issues.push({ path, message: `must be > ${schema.exclusiveMinimum}` });
    if (schema.exclusiveMaximum !== undefined && value >= schema.exclusiveMaximum) issues.push({ path, message: `must be < ${schema.exclusiveMaximum}` });
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) issues.push({ path, message: `must contain at least ${schema.minItems} items` });
    if (schema.maxItems !== undefined && value.length > schema.maxItems) issues.push({ path, message: `must contain at most ${schema.maxItems} items` });
    if (schema.uniqueItems && new Set(value.map(stableStringify)).size !== value.length) issues.push({ path, message: 'items must be unique' });
    if (schema.items) value.forEach((item, index) => visit(item, schema.items, `${path}/${index}`, issues));
  }
  if (isRecord(value)) {
    const keys = Object.keys(value);
    if (schema.minProperties !== undefined && keys.length < schema.minProperties) issues.push({ path, message: `must contain at least ${schema.minProperties} properties` });
    if (schema.maxProperties !== undefined && keys.length > schema.maxProperties) issues.push({ path, message: `must contain at most ${schema.maxProperties} properties` });
    for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) issues.push({ path: `${path}/${escapePointer(key)}`, message: 'is required' });
    for (const [key, child] of Object.entries(value)) {
      if (schema.properties && Object.hasOwn(schema.properties, key)) visit(child, schema.properties[key], `${path}/${escapePointer(key)}`, issues);
      else if (schema.additionalProperties === false) issues.push({ path: `${path}/${escapePointer(key)}`, message: 'is not allowed' });
      else if (isRecord(schema.additionalProperties)) visit(child, schema.additionalProperties, `${path}/${escapePointer(key)}`, issues);
    }
  }
  for (const child of schema.allOf ?? []) visit(value, child, path, issues);
  for (const keyword of ['anyOf', 'oneOf']) {
    const choices = schema[keyword];
    if (!choices) continue;
    const matches = choices.filter(child => validateValue(value, child, path).length === 0).length;
    if ((keyword === 'anyOf' && matches === 0) || (keyword === 'oneOf' && matches !== 1)) issues.push({ path, message: keyword === 'oneOf' ? 'must match exactly one schema' : 'must match at least one schema' });
  }
}

function matchesType(value, type) {
  switch (type) {
    case 'object': return isRecord(value);
    case 'array': return Array.isArray(value);
    case 'string': return typeof value === 'string';
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'integer': return Number.isSafeInteger(value);
    case 'boolean': return typeof value === 'boolean';
    case 'null': return value === null;
    default: return false;
  }
}

function findModule(catalog, id) {
  const module = catalog.modules.find(entry => entry.manifest.id === id);
  if (!module) throw new AgentGatewayError('MODULE_NOT_FOUND', `Unknown module ${String(id)}`);
  return module;
}

function checkedToolOutput(contract, output) {
  const issues = validateValue(output, contract.outputSchema);
  if (issues.length) throw new AgentGatewayError('TOOL_OUTPUT_INVALID', `Tool ${contract.name} produced an invalid response`, issues);
  return output;
}

function assertOnlyKeys(value, allowed, label) {
  const unexpected = Object.keys(value).filter(key => !allowed.includes(key));
  if (unexpected.length) throw new AgentGatewayError('CATALOG_INVALID', `${label} contains unsupported field ${unexpected[0]}`);
}

function checkOptionalRevision(actual, expected) {
  if (actual !== undefined) checkRequiredRevision(actual, expected);
}

function checkRequiredRevision(actual, expected) {
  if (actual !== expected) throw new AgentGatewayError('REVISION_MISMATCH', 'Tool call is based on a stale catalog revision', {
    expectedRevision: expected,
    receivedRevision: actual,
  });
}

function assertByteLimit(value, limit, code) {
  let json;
  try { json = JSON.stringify(value); } catch { throw new AgentGatewayError(code, 'Value must be JSON serializable'); }
  if (json === undefined) throw new AgentGatewayError(code, 'Value must be JSON serializable');
  if (Buffer.byteLength(json, 'utf8') > limit) throw new AgentGatewayError(code, `JSON value exceeds ${limit} byte limit`);
}

function assertLimit(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new AgentGatewayError('LIMIT_INVALID', `${label} must be a nonnegative safe integer`);
}

function isRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertJson(value, path = '$', depth = 0) {
  if (depth > 100) throw new Error(`JSON nesting exceeds 100 levels at ${path}`);
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (Array.isArray(value)) {
    value.forEach((child, index) => assertJson(child, `${path}/${index}`, depth + 1));
    return;
  }
  if (!isRecord(value)) throw new Error(`Expected a plain JSON value at ${path}`);
  for (const [key, child] of Object.entries(value)) {
    if (RESERVED_KEYS.has(key)) throw new Error(`Reserved JSON key at ${path}/${key}`);
    assertJson(child, `${path}/${key}`, depth + 1);
  }
}

function cloneJson(value) {
  assertJson(value);
  return JSON.parse(JSON.stringify(value));
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function jsonEqual(left, right) {
  return stableStringify(left) === stableStringify(right);
}

function escapePointer(value) {
  return value.replace(/~/g, '~0').replace(/\//g, '~1');
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

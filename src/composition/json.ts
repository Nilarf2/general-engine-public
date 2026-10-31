import { CompositionError } from './types.js';
import type { JsonObject, JsonValue } from './types.js';

export function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function assertJson(value: unknown, path = '$', depth = 0): asserts value is JsonValue {
  if (depth > 100) throw new CompositionError('JSON_DEPTH', `JSON nesting exceeds 100 levels at ${path}`);
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (Array.isArray(value)) {
    value.forEach((child, index) => assertJson(child, `${path}/${index}`, depth + 1));
    return;
  }
  if (!isRecord(value)) throw new CompositionError('JSON_VALUE', `Expected a plain JSON value at ${path}`);
  for (const [key, child] of Object.entries(value)) {
    if (key === '__proto__' || key === 'prototype' || key === 'constructor') {
      throw new CompositionError('JSON_KEY', `Reserved JSON key at ${path}/${key}`);
    }
    assertJson(child, `${path}/${key}`, depth + 1);
  }
}

export function cloneJson<T extends JsonValue>(value: T): T {
  assertJson(value);
  return JSON.parse(JSON.stringify(value)) as T;
}

export function cloneObject(value: JsonObject): JsonObject {
  return cloneJson(value);
}

export function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

export function isJsonObject(value: unknown): value is JsonObject {
  if (!isRecord(value)) return false;
  try {
    assertJson(value);
    return true;
  } catch {
    return false;
  }
}

export function jsonEqual(left: JsonValue, right: JsonValue): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length &&
      left.every((value, index) => jsonEqual(value, right[index]!));
  }
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length && leftKeys.every((key, index) =>
    key === rightKeys[index] && jsonEqual(left[key]!, right[key]!));
}

export function assertName(value: unknown, label: string, pattern = /^[a-z][a-z0-9-]*$/): asserts value is string {
  if (typeof value !== 'string' || !pattern.test(value) || ['__proto__', 'constructor', 'prototype'].includes(value)) {
    throw new CompositionError('NAME_INVALID', `${label} must be a valid identifier`);
  }
}

export function parsePointer(pointer: string): string[] {
  if (typeof pointer !== 'string' || (pointer !== '' && !pointer.startsWith('/'))) {
    throw new CompositionError('POINTER_INVALID', `Expected an absolute JSON Pointer: ${String(pointer)}`);
  }
  if (pointer === '') return [];
  return pointer.slice(1).split('/').map(segment => {
    if (/~(?![01])/.test(segment)) throw new CompositionError('POINTER_INVALID', `Invalid escape in JSON Pointer: ${pointer}`);
    const decoded = segment.replace(/~1/g, '/').replace(/~0/g, '~');
    if (decoded === '__proto__' || decoded === 'prototype' || decoded === 'constructor') {
      throw new CompositionError('POINTER_INVALID', `Reserved key in JSON Pointer: ${pointer}`);
    }
    return decoded;
  });
}

export function encodePointer(segments: readonly string[]): string {
  return segments.length ? `/${segments.map(segment => segment.replace(/~/g, '~0').replace(/\//g, '~1')).join('/')}` : '';
}

export function pointerGet(root: JsonValue, pointer: string): JsonValue | undefined {
  let current: JsonValue = root;
  for (const segment of parsePointer(pointer)) {
    if (Array.isArray(current)) {
      if (!/^(0|[1-9]\d*)$/.test(segment)) return undefined;
      const index = Number(segment);
      if (!Number.isSafeInteger(index) || index >= current.length) return undefined;
      current = current[index]!;
    } else if (current !== null && typeof current === 'object' && Object.hasOwn(current, segment)) {
      current = current[segment]!;
    } else {
      return undefined;
    }
  }
  return current;
}

export function pointerSet(root: JsonObject, pointer: string, value: JsonValue): JsonObject {
  const segments = parsePointer(pointer);
  const next = cloneJson(value);
  if (!segments.length) {
    if (!isJsonObject(next)) throw new CompositionError('STATE_ROOT', 'The root state must remain a JSON object');
    return next;
  }
  const parentPointer = encodePointer(segments.slice(0, -1));
  const parent = pointerGet(root, parentPointer);
  if (parent === undefined || parent === null || typeof parent !== 'object') {
    throw new CompositionError('POINTER_PARENT', `JSON Pointer parent does not exist: ${parentPointer}`);
  }
  const key = segments[segments.length - 1]!;
  if (Array.isArray(parent)) {
    if (!/^(0|[1-9]\d*)$/.test(key)) throw new CompositionError('POINTER_INDEX', `Invalid array index in JSON Pointer: ${pointer}`);
    const index = Number(key);
    if (!Number.isSafeInteger(index) || index >= parent.length) throw new CompositionError('POINTER_MISSING', `JSON Pointer does not exist: ${pointer}`);
    parent[index] = next;
  } else {
    Object.defineProperty(parent, key, { value: next, enumerable: true, configurable: true, writable: true });
  }
  return root;
}

export function pointerDelete(root: JsonObject, pointer: string): { state: JsonObject; footprint: string; value: JsonValue } {
  const segments = parsePointer(pointer);
  if (!segments.length) throw new CompositionError('POINTER_ROOT_DELETE', 'The root state cannot be deleted');
  const parentSegments = segments.slice(0, -1);
  const parentPointer = encodePointer(parentSegments);
  const parent = pointerGet(root, parentPointer);
  const key = segments[segments.length - 1]!;
  if (parent === undefined || parent === null || typeof parent !== 'object') {
    throw new CompositionError('POINTER_PARENT', `JSON Pointer parent does not exist: ${parentPointer}`);
  }
  if (Array.isArray(parent)) {
    if (!/^(0|[1-9]\d*)$/.test(key)) throw new CompositionError('POINTER_INDEX', `Invalid array index in JSON Pointer: ${pointer}`);
    const index = Number(key);
    if (!Number.isSafeInteger(index) || index >= parent.length) throw new CompositionError('POINTER_MISSING', `JSON Pointer does not exist: ${pointer}`);
    const removed = parent.splice(index, 1)[0]!;
    return { state: root, footprint: parentPointer, value: cloneJson(parent) };
  }
  if (!Object.hasOwn(parent, key)) throw new CompositionError('POINTER_MISSING', `JSON Pointer does not exist: ${pointer}`);
  const removed = parent[key]!;
  delete parent[key];
  return { state: root, footprint: pointer, value: cloneJson(removed) };
}

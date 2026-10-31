#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { runNarrativeAuthoring } from './authoring.js';
import type { AdventureModule } from './workflow-types.js';

/** Node entry point; applications may also embed runNarrativeAuthoring directly. */
export async function runNarrativeCli(argv = process.argv.slice(2)): Promise<number> {
  const result = await runNarrativeAuthoring(argv, {
    readText: path => readFile(path, 'utf8'),
    writeText: (path, text) => writeFile(path, text, 'utf8'),
    mkdir: async path => { if (path && path !== '.') await mkdir(path, { recursive: true }); },
    log: message => console.log(message),
    error: message => console.error(message),
  }, {
    loadModules: async path => {
      const loaded = await import(pathToFileURL(path).href) as { default?: readonly AdventureModule[]; modules?: readonly AdventureModule[] };
      return loaded.default ?? loaded.modules ?? [];
    },
  });
  return result.code;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exitCode = await runNarrativeCli();

#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createAgentCatalog, validateAgentCatalog } from './index.mjs';

export async function runAgentCli(args) {
  const [action, file] = args;
  if (!action || !['validate', 'list', 'revision'].includes(action) || !file || args.length !== 2) {
    throw new Error('Usage: node tools/agent/cli.mjs validate|list|revision <catalog.json>');
  }
  const source = JSON.parse(await readFile(resolve(file), 'utf8'));
  if (action === 'revision') {
    const catalog = createAgentCatalog(source?.modules);
    return { ok: true, revision: catalog.revision };
  }
  const catalog = validateAgentCatalog(source);
  if (action === 'validate') return { ok: true, apiVersion: catalog.apiVersion, revision: catalog.revision, modules: catalog.modules.length };
  return {
    ok: true,
    revision: catalog.revision,
    modules: catalog.modules.map(module => ({
      id: module.manifest.id,
      version: module.manifest.version,
      provides: module.manifest.provides,
      permissions: module.permissions,
    })),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runAgentCli(process.argv.slice(2)).then(result => console.log(JSON.stringify(result, null, 2))).catch(error => {
    console.error(JSON.stringify({ ok: false, code: error.code ?? 'CLI_ERROR', error: error.message }, null, 2));
    process.exitCode = 1;
  });
}

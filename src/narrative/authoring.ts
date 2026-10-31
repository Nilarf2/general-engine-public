import { compileStory, formatDiagnostics, validateStory } from './workflow-content.js';
import type { AdventureModule, Story } from './workflow-types.js';

export interface NarrativeAuthoringIO {
  readText(path: string): Promise<string>;
  writeText(path: string, text: string): Promise<void>;
  mkdir(path: string): Promise<void>;
  log(message: string): void;
  error(message: string): void;
}
export interface NarrativeAuthoringOptions {
  modules?: readonly AdventureModule[];
  loadModules?: (path: string) => Promise<readonly AdventureModule[]>;
}
export interface NarrativeAuthoringResult { code: number; output?: string }

function option(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}

/** Inspect a story without executing extension code or mutating author input. */
export function inspectStory(story: unknown, modules: readonly AdventureModule[] = []): Record<string, unknown> {
  const validation = validateStory(story, modules);
  if (!validation.valid) throw new Error(formatDiagnostics(validation));
  const value = story as Story;
  return {
    id: value.id,
    version: value.version,
    title: value.title,
    start: value.start,
    nodes: value.nodes.map(node => ({ id: node.id, type: node.type })),
    diagnostics: validation.diagnostics,
  };
}

/** Injectable authoring workflow for validate, inspect and compile commands. */
export async function runNarrativeAuthoring(
  args: readonly string[],
  io: NarrativeAuthoringIO,
  options: NarrativeAuthoringOptions = {},
): Promise<NarrativeAuthoringResult> {
  const [command, input] = args;
  const json = args.includes('--json');
  if (!command || !input || !['validate', 'inspect', 'compile'].includes(command)) {
    io.error('Usage: narrative <validate|inspect|compile> <story.json> [--json] [--out <story.compiled.json>] [--modules <module>].');
    return { code: 2 };
  }
  try {
    const parsed = JSON.parse(await io.readText(input)) as unknown;
    const modules = option(args, '--modules') && options.loadModules ? await options.loadModules(option(args, '--modules')!) : options.modules ?? [];
    if (command === 'validate') {
      const result = validateStory(parsed, modules);
      const output = formatDiagnostics(result, json ? 'json' : 'text');
      io.log(output);
      return { code: result.valid ? 0 : 1, output };
    }
    if (command === 'inspect') {
      const output = JSON.stringify(inspectStory(parsed, modules), null, 2);
      io.log(output);
      return { code: 0, output };
    }
    const compiled = compileStory(parsed as Story, modules);
    const out = option(args, '--out') ?? 'story.compiled.json';
    const directory = out.includes('/') ? out.slice(0, out.lastIndexOf('/')) : '';
    await io.mkdir(directory);
    const output = `${JSON.stringify(compiled.story, null, 2)}\n`;
    await io.writeText(out, output);
    io.log(`Compiled ${compiled.story.id}: ${out}`);
    return { code: 0, output };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    const output = json ? JSON.stringify({ error: message, file: input }) : `${input}: ${message}`;
    io.error(output);
    return { code: 1, output };
  }
}

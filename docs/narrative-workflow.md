# Narrative workflow

`@general-engine/engine/narrative` now exposes a data-driven AVG workflow beside the existing `StoryRunner`. `StoryRunner` is unchanged and remains appropriate for application-owned generators. The workflow API is a deterministic, synchronous session for stories authored as JSON and is safe to use in Node tests or a browser host.

The content lifecycle is:

```ts
import {
  compileStory,
  createNarrativeSession,
  type Story,
} from '@general-engine/engine/narrative';

const compiled = compileStory(story as Story, modules);
const session = createNarrativeSession(compiled, { seed: 42 });
const first = session.start();
const next = session.dispatch({ type: 'continue' });
```

`validateStory()` returns path-based diagnostics and understands built-in dialogue, narration, choice, branch, action, scene, module and end nodes. `compileStory()` validates, detaches and deep-freezes the story and creates a module registry. References to `module:*` nodes, conditions, actions, commands and capabilities are accepted only when the owning module registered them.

The built-in story model uses scalar variables, interpolation (`{{variable}}`), tags, visit counts, seeded integer-ranged randomness, scene/audio declarations, checkpoints and serializable module requests. A module has an ID, semantic version, optional state version and migration, initial state, dependency declarations and a `register()` function. Module handlers receive an `ExecutionContext`; they can update module state, emit events, return effects and read host capabilities. The engine does not provide filesystem, clock or network capabilities; extensions remain ordinary application JavaScript and should be reviewed like other application code.

Every `start()` or `dispatch()` call is transactional. The runtime clones state, executes automatic graph transitions, validates counters and JSON data, and commits one revision only after success. A thrown choice, module, or extension error leaves the previous snapshot unchanged. `StepResult` contains detached `state`, `view`, `events` and `effects`; the host applies effects through `NarrativeWebAdapter` or its own adapter.

Snapshots are JSON-only records containing engine/content/module versions and the complete cursor. `validateSnapshot()` checks the envelope, while `validateSnapshotForStory()` checks the cursor against compiled content. `prepareSnapshot()` can accept an explicit content migration, a module-version compatibility policy and module state migrations. `MemoryNarrativeSaveStore` is useful for tests; `LocalStorageNarrativeSaveStore` stores validated records under a namespaced key. `saveSession()` writes a detached record with a caller-provided slot, timestamp or label.

Browser applications can use `WebAudioAdapter` for music, ambience and sound effects. Asset lookup, audio construction, error reporting and fade timing are injectable, so autoplay failures and stale asynchronous loads cannot replace a newer channel request. `NarrativeWebAdapter` routes scene, module-request, checkpoint and event callbacks to application-owned UI/game systems and delegates audio effects to `AudioPort`.

The authoring workflow is injectable and does not execute story data. `runNarrativeAuthoring()` supports `validate`, `inspect` and `compile` with an application-provided filesystem. `npm run narrative -- <command> <story.json>` provides the Node wrapper:

```sh
npm run narrative -- validate story.json
npm run narrative -- inspect story.json --json
npm run narrative -- compile story.json --out build/story.compiled.json
```

`npm run narrative:route -- --story <story.json> --route <route.json> --out <trace.json>` executes an authored sequence of `continue`/`choose` commands and verifies the expected ending and state. `npm run narrative:map -- <story.json> --format json|mermaid` exports a static structure report without running conditions or modules. The example under `examples/narrative/` demonstrates both tools. Route traces are deterministic and should be kept with private project evidence if they expose unreleased story state.

The module registry, compiler, session, save and browser adapter contracts are adapted from [Nilarf2/text-adventure-engine](https://github.com/Nilarf2/text-adventure-engine), © 2026 Nilarf2, MIT. This implementation is self-contained and adds no runtime dependency on that checkout; it includes no game content or assets. The source files carry adaptation notices, and the repository's MIT license retains the required copyright notice.

The narrative package is already exported by this repository's `./narrative` package entry. No root `src/core/index.ts`, shared package manifest, or lockfile change is required for these APIs.

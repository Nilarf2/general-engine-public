# Narrative Authoring Tools

The route checker runs one authored player path against a story and writes a deterministic trace. It complements the narrative CLI's `validate`, `inspect` and `compile` commands by checking that a real sequence of player commands reaches the intended ending and state. The story-map tool creates an offline graph report and Mermaid diagram for structural review.

```sh
npm run build:engine
npm run narrative -- validate examples/narrative/story.json
npm run narrative -- inspect examples/narrative/story.json --json
npm run narrative -- compile examples/narrative/story.json --out build/story.compiled.json
npm run narrative:route -- --story examples/narrative/story.json --route examples/narrative/routes/answered.json --out build/answered-route.json
npm run narrative:map -- examples/narrative/story.json --out build/story-map.json
npm run narrative:map -- examples/narrative/story.json --format mermaid --out build/story-map.mmd
npx tsx --test tools/narrative/story-map.test.mjs
npx tsx --test tests/narrative-route.test.ts
```

The route file is JSON:

```json
{
  "storyId": "sample-story",
  "contentVersion": "1.0.0",
  "seed": 42,
  "steps": [
    { "node": "opening", "command": { "type": "continue" } },
    { "node": "choice", "command": { "type": "choose", "optionId": "stay" } }
  ],
  "ending": "quiet-night",
  "variables": { "trust": 1 },
  "tags": ["stayed"]
}
```

`storyId`, `contentVersion`, `seed`, `variables` and `tags` are optional. Each step names the node visible before its command. The checker confirms that the choice exists and is enabled, then runs the engine's deterministic session with the supplied seed (default `1`). It requires the route to reach an end node and checks the requested ending, variable values and presence of expected tags. The output contains each player-visible state and a complete final snapshot; it has no generated timestamp, so identical inputs produce identical JSON.

The route checker is offline and only reads the story and route files explicitly passed on the command line. It does not load game modules or execute arbitrary story extensions. Route commands currently cover `continue` and enabled `choose` interactions. It does not establish graph-wide reachability; run the story-map analysis and author a route for each ending that needs behavioral coverage.

`story-map.mjs` reads a story JSON file without loading modules or evaluating conditions. Its report includes declared edges, malformed references, reachable and unreachable nodes, non-ending dead ends, nodes without a declared path to an ending, cycles, and custom node types whose flow may be dynamic. `analysis.valid` covers graph structure only; run the narrative CLI's `validate` command for full schema and extension validation. Mermaid labels are escaped, and generated node IDs are stable within a report.

The focused graph-tool tests use Node's test API and run with `npx tsx --test tools/narrative/story-map.test.mjs`. Route-checker tests live under `tests/` and run in the standard `npm test` suite (`tsx --test tests/*.test.ts`).

This workflow is a fresh implementation informed by the same authoring problem space as Nilarf2's [text-adventure-engine](https://github.com/Nilarf2/text-adventure-engine), © 2026 Nilarf2, MIT. The tools contain no source-game story text or assets.

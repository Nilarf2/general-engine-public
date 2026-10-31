import assert from "node:assert/strict";
import test from "node:test";
import { runModularAdventure } from "../examples/composition/modular-adventure.js";

test("clear visibility composes concurrent modules and follows the direct route", async () => {
  const result = await runModularAdventure("clear");

  assert.equal(result.route, "direct");
  assert.equal(result.ending, "direct-approach");
  assert.deepEqual(result.workerStartOrder, ["weather", "archive"]);
  assert.equal(result.maxConcurrentWorkers, 2);
  assert.ok(result.events.some((event) => event.type === "mission.reports-ready"));
  assert.ok(result.events.some((event) => event.type === "mission.route-selected"));
  assert.ok(result.effectRecords.some((effect) => effect.type === "worker.completed"));
  assert.ok(result.effectRecords.some((effect) => effect.type === "mission.route-record"));
  assert.deepEqual(result.reports.weather, {
    visibility: "clear",
    summary: "clear skies",
  });
  assert.deepEqual(result.reports.archive, {
    beacon: "logged",
    note: "The keeper recorded the beacon code.",
  });
});

test("foggy visibility takes the conditional coastline route", async () => {
  const result = await runModularAdventure("foggy");

  assert.equal(result.route, "shore");
  assert.equal(result.ending, "shore-approach");
  assert.equal(result.maxConcurrentWorkers, 2);
  assert.ok(result.events.some((event) => event.type === "mission.route-selected"));
});

import {
  createCompositionRuntime,
  type CompositionGraph,
  type CompositionModule,
  type EffectRecord,
  type JsonValue,
  type RuntimeEvent,
} from '../../src/composition/index.js';

export type Visibility = 'clear' | 'foggy';
type WorkerName = 'weather' | 'archive';
type MissionInput = { visibility: Visibility };
type WorkOrder = { worker: WorkerName; visibility: Visibility };
type PlannerCapability = { plan(worker: WorkerName, input: MissionInput): WorkOrder };

export interface ModularAdventureResult {
  route: string;
  ending: string;
  workerStartOrder: WorkerName[];
  maxConcurrentWorkers: number;
  events: readonly RuntimeEvent[];
  effectRecords: readonly EffectRecord[];
  reports: Record<WorkerName, JsonValue>;
}

const plannerModule: CompositionModule = {
  manifest: {
    id: 'planner',
    version: '1.0.0',
    apiVersion: 1,
    provides: ['planner:work-order'],
  },
  setup(context) {
    const capability: PlannerCapability = {
      plan: (worker, input) => ({ worker, visibility: input.visibility }),
    };
    context.provide('planner:work-order', capability);
  },
  execute() { return null; },
};

const workerModule = (worker: WorkerName, delayMs: number): CompositionModule => ({
  manifest: {
    id: `${worker}-worker`,
    version: '1.0.0',
    apiVersion: 1,
    requires: { planner: '1.0.0' },
  },
  async execute(context) {
    const input = context.input as MissionInput;
    const planner = context.capability<PlannerCapability>('planner:work-order');
    const order = planner.plan(worker, input);
    workerStartOrder.push(order.worker);
    activeWorkers++;
    maxConcurrentWorkers = Math.max(maxConcurrentWorkers, activeWorkers);
    try {
      await new Promise(resolve => setTimeout(resolve, delayMs));
      const report: JsonValue = worker === 'weather'
        ? { visibility: order.visibility, summary: order.visibility === 'clear' ? 'clear skies' : 'dense fog' }
        : { beacon: 'logged', note: 'The keeper recorded the beacon code.' };
      context.set(`/reports/${worker}`, report);
      context.effect('worker.completed', { worker, report });
      return report;
    } finally {
      activeWorkers--;
    }
  },
});

let workerStartOrder: WorkerName[] = [];
let activeWorkers = 0;
let maxConcurrentWorkers = 0;

const announceModule: CompositionModule = {
  manifest: { id: 'announcer', version: '1.0.0', apiVersion: 1 },
  execute(context) {
    const reports = context.get('/reports')!;
    context.emit('mission.reports-ready', reports);
    context.effect('mission.waiting-for-route', { reportCount: 2 });
    return 'reports-ready';
  },
};

const routeModule: CompositionModule = {
  manifest: { id: 'route-planner', version: '1.0.0', apiVersion: 1 },
  execute(context) {
    if (context.event?.type !== 'mission.reports-ready') {
      throw new Error('Route planning must resume from mission.reports-ready');
    }
    const reports = context.event.payload as {
      weather: { visibility: Visibility };
      archive: { beacon: string };
    };
    const route = reports.weather.visibility === 'clear' && reports.archive.beacon === 'logged'
      ? 'direct'
      : 'shore';
    context.set('/route', route);
    context.emit('mission.route-selected', { route });
    context.effect('mission.route-record', { route });
    return route;
  },
};

const endingModule = (id: 'direct-ending' | 'shore-ending', ending: string): CompositionModule => ({
  manifest: { id, version: '1.0.0', apiVersion: 1 },
  execute(context) {
    context.set('/ending', ending);
    context.effect('mission.ending-record', { ending });
    return ending;
  },
});

const graph: CompositionGraph = {
  id: 'modular-lighthouse',
  version: 1,
  start: 'dispatch-workers',
  nodes: [
    {
      id: 'dispatch-workers',
      type: 'parallel',
      output: '/reports/parallel',
      branches: [
        {
          id: 'weather-branch',
          version: 1,
          start: 'weather-check',
          nodes: [{ id: 'weather-check', type: 'module', module: 'weather-worker' }],
        },
        {
          id: 'archive-branch',
          version: 1,
          start: 'archive-check',
          nodes: [{ id: 'archive-check', type: 'module', module: 'archive-worker' }],
        },
      ],
      edges: [{ to: 'announce-reports' }],
    },
    { id: 'announce-reports', type: 'module', module: 'announcer' },
    {
      id: 'select-route',
      type: 'module',
      module: 'route-planner',
      edges: [
        {
          to: 'direct-approach',
          priority: 0,
          when: {
            op: 'eq',
            left: { from: 'result' },
            right: { from: 'literal', value: 'direct' },
          },
        },
        { to: 'shore-approach', priority: 1 },
      ],
    },
    { id: 'direct-approach', type: 'module', module: 'direct-ending' },
    { id: 'shore-approach', type: 'module', module: 'shore-ending' },
  ],
  triggers: [{ id: 'reports-ready', event: 'mission.reports-ready', start: 'select-route' }],
};

export async function runModularAdventure(visibility: Visibility = 'clear'): Promise<ModularAdventureResult> {
  workerStartOrder = [];
  activeWorkers = 0;
  maxConcurrentWorkers = 0;
  const modules = [
    plannerModule,
    workerModule('weather', 10),
    workerModule('archive', 5),
    announceModule,
    routeModule,
    endingModule('direct-ending', 'direct-approach'),
    endingModule('shore-ending', 'shore-approach'),
  ];
  const runtime = await createCompositionRuntime({
    graph,
    modules,
    initialState: {
      reports: { weather: null, archive: null, parallel: [] },
      route: 'pending',
      ending: 'pending',
    },
  });

  try {
    const result = await runtime.run({ visibility } satisfies MissionInput as unknown as JsonValue);
    return {
      route: String(result.state.route),
      ending: String(result.state.ending),
      workerStartOrder: [...workerStartOrder],
      maxConcurrentWorkers,
      events: result.events,
      effectRecords: result.effects,
      reports: result.state.reports as Record<WorkerName, JsonValue>,
    };
  } finally {
    await runtime.dispose();
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const result = await runModularAdventure();
  console.log(`${result.ending} via ${result.route} route; ${result.maxConcurrentWorkers} workers overlapped.`);
}

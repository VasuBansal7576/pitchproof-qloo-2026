import { spawnSync } from 'node:child_process';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { availableParallelism, loadavg } from 'node:os';
import assert from 'node:assert/strict';
import { Miniflare } from 'miniflare';

const args = process.argv.slice(2);
const option = (name: string) => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
const baseline = resolve(option('--baseline') ?? '');
const destination = resolve(option('--output') ?? '.pstack/performance-2026-10-26/benchmark.json');
const child = args.indexOf('--child');
const input = {
  brief: { product: 'Controlled running shoe', description: 'A hypothetical running shoe. No performance claims verified.', category: 'Running footwear', market: 'London', audience: 'Recreational runners', objective: 'Launch', constraints: 'Evidence remains hypothetical.', website: '', productFacts: [{ id: 'F1', text: 'A hypothetical running shoe used only in the controlled synthetic benchmark.', source: 'user_supplied', sourceUrl: null }], callToAction: 'Explore the test product' },
  references: [{ query: 'Nike', role: 'competitor' }, { query: 'Aesop', role: 'aesthetic' }, { query: 'Patagonia', role: 'audience' }],
};

async function sample(source: string, kind: string) {
  const moduleAt = (file: string) => import(pathToFileURL(resolve(source, file)).href);
  const { Store } = await moduleAt('server/store.ts');
  const { PitchProof, makeProject, makeOperation } = await moduleAt('server/pitchproof.ts');
  const { parseProjectInput } = await moduleAt('server/validation.ts');
  const mf = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("ok"); } }', compatibilityDate: '2026-05-01', d1Databases: ['DB'] });
  const db = await mf.getD1Database('DB');
  const migrationFiles = (await readdir(resolve('drizzle'))).filter(file => /^\d+_.+\.sql$/.test(file)).sort();
  assert.ok(migrationFiles.length > 0, 'The working directory must contain the real Drizzle migrations.');
  for (const file of migrationFiles) {
    const migration = await readFile(resolve('drizzle', file), 'utf8');
    for (const sql of migration.split('--> statement-breakpoint')) if (sql.trim()) await db.prepare(sql.trim()).run();
  }
  const store = new Store(db);
  let project = makeProject(parseProjectInput(input));
  project.references.forEach((ref: { query: string; entity: unknown }, index: number) => { ref.entity = { id: `seed-${index}`, name: ref.query, type: 'urn:entity:brand', description: '', image: null, url: null }; });
  project.operation = makeOperation(project, kind, kind === 'revision' ? 'Research fresh artist and movie associations.' : null, null, kind === 'revision' ? ['artist', 'movie'] : undefined);
  project.status = 'researching';
  const plan = structuredClone(project.operation.steps);
  await store.create('benchmark-owner', project);
  const service = new PitchProof(store, { QLOO_API_KEY: 'synthetic-benchmark-only', MODEL_API_KEY: 'synthetic-benchmark-only' });
  const originalFetch = globalThis.fetch;
  const queries: { key: string; startMs: number; endMs: number; status: number }[] = [];
  let active = 0, peak = 0, advances = 0;
  const start = performance.now();
  const cpu = process.cpuUsage();
  globalThis.fetch = async (request) => {
    const url = new URL(String(request));
    assert.equal(url.origin, 'https://hackathon.api.qloo.com');
    assert.equal(url.pathname, '/v2/insights');
    const category = url.searchParams.get('filter.type')!;
    const seed = url.searchParams.get('signal.interests.entities')!;
    const key = `${seed}/${category}`;
    const index = plan.findIndex((step: { seedIds: string[]; category: string }) => step.seedIds[0] === seed && `urn:entity:${step.category}` === category);
    assert.ok(index >= 0);
    const record = { key, startMs: performance.now() - start, endMs: 0, status: 200 };
    queries.push(record); active++; peak = Math.max(peak, active);
    await new Promise(done => setTimeout(done, 250 + (index % 3) * 35));
    active--; record.endMs = performance.now() - start;
    return Response.json({ results: { entities: Array.from({ length: 6 }, (_, n) => ({ entity_id: `result-${index}-${n}`, name: `Observed ${index} ${n}`, query: { affinity: 0.5 } })) } });
  };
  try {
    while (project.operation.phase === 'research') {
      assert.ok(advances++ < 20);
      project = await service.execute('benchmark-owner', project.id, { action: 'advance', expectedVersion: project.version, commandId: crypto.randomUUID() });
      assert.notEqual(project.status, 'error');
    }
    const elapsedMs = performance.now() - start;
    const cpuUsed = process.cpuUsage(cpu);
    assert.equal(queries.length, plan.length);
    assert.equal(new Set(queries.map(query => query.key)).size, plan.length);
    assert.equal(project.evidence.length, plan.length * 6);
    assert.ok(project.operation.steps.every((step: { status: string }) => step.status === 'complete'));
    assert.equal(project.generations.length, 0);
    const usage = await db.prepare('SELECT calls FROM provider_usage WHERE owner_id = ?').bind('benchmark-owner').first<{ calls: number }>();
    assert.equal(usage?.calls, queries.length);
    for (const step of project.operation.steps) {
      const records = project.evidence.filter((record: { id: string }) => step.evidenceIds.includes(record.id));
      assert.equal(records.length, 6);
      assert.ok(records.every((record: { context: { referenceIds: string[]; parameters: Record<string, string> } }) => record.context.referenceIds[0] === step.seedIds[0] && record.context.parameters['filter.type'] === `urn:entity:${step.category}`));
    }
    return { kind, elapsedMs, cpuMs: (cpuUsed.user + cpuUsed.system) / 1000, advances, requests: queries.length, evidence: project.evidence.length, failures: 0, peakConcurrency: peak, queries };
  } finally { globalThis.fetch = originalFetch; await mf.dispose(); }
}

if (child >= 0) {
  console.log(JSON.stringify(await sample(args[child + 1], args[child + 2])));
} else {
  assert.ok(args.includes('--baseline'), 'Supply a frozen baseline tree containing server/ and lib/.');
  const runs: Record<string, unknown>[] = [];
  for (const kind of ['research', 'revision']) {
    for (let trial = 0; trial < 5; trial++) {
      for (const side of ['baseline', 'candidate']) {
        const source = side === 'baseline' ? baseline : process.cwd();
        const result = spawnSync(process.execPath, ['--import', 'tsx', import.meta.filename, '--child', source, kind], { encoding: 'utf8', timeout: 60_000 });
        assert.equal(result.status, 0, result.stderr || result.stdout);
        const row = JSON.parse(result.stdout.trim());
        runs.push({ side, trial, ...row });
      }
    }
  }
  const summaries = ['research', 'revision'].flatMap(kind => ['baseline', 'candidate'].map(side => {
    const rows = runs.filter(row => row.kind === kind && row.side === side);
    const times = rows.map(row => Number(row.elapsedMs)).sort((a, b) => a - b);
    return { side, kind, samples: rows.length, medianMs: times[2], minMs: times[0], maxMs: times.at(-1), requests: rows[0].requests, evidence: rows[0].evidence, peakConcurrency: rows[0].peakConcurrency, advances: rows[0].advances, failures: rows.reduce((n, row) => n + Number(row.failures), 0) };
  }));
  await mkdir(resolve(destination, '..'), { recursive: true });
  await writeFile(destination, JSON.stringify({ recordedAt: new Date().toISOString(), scope: 'Controlled service research only. Real local D1 and synthetic delayed Qloo responses. Excludes browser/network round trips, synthesis/review and vendor latency. No live speedup claim.', fixtureDelayMs: [250, 285, 320], environment: { node: process.version, cores: availableParallelism(), load: loadavg() }, summaries, runs }, null, 2));
  console.log(JSON.stringify(summaries, null, 2));
}

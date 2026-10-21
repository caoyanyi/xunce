import assert from 'node:assert/strict';
import { setTimeout } from 'node:timers/promises';

const base = (process.env.SMOKE_URL || 'http://127.0.0.1:4318').replace(/\/$/, '');
async function request(path, body) {
  const response = await fetch(base + path, {
    ...(body === undefined
      ? {}
      : {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }),
    signal: AbortSignal.timeout(15000),
  });
  const result = await response.json();
  assert(response.ok, `${path}: HTTP ${response.status} ${result.error || ''}`);
  return result;
}
assert.equal((await request('/api/health')).status, 'ok');
const htmlResponse = await fetch(base);
assert(htmlResponse.ok, 'Web console is unavailable');
const html = await htmlResponse.text();
const asset = html.match(/<script[^>]+src="([^"]+)"/);
assert(asset, 'Compiled frontend is missing');
assert((await fetch(new URL(asset[1], base))).ok, 'Frontend asset is unavailable');
const { demoUrl } = await request('/api/config');
const session = await request('/api/sessions', { targetUrl: demoUrl });
const definitions = [
  {
    title: 'Docker · TesterArmy 页面验证',
    engine: 'tester-army',
    kind: 'smoke',
    url: demoUrl,
    steps: [{ action: 'goto', url: demoUrl }, { action: 'assertPage' }],
  },
  {
    title: 'Docker · Playwright 表单验证',
    engine: 'playwright',
    kind: 'form',
    url: `${demoUrl}/login`,
    steps: [
      { action: 'goto', url: `${demoUrl}/login` },
      { action: 'validateForm', index: 0 },
    ],
  },
  {
    title: 'Docker · 故障证据验证',
    engine: 'tester-army',
    kind: 'smoke',
    url: `${demoUrl}/sale`,
    steps: [{ action: 'goto', url: `${demoUrl}/sale` }, { action: 'assertPage' }],
  },
];
for (const task of definitions) await request(`/api/sessions/${session.id}/tasks`, task);
await request(`/api/sessions/${session.id}/run`, {});
const deadline = Date.now() + 180000;
let snapshot;
while (Date.now() < deadline) {
  snapshot = await request(`/api/sessions/${session.id}`);
  if (!['running', 'discovering'].includes(snapshot.session.status)) break;
  await setTimeout(1000);
}
assert.equal(snapshot.session.status, 'completed', 'Container run did not complete');
assert.equal(snapshot.tasks.filter((task) => task.status === 'passed').length, 2);
assert.equal(snapshot.tasks.filter((task) => task.status === 'failed').length, 1);
assert.equal(snapshot.runs.length, 3);
const failure = snapshot.runs.find((run) => run.status === 'failed');
assert.match(failure.error, /HTTP 500/);
for (const run of snapshot.runs) {
  assert(run.screenshot, `${run.engine}: screenshot missing`);
  assert((await fetch(base + run.screenshot)).ok, `${run.engine}: screenshot unavailable`);
  assert(run.report, `${run.engine}: report missing`);
  assert((await fetch(base + run.report)).ok, `${run.engine}: report unavailable`);
}
console.log(
  JSON.stringify(
    {
      status: 'passed',
      url: base,
      sessionId: session.id,
      checks: [
        'frontend',
        'health',
        'TesterArmy',
        'Playwright',
        'HTTP 500 failure evidence',
        'screenshots',
        'reports',
      ],
    },
    null,
    2,
  ),
);

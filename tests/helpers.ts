import { mkdtemp, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createApp } from '../server/app.ts';
import { now, optionsSchema, type Session, type Task } from '../shared/types.ts';
export const session = (url = 'http://127.0.0.1:4318/demo'): Session => ({
  id: 'session-test',
  name: 'test',
  targetUrl: url,
  status: 'idle',
  options: optionsSchema.parse({ engine: 'playwright' }),
  createdAt: now(),
  updatedAt: now(),
});
export const task = (url: string, patch: Partial<Task> = {}): Task => ({
  id: 'task-test',
  sessionId: 'session-test',
  title: '页面可用性',
  description: '测试',
  url,
  kind: 'smoke',
  priority: 'P1',
  source: 'dom',
  engine: 'playwright',
  risk: 'read',
  steps: [{ action: 'goto', url }, { action: 'assertPage' }],
  status: 'pending',
  createdAt: now(),
  ...patch,
});
export async function testApp() {
  await mkdir(resolve('data'), { recursive: true });
  const dir = await mkdtemp(resolve('data/test-'));
  const instance = await createApp({
    dbPath: `${dir}/db.sqlite`,
    artifactsDir: `${dir}/artifacts`,
  });
  await instance.app.listen({ host: '127.0.0.1', port: 0 });
  const address = instance.app.server.address();
  if (!address || typeof address === 'string') throw new Error('Missing test address');
  return { ...instance, dir, base: `http://127.0.0.1:${address.port}` };
}

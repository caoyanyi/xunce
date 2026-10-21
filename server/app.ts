import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z, ZodError } from 'zod';
import {
  now,
  optionsSchema,
  optionsPatchSchema,
  engineSchema,
  stepSchema,
  statusLabels,
  type Task,
} from '../shared/types.ts';
import { Store } from './store.ts';
import { isAllowedOrigin } from './network.ts';
import { classifyMessage } from '../shared/commands.ts';
import { UserError, targetUrl, validateTask } from './policy.ts';
import { Orchestrator } from './orchestrator.ts';
import { registerDemo } from './demo.ts';
import { midsceneConfigured, plannerConfigured } from './planner.ts';
import { explain } from './diagnostics.ts';

const createSchema = z.object({
  targetUrl: z.string().max(2000).default(''),
  options: optionsPatchSchema.optional(),
});
const chatSchema = z.object({
  message: z.string().trim().min(1).max(4000),
  targetUrl: z.string().max(2000).optional(),
  options: optionsPatchSchema.optional(),
});
const taskDefinitionSchema = z.object({
  title: z.string().min(1).max(120),
  description: z.string().max(2000),
  url: z.string().url(),
  engine: engineSchema,
  kind: z.enum(['smoke', 'navigation', 'form', 'visual']),
  priority: z.enum(['P0', 'P1', 'P2']),
  risk: z.enum(['read', 'write']),
  steps: z.array(stepSchema).min(1).max(30),
});
const taskSchema = taskDefinitionSchema.extend({
  description: taskDefinitionSchema.shape.description.default('手动创建的测试任务'),
  priority: taskDefinitionSchema.shape.priority.default('P1'),
  risk: taskDefinitionSchema.shape.risk.default('read'),
});
export async function createApp(
  config: { dbPath?: string; artifactsDir?: string; logger?: boolean } = {},
) {
  const app = Fastify({ logger: config.logger ?? false, bodyLimit: 64 * 1024 });
  const dataDir = resolve(process.env.DATA_DIR || 'data');
  const artifactsDir = resolve(config.artifactsDir || `${dataDir}/artifacts`);
  await mkdir(artifactsDir, { recursive: true });
  const store = new Store(config.dbPath || `${dataDir}/explorer.sqlite`);
  store.recoverInterrupted();
  const orchestrator = new Orchestrator(store, artifactsDir);
  app.addHook('onRequest', async (req, reply) => {
    const host = req.headers.host || '';
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers.origin) {
      if (!isAllowedOrigin(req.headers.origin, host))
        return reply.code(403).send({ error: '跨站写请求被拒绝' });
    }
  });
  app.addHook('onSend', async (req, reply, payload) => {
    reply
      .header('X-Content-Type-Options', 'nosniff')
      .header('X-Frame-Options', 'DENY')
      .header('Referrer-Policy', 'no-referrer');
    if (req.url.startsWith('/api/')) reply.header('Cache-Control', 'no-store');
    if (
      req.url.startsWith('/artifacts/') &&
      String(reply.getHeader('content-type')).includes('text/html')
    )
      reply
        .header(
          'Content-Security-Policy',
          "sandbox; default-src 'none'; img-src data: 'self'; style-src 'unsafe-inline'",
        )
        .header('Content-Disposition', 'attachment');
    return payload;
  });
  app.setErrorHandler((error, _req, reply) => {
    if (error instanceof ZodError)
      return reply
        .code(400)
        .send({ error: error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('；') });
    const candidate =
      error && typeof error === 'object' && 'statusCode' in error ? Number(error.statusCode) : 500;
    const statusCode =
      error instanceof UserError
        ? error.statusCode
        : candidate >= 400 && candidate < 500
          ? candidate
          : 500;
    if (statusCode === 500) app.log.error(error);
    reply.code(statusCode).send({
      error:
        statusCode === 500
          ? '服务器内部错误，请查看日志'
          : error instanceof Error
            ? error.message
            : '请求错误',
    });
  });
  const sessionFor = (id: string) => {
    const session = store.get('sessions', id);
    if (!session) throw new UserError('会话不存在', 404);
    return session;
  };
  const assertIdle = (sessionId: string) => {
    if (orchestrator.isBusy(sessionId))
      throw new UserError('此会话已有运行或排队中的作业，请等待完成或停止当前任务', 409);
  };
  const validateDraft = (task: Task, origin: string) => {
    validateTask(task, origin, true);
    if (
      !task.steps.some((step) =>
        [
          'assertPage',
          'assertText',
          'assertUrl',
          'assertLink',
          'aiAssert',
          'validateForm',
        ].includes(step.action),
      )
    )
      throw new UserError('请至少添加一个结果断言或表单校验步骤');
  };
  app.get('/api/config', async () => ({
    planner: plannerConfigured(),
    midscene: midsceneConfigured(),
    // Tests execute on the server. Keep the built-in demo on loopback so its
    // default TesterArmy engine also works when the console is opened over LAN.
    demoUrl: `http://127.0.0.1:${(app.server.address() as { port: number } | null)?.port || Number(process.env.PORT || 4318)}/demo`,
    engines: ['playwright', 'tester-army', 'midscene'],
  }));
  app.get('/api/health', async () => ({ status: 'ok' }));
  app.get('/api/runtime', async () => orchestrator.runtime());
  app.get('/api/sessions', async () => store.list('sessions').reverse());
  app.post('/api/sessions', async (req, reply) => {
    const body = createSchema.parse(req.body || {});
    const session = store.createSession(
      body.targetUrl ? targetUrl(body.targetUrl) : '',
      body.options,
    );
    store.message(
      session.id,
      'assistant',
      '告诉我要测试的站点和目标。我会探索页面、发现测试任务，并保存每一步的执行证据。也可以直接试用内置演示站点。',
    );
    return reply.code(201).send(session);
  });
  app.get<{ Params: { id: string } }>('/api/sessions/:id', async (req) => {
    sessionFor(req.params.id);
    return store.snapshot(req.params.id);
  });
  app.patch<{ Params: { id: string } }>('/api/sessions/:id', async (req) => {
    const session = sessionFor(req.params.id);
    assertIdle(session.id);
    const body = z
      .object({
        name: z.string().trim().min(1).max(80).optional(),
        targetUrl: z.string().max(2000).optional(),
        options: optionsPatchSchema.optional(),
      })
      .strict()
      .parse(req.body);
    const url =
      body.targetUrl !== undefined
        ? body.targetUrl
          ? targetUrl(body.targetUrl)
          : ''
        : session.targetUrl;
    if (url !== session.targetUrl && store.list('tasks', session.id).length)
      throw new UserError('此会话已有任务。更换目标请新建探索。');
    return store.updateSession(session.id, {
      targetUrl: url,
      ...(body.name ? { name: body.name } : {}),
      options: optionsSchema.parse({ ...session.options, ...body.options }),
    });
  });
  app.post<{ Params: { id: string } }>('/api/sessions/:id/chat', async (req, reply) => {
    const id = req.params.id;
    const session = sessionFor(id);
    const body = chatSchema.parse(req.body);
    const content = body.message;
    const command = classifyMessage(content);
    // Read-only and stop commands remain available during a running job.
    if (command === 'stop') {
      store.message(id, 'user', content);
      const stopped = orchestrator.cancel(id);
      store.message(
        id,
        'assistant',
        stopped ? '正在停止并保存已有结果…' : '当前没有运行中的任务。',
      );
      return reply.code(202).send({ accepted: true });
    }
    if (command === 'status') {
      store.message(id, 'user', content);
      const tasks = store.list('tasks', id).filter((task) => !task.archived);
      const failures = tasks.filter((task) => task.status === 'failed');
      store.message(
        id,
        'assistant',
        `当前状态：${statusLabels[session.status]}。共 ${tasks.length} 个任务，${tasks.filter((t) => t.status === 'passed').length} 项通过，${failures.length} 项失败。${
          failures.length
            ? '\n失败任务：\n' +
              failures
                .slice(0, 10)
                .map((task) => `• ${task.title}`)
                .join('\n')
            : ''
        }`,
      );
      return { accepted: true };
    }
    if (command === 'explain') {
      store.message(id, 'user', content);
      store.message(
        id,
        'assistant',
        explain(store.snapshot(id)!, content, {
          planner: plannerConfigured(),
          midscene: midsceneConfigured(),
        }),
      );
      return { accepted: true, mode: 'explain' };
    }
    if (command === 'help') {
      store.message(id, 'user', content);
      store.message(
        id,
        'assistant',
        '输入站点地址和测试目标即可开始。可用指令：只探索、重新规划、运行全部任务、继续未完成、复跑失败任务、状态、停止。普通问题不会启动测试。可以新建/编辑任务，批量选择执行，停用或归档不需要的任务。不同会话会自动排队。',
      );
      return { accepted: true };
    }
    assertIdle(id);
    const urlMatch = content.match(/https?:\/\/[^\s<>"'，。；！？）)]+/);
    const proposed = body.targetUrl || urlMatch?.[0] || session.targetUrl;
    const url = proposed ? targetUrl(proposed) : '';
    if (!url) throw new UserError('请填写目标 URL，或在对话中包含完整站点地址');
    if (session.targetUrl && url !== session.targetUrl && store.list('tasks', id).length)
      throw new UserError('此会话已有任务。更换目标请新建探索。');
    const previousGoal =
      session.goal ||
      store
        .list('messages', id)
        .filter(
          (message) =>
            message.role === 'user' &&
            ['auto', 'discover'].includes(classifyMessage(message.content)),
        )
        .at(-1)?.content;
    store.updateSession(id, {
      targetUrl: url,
      name: session.targetUrl ? session.name : new URL(url).hostname,
      goal: ['auto', 'discover'].includes(command) ? content : previousGoal,
      options: optionsSchema.parse({ ...session.options, ...body.options }),
    });
    const mode = command;
    const job = orchestrator.start(id, mode, content);
    store.message(id, 'user', content);
    store.message(
      id,
      'assistant',
      job.status === 'queued'
        ? '已加入运行队列，当前作业完成后自动开始。排队期间可以取消。'
        : mode === 'continue'
          ? '开始执行未完成任务；已通过和已失败的任务会跳过。'
          : mode === 'plan'
            ? '基于已发现页面重新规划任务，完成后可先编辑再运行。'
            : mode === 'retry'
              ? '开始复跑失败或中断的任务，每次执行将生成独立记录。'
              : mode === 'run'
                ? '开始执行已发现的任务。'
                : `已接收目标：${url}。正在观察站点并发现可验证任务…`,
    );
    return reply.code(202).send({ accepted: true, mode, job });
  });
  app.post<{ Params: { id: string } }>('/api/sessions/:id/run', async (req, reply) => {
    const session = sessionFor(req.params.id);
    const body = z
      .object({
        taskIds: z.array(z.string().uuid()).min(1).max(100).optional(),
        failedOnly: z.boolean().default(false),
        mode: z.enum(['run', 'retry', 'continue']).optional(),
      })
      .parse(req.body || {});
    if (body.taskIds?.some((id) => !store.list('tasks', session.id).some((t) => t.id === id)))
      throw new UserError('包含不存在的任务');
    const job = orchestrator.start(
      session.id,
      body.mode || (body.failedOnly ? 'retry' : 'run'),
      '',
      body.taskIds,
    );
    return reply.code(202).send({ accepted: true, job });
  });
  app.post<{ Params: { id: string } }>('/api/sessions/:id/cancel', async (req) => {
    sessionFor(req.params.id);
    return { cancelled: orchestrator.cancel(req.params.id) };
  });
  app.post<{ Params: { id: string; runId: string } }>(
    '/api/sessions/:id/runs/:runId/input',
    async (req, reply) => {
      const { id, runId } = z
        .object({ id: z.string().uuid(), runId: z.string().uuid() })
        .parse(req.params);
      sessionFor(id);
      const body = z
        .object({ requestId: z.string().uuid(), value: z.string().trim().min(1).max(64) })
        .strict()
        .parse(req.body);
      orchestrator.submitInput(id, runId, body.requestId, body.value);
      return reply.code(202).send({ accepted: true });
    },
  );
  app.post<{ Params: { id: string } }>('/api/sessions/:id/tasks', async (req, reply) => {
    const session = sessionFor(req.params.id);
    assertIdle(session.id);
    const task: Task = {
      ...taskSchema.parse(req.body),
      id: randomUUID(),
      sessionId: session.id,
      source: 'manual',
      status: 'pending',
      createdAt: now(),
      revision: 1,
      enabled: true,
    };
    task.risk = task.steps.some((step) => ['aiAct', 'fill', 'click'].includes(step.action))
      ? 'write'
      : task.risk;
    validateDraft(task, session.targetUrl);
    return reply.code(201).send(store.put('tasks', task));
  });
  app.patch<{ Params: { id: string; taskId: string } }>(
    '/api/sessions/:id/tasks/:taskId',
    async (req) => {
      const session = sessionFor(req.params.id);
      assertIdle(session.id);
      const original = store.get('tasks', req.params.taskId);
      if (!original || original.sessionId !== session.id) throw new UserError('任务不存在', 404);
      const { expectedRevision, enabled, archived, ...definition } = taskDefinitionSchema
        .partial()
        .extend({
          expectedRevision: z.number().int().min(1).optional(),
          enabled: z.boolean().optional(),
          archived: z.boolean().optional(),
        })
        .strict()
        .parse(req.body);
      if (expectedRevision !== undefined && expectedRevision !== (original.revision || 1))
        throw new UserError('任务已被修改，请刷新后重新编辑', 409);
      const changed = Object.entries(definition).some(
        ([key, value]) => JSON.stringify(original[key as keyof Task]) !== JSON.stringify(value),
      );
      const next: Task = {
        ...original,
        ...definition,
        enabled: enabled ?? original.enabled ?? true,
        archived: archived ?? original.archived ?? false,
        archivedReason:
          archived === true ? 'user' : archived === false ? undefined : original.archivedReason,
        edited: original.edited || changed || archived === false,
        revision: (original.revision || 1) + (changed ? 1 : 0),
        updatedAt: now(),
        status: changed ? 'pending' : original.status,
      };
      if (definition.steps || definition.risk)
        next.risk = next.steps.some((step) => ['aiAct', 'fill', 'click'].includes(step.action))
          ? 'write'
          : definition.risk || 'read';
      if (changed || archived === false || enabled === true) validateDraft(next, session.targetUrl);
      return store.put('tasks', next);
    },
  );
  app.get<{ Params: { id: string } }>('/api/sessions/:id/report', async (req, reply) => {
    sessionFor(req.params.id);
    return reply
      .header('Content-Disposition', `attachment; filename="e2e-${req.params.id}.json"`)
      .send({ version: '1', exportedAt: now(), ...store.snapshot(req.params.id) });
  });
  registerDemo(app);
  await app.register(fastifyStatic, {
    root: artifactsDir,
    prefix: '/artifacts/',
    decorateReply: false,
    index: false,
    dotfiles: 'deny',
  });
  const dist = resolve('dist');
  if (existsSync(dist)) {
    await app.register(fastifyStatic, { root: dist, prefix: '/', index: 'index.html' });
  } else
    app.get('/', async (_, reply) =>
      reply
        .type('text/html')
        .send(
          '<p>开发界面：<a href="http://127.0.0.1:5173">http://127.0.0.1:5173</a>。生产模式先运行 npm run build。</p>',
        ),
    );
  app.addHook('onClose', async () => {
    await orchestrator.close();
    store.close();
  });
  return { app, store, orchestrator };
}

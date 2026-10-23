import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import {
  now,
  runnableTask,
  type Job,
  type JobMode,
  type Task,
  type Session,
  type RuntimeStatus,
} from '../shared/types.ts';
import { Store } from './store.ts';
import { discover, tasksFromPages } from './discovery.ts';
import { planWithModel, plannerConfigured, midsceneConfigured } from './planner.ts';
import {
  errorMessage,
  throwIfAborted,
  UserError,
  validateTask,
  testerArmyCompatible,
} from './policy.ts';
import { executeTask } from './executors.ts';
import { ManualInputs } from './manual-input.ts';
import { diagnose } from './diagnostics.ts';
import { classifyMessage } from '../shared/commands.ts';

interface Work {
  session: Session;
  job: Job;
  intent: string;
  selected: Task[];
}
export class Orchestrator {
  private inputs = new ManualInputs();
  private active?: {
    sessionId: string;
    jobId: string;
    controller: AbortController;
    promise: Promise<void>;
  };
  private queue: Work[] = [];
  private closing = false;
  constructor(
    private store: Store,
    private artifactsDir: string,
  ) {}
  isBusy(sessionId?: string) {
    return Boolean(
      (this.active && (!sessionId || this.active.sessionId === sessionId)) ||
      this.queue.some((work) => !sessionId || work.session.id === sessionId),
    );
  }
  runtime(): RuntimeStatus {
    return {
      active: this.active ? this.store.get('jobs', this.active.jobId) : undefined,
      queued: this.queue.map((work) => this.store.get('jobs', work.job.id)!),
    };
  }
  private updateJob(id: string, patch: Partial<Job>) {
    const job = this.store.get('jobs', id)!;
    const next = this.store.put('jobs', { ...job, ...patch, id });
    if (patch.status) this.store.updateSession(job.sessionId, { status: patch.status });
    return next;
  }
  private preflight(task: Task, session: Session) {
    validateTask(task, session.targetUrl, session.options.allowWrites);
    if (task.engine === 'midscene' && !midsceneConfigured())
      throw new UserError('Midscene 尚未配置，请配置视觉模型或编辑任务改用 Playwright');
    if (task.engine === 'tester-army' && !testerArmyCompatible(task.url))
      throw new UserError(
        '此 HTTP 目标不受 TesterArmy 上游支持。请编辑任务改用 Playwright；重新探索会自动选择兼容执行器。',
      );
  }
  start(sessionId: string, mode: JobMode, intent = '', taskIds?: string[]): Job {
    if (this.closing) throw new UserError('服务正在关闭，请稍后重试', 503);
    if (this.isBusy(sessionId))
      throw new UserError('此会话已有运行或排队中的作业，请等待完成或停止当前任务', 409);
    if (this.queue.length >= 20) throw new UserError('运行队列已满，请稍后提交', 409);
    const session = this.store.get('sessions', sessionId);
    if (!session) throw new UserError('会话不存在', 404);
    if (!session.targetUrl) throw new UserError('请先设置测试目标地址');
    const eligible = this.store.list('tasks', sessionId).filter(runnableTask);
    if (taskIds?.some((id) => !eligible.some((task) => task.id === id)))
      throw new UserError('包含不存在、已停用或已归档的任务');
    const selected = eligible.filter((task) =>
      taskIds
        ? taskIds.includes(task.id)
        : mode === 'retry'
          ? ['failed', 'cancelled'].includes(task.status)
          : mode === 'continue'
            ? ['pending', 'cancelled'].includes(task.status)
            : true,
    );
    if (['run', 'retry', 'continue'].includes(mode)) {
      if (!selected.length)
        throw new UserError(
          mode === 'continue'
            ? '没有未完成的任务。失败任务请使用“复跑失败任务”。'
            : '没有可执行的任务，请先探索站点或启用任务',
        );
      selected.forEach((task) => this.preflight(task, session));
    }
    const job = this.store.put('jobs', {
      id: randomUUID(),
      sessionId,
      mode,
      status: 'queued',
      taskIds: ['run', 'retry', 'continue'].includes(mode) ? selected.map((task) => task.id) : [],
      total: ['run', 'retry', 'continue'].includes(mode) ? selected.length : 0,
      completed: 0,
      passed: 0,
      failed: 0,
      cancelled: 0,
      createdAt: now(),
    });
    this.store.updateSession(sessionId, { status: 'queued' });
    this.queue.push({
      session,
      job,
      intent: ['plan', 'run', 'retry', 'continue'].includes(mode) ? session.goal || intent : intent,
      selected,
    });
    this.pump();
    return this.store.get('jobs', job.id)!;
  }
  private pump() {
    if (this.active || this.closing) return;
    const work = this.queue.shift();
    if (!work) return;
    const controller = new AbortController();
    this.updateJob(work.job.id, {
      status: ['auto', 'discover'].includes(work.job.mode)
        ? 'discovering'
        : work.job.mode === 'plan'
          ? 'planning'
          : 'running',
      startedAt: now(),
    });
    const promise = Promise.resolve()
      .then(() => this.work(work, controller.signal))
      .catch((error) => {
        const cancelled = controller.signal.aborted;
        this.updateJob(work.job.id, {
          status: cancelled ? 'cancelled' : 'failed',
          activeTaskId: undefined,
          finishedAt: now(),
          error: cancelled ? '操作已停止' : errorMessage(error).slice(0, 1000),
        });
        this.store.event(
          work.session.id,
          cancelled ? '操作已停止，可继续未完成任务' : errorMessage(error),
          cancelled ? 'info' : 'error',
          undefined,
          work.job.id,
        );
        this.store.message(
          work.session.id,
          'assistant',
          cancelled
            ? '已停止。已完成的结果与证据已保存，可选择“继续未完成”；中断任务将从头运行。'
            : `本次操作失败：${errorMessage(error)}`,
        );
      })
      .finally(() => {
        this.active = undefined;
        this.pump();
      });
    this.active = { sessionId: work.session.id, jobId: work.job.id, controller, promise };
  }
  private async work(work: Work, signal: AbortSignal) {
    const { session, job, intent } = work;
    const id = session.id;
    let selected = work.selected;
    const emit = (message: string, level: 'info' | 'success' | 'error' = 'info', runId?: string) =>
      this.store.event(id, message, level, runId, job.id);
    if (['discover', 'auto', 'plan'].includes(job.mode)) {
      let pages = job.mode === 'plan' ? this.store.list('pages', id) : [];
      if (!pages.length) {
        this.updateJob(job.id, { status: 'discovering' });
        emit(
          `开始探索 ${session.targetUrl}，最多 ${session.options.maxPages} 页 / ${session.options.maxDepth} 层`,
        );
        pages = await discover(session, this.artifactsDir, signal, (page) => {
          const previous = this.store.list('pages', id).find((p) => p.url === page.url);
          this.store.put('pages', { ...page, id: previous?.id || page.id });
          emit(
            `发现页面：${page.title || page.url}${page.error ? ` · ${page.error}` : ''}`,
            page.error ? 'error' : 'success',
          );
        });
      }
      throwIfAborted(signal);
      if (!pages.some((page) => page.status > 0))
        throw new UserError('未能访问任何页面，请检查目标地址、网络或浏览器安装');
      this.updateJob(job.id, { status: 'planning' });
      let tasks = tasksFromPages(session, pages);
      let note =
        '使用基于真实 DOM 的规则发现；配置规划模型后可增加结构化业务任务，视觉业务流程还需配置 Midscene。';
      let replaceSources: Task['source'][] = ['dom', 'model'];
      if (
        session.options.allowWrites &&
        /登录|login|sign.?in/i.test(intent) &&
        (!plannerConfigured() || !midsceneConfigured())
      )
        this.updateJob(job.id, {
          warning: !plannerConfigured()
            ? '尚未配置规划模型，本次仅使用 DOM 规则发现，不会自动填写登录。可以在任务编辑器创建 Playwright 登录任务。'
            : 'Midscene 尚未配置：可规划并执行结构化 Playwright 任务，但视觉操作与断言不可运行。自动填写登录需要配置 Midscene，或手动创建 Playwright 登录任务。',
        });
      if (plannerConfigured()) {
        emit('根据页面证据与会话目标规划结构化及视觉业务任务');
        try {
          const messages = this.store
            .list('messages', id)
            .filter(
              (message) =>
                message.role === 'user' &&
                message.content !== intent &&
                !['stop', 'status', 'help', 'retry', 'continue', 'run', 'plan'].includes(
                  classifyMessage(message.content),
                ),
            )
            .map((message) => message.content);
          const planned = await planWithModel(
            intent || session.goal || '',
            session,
            pages,
            signal,
            messages,
          );
          tasks = tasks.concat(planned);
          note = `模型规划新增 ${planned.length} 项结构化或视觉业务任务。`;
        } catch (error) {
          throwIfAborted(signal);
          replaceSources = ['dom'];
          emit(`模型规划失败：${errorMessage(error)}`, 'error');
          note =
            '模型规划未完成，旧模型任务已保留，本次仅使用新发现的 DOM 任务。请查看日志后重新规划。';
          this.updateJob(job.id, { warning: note });
        }
      }
      tasks.forEach((task) => validateTask(task, session.targetUrl, session.options.allowWrites));
      throwIfAborted(signal);
      selected = this.store.reconcileTasks(id, tasks, job.id, replaceSources).filter(runnableTask);
      this.updateJob(job.id, { taskIds: selected.map((task) => task.id), total: selected.length });
      if (
        !session.options.allowWrites &&
        pages.some((page) => page.inputs?.some((input) => input.type === 'password'))
      )
        note += ' 当前为只读模式：不会填写账号密码或提交登录；请开启交互后重新规划登录。';
      if (tasks.some((task) => task.engineNote))
        note += ' 已为不兼容的 HTTP 目标选择 Playwright，执行器原因见任务详情。';
      this.store.message(
        id,
        'assistant',
        `规划完成：观察到 ${pages.length} 个页面，生成 ${selected.length} 个可用任务；旧的自动任务已归档，手工及已编辑任务保留。${note}${job.mode === 'auto' ? '现在开始执行本次规划。' : '可先编辑、选择任务后运行。'}`,
      );
      if (job.mode !== 'auto') {
        this.updateJob(job.id, { status: 'completed', finishedAt: now() });
        return;
      }
    }
    this.updateJob(job.id, { status: 'running' });
    for (const task of selected) {
      throwIfAborted(signal);
      this.preflight(task, session);
      const run = this.store.put('runs', {
        id: randomUUID(),
        sessionId: id,
        jobId: job.id,
        taskId: task.id,
        taskRevision: task.revision || 1,
        taskSnapshot: { ...task },
        engine: task.engine,
        status: 'running',
        startedAt: now(),
      });
      this.store.put('tasks', { ...task, status: 'running' });
      this.updateJob(job.id, {
        activeTaskId: task.id,
        currentStep: 0,
        stepCount: task.steps.length,
      });
      emit(`开始：${task.title} · ${task.engine}`, 'info', run.id);
      const started = Date.now();
      try {
        const evidence = await executeTask(
          task,
          session,
          run.id,
          join(this.artifactsDir, id, run.id),
          signal,
          (message) => {
            const step = message.match(/^步骤 (\d+)\/(\d+)/);
            if (step)
              this.updateJob(job.id, { currentStep: Number(step[1]), stepCount: Number(step[2]) });
            emit(message, 'info', run.id);
          },
          (challenge) =>
            this.inputs.wait(id, run.id, challenge, signal, (pendingInput) => {
              const status = pendingInput ? 'waiting_input' : 'running';
              this.updateJob(job.id, { status });
              this.store.put('tasks', { ...task, status });
              this.store.put('runs', {
                ...run,
                status,
                pendingInput,
                actualUrl: challenge.actualUrl,
              });
              if (pendingInput) {
                emit(
                  `等待手动输入图形验证码（第 ${challenge.attempt}/3 次，5 分钟内有效）`,
                  'info',
                  run.id,
                );
                this.store.message(
                  id,
                  'assistant',
                  '任务已暂停并保留当前浏览器会话。请在验证码卡片输入并提交后继续；也可停止任务。',
                );
              } else emit('验证码等待已结束', 'info', run.id);
            }),
        );
        throwIfAborted(signal);
        this.store.put('runs', {
          ...run,
          ...evidence,
          status: 'passed',
          finishedAt: now(),
          durationMs: Date.now() - started,
        });
        this.store.put('tasks', { ...task, status: 'passed' });
        const current = this.store.get('jobs', job.id)!;
        this.updateJob(job.id, { completed: current.completed + 1, passed: current.passed + 1 });
        emit(`通过：${task.title}`, 'success', run.id);
      } catch (error) {
        const cancelled = signal.aborted;
        const evidence =
          error && typeof error === 'object' && 'evidence' in error
            ? (error.evidence as Partial<import('../shared/types.ts').Run>)
            : {};
        const message = errorMessage(error).slice(0, 4000);
        this.store.put('runs', {
          ...run,
          ...evidence,
          status: cancelled ? 'cancelled' : 'failed',
          finishedAt: now(),
          durationMs: Date.now() - started,
          error: message,
          diagnosis: diagnose(message, evidence.failureCode),
        });
        this.store.put('tasks', { ...task, status: cancelled ? 'cancelled' : 'failed' });
        const current = this.store.get('jobs', job.id)!;
        this.updateJob(job.id, {
          completed: current.completed + 1,
          failed: current.failed + (cancelled ? 0 : 1),
          cancelled: current.cancelled + (cancelled ? 1 : 0),
        });
        emit(
          `${cancelled ? '停止' : '失败'}：${task.title} · ${message.slice(0, 500)}`,
          cancelled ? 'info' : 'error',
          run.id,
        );
        throwIfAborted(signal);
      }
    }
    const result = this.updateJob(job.id, {
      status: 'completed',
      activeTaskId: undefined,
      currentStep: undefined,
      finishedAt: now(),
    });
    this.store.message(
      id,
      'assistant',
      `本次运行完成：${result.passed} 项通过，${result.failed} 项失败，${result.cancelled} 项中断，共 ${result.total} 项。${result.failed ? '选择失败任务查看诊断和证据，可直接编辑或复跑失败任务。' : '结果与历史证据已保存。'}`,
    );
  }
  cancel(sessionId: string) {
    const index = this.queue.findIndex((work) => work.session.id === sessionId);
    if (index >= 0) {
      const [work] = this.queue.splice(index, 1);
      this.updateJob(work.job.id, {
        status: 'cancelled',
        finishedAt: now(),
        error: '已取消排队，未执行任何任务',
      });
      return true;
    }
    if (this.active?.sessionId === sessionId) {
      this.active.controller.abort();
      return true;
    }
    return false;
  }
  submitInput(sessionId: string, runId: string, requestId: string, value: string) {
    if (this.active?.sessionId !== sessionId || this.active.controller.signal.aborted)
      throw new UserError('任务已停止或验证码请求已失效', 409);
    this.inputs.submit(sessionId, runId, requestId, value);
  }
  async waitForIdle() {
    while (this.active || this.queue.length) {
      if (this.active) await this.active.promise;
      else this.pump();
    }
  }
  async close() {
    this.closing = true;
    for (const work of [...this.queue]) this.cancel(work.session.id);
    this.active?.controller.abort();
    await this.active?.promise;
  }
}

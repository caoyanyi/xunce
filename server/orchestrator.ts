import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { now, type Task, type Session } from '../shared/types.ts';
import { Store } from './store.ts';
import { discover, tasksFromPages } from './discovery.ts';
import { planWithModel, plannerConfigured, midsceneConfigured } from './planner.ts';
import { errorMessage, throwIfAborted, UserError, validateTask } from './policy.ts';
import { executeTask } from './executors.ts';
import { ManualInputs } from './manual-input.ts';

export class Orchestrator {
  private inputs = new ManualInputs();
  private active?: { sessionId: string; controller: AbortController; promise: Promise<void> };
  constructor(
    private store: Store,
    private artifactsDir: string,
  ) {}
  isBusy(sessionId?: string) {
    return Boolean(this.active && (!sessionId || this.active.sessionId === sessionId));
  }
  start(
    sessionId: string,
    mode: 'discover' | 'auto' | 'run' | 'retry',
    intent = '',
    taskIds?: string[],
  ) {
    if (this.active) throw new UserError('已有任务在运行，请等待完成或停止当前任务', 409);
    const session = this.store.get('sessions', sessionId);
    if (!session) throw new UserError('会话不存在', 404);
    if (!session.targetUrl) throw new UserError('请先设置测试目标地址');
    const selected = this.store
      .list('tasks', sessionId)
      .filter((task) =>
        taskIds
          ? taskIds.includes(task.id)
          : mode === 'retry'
            ? task.status === 'failed' || task.status === 'cancelled'
            : true,
      );
    if (['run', 'retry'].includes(mode) && selected.length === 0)
      throw new UserError('没有可执行的任务，请先探索站点');
    const controller = new AbortController();
    this.store.updateSession(sessionId, {
      status: mode === 'discover' || mode === 'auto' ? 'discovering' : 'running',
    });
    // Schedule only after the active slot has been installed, so synchronous failures cannot leave a stale lock.
    const promise = Promise.resolve()
      .then(() => this.work(session, mode, intent, selected, controller.signal))
      .catch((error) => {
        const cancelled = controller.signal.aborted;
        this.store.updateSession(sessionId, { status: cancelled ? 'cancelled' : 'failed' });
        this.store.event(
          sessionId,
          cancelled ? '操作已停止' : errorMessage(error),
          cancelled ? 'info' : 'error',
        );
        this.store.message(
          sessionId,
          'assistant',
          cancelled
            ? '已停止。已完成的结果与证据已保存，可继续运行。'
            : `本次操作失败：${errorMessage(error)}`,
        );
      })
      .finally(() => {
        this.active = undefined;
      });
    this.active = { sessionId, controller, promise };
  }
  private async work(
    session: Session,
    mode: 'discover' | 'auto' | 'run' | 'retry',
    intent: string,
    selected: Task[],
    signal: AbortSignal,
  ) {
    const id = session.id;
    if (mode === 'discover' || mode === 'auto') {
      this.store.event(
        id,
        `开始探索 ${session.targetUrl}，最多 ${session.options.maxPages} 页 / ${session.options.maxDepth} 层`,
      );
      const pages = await discover(session, this.artifactsDir, signal, (page) => {
        const previous = this.store.list('pages', id).find((p) => p.url === page.url);
        this.store.put('pages', { ...page, id: previous?.id || page.id });
        this.store.event(
          id,
          `发现页面：${page.title || page.url}${page.error ? ` · ${page.error}` : ''}`,
          page.error ? 'error' : 'success',
        );
      });
      throwIfAborted(signal);
      if (!pages.some((p) => p.status > 0))
        throw new UserError('未能访问任何页面，请检查目标地址、网络或浏览器安装');
      let tasks = tasksFromPages(session, pages);
      let planningNote =
        '当前使用基于真实 DOM 的规则发现；配置规划模型与 Midscene 后可增加视觉业务流程。';
      if (plannerConfigured() && midsceneConfigured()) {
        this.store.event(id, '根据页面证据与对话目标规划视觉业务任务');
        try {
          const visualTasks = await planWithModel(intent, session, pages, signal);
          tasks = tasks.concat(visualTasks);
          planningNote = `模型规划新增 ${visualTasks.length} 项视觉业务任务。`;
        } catch (error) {
          throwIfAborted(signal);
          this.store.event(id, `模型规划不可用，保留 DOM 任务：${errorMessage(error)}`, 'error');
          planningNote = '模型业务规划未完成，当前保留 DOM 基础任务。详情见执行日志。';
        }
      }
      const existing = this.store.list('tasks', id);
      selected = tasks.map((task) => {
        const previous = existing.find(
          (t) =>
            t.url === task.url &&
            t.kind === task.kind &&
            t.title === task.title &&
            t.source === task.source,
        );
        return this.store.put('tasks', { ...task, id: previous?.id || task.id });
      });
      this.store.message(
        id,
        'assistant',
        `探索完成：观察到 ${pages.length} 个页面，生成 ${selected.length} 个可验证任务。${planningNote}${mode === 'auto' ? '现在开始逐项执行。' : '可选择任务或直接运行全部。'}`,
      );
      if (mode === 'discover') {
        this.store.updateSession(id, { status: 'completed' });
        return;
      }
    }
    this.store.updateSession(id, { status: 'running' });
    for (const task of selected) {
      throwIfAborted(signal);
      validateTask(task, session.targetUrl, session.options.allowWrites);
      const run = this.store.put('runs', {
        id: randomUUID(),
        sessionId: id,
        taskId: task.id,
        engine: task.engine,
        status: 'running',
        startedAt: now(),
      });
      this.store.put('tasks', { ...task, status: 'running' });
      this.store.event(id, `开始：${task.title} · ${task.engine}`, 'info', run.id);
      const started = Date.now();
      try {
        const evidence = await executeTask(
          task,
          session,
          run.id,
          join(this.artifactsDir, id, run.id),
          signal,
          (message) => this.store.event(id, message, 'info', run.id),
          (challenge) =>
            this.inputs.wait(id, run.id, challenge, signal, (pendingInput) => {
              const status = pendingInput ? 'waiting_input' : 'running';
              this.store.updateSession(id, { status });
              this.store.put('tasks', { ...task, status });
              this.store.put('runs', {
                ...run,
                status,
                pendingInput,
                actualUrl: challenge.actualUrl,
              });
              if (pendingInput) {
                this.store.event(
                  id,
                  `等待手动输入图形验证码（第 ${challenge.attempt}/3 次，5 分钟内有效）`,
                  'info',
                  run.id,
                );
                this.store.message(
                  id,
                  'assistant',
                  '任务已暂停并保留当前浏览器会话。请在验证码卡片查看截图、输入验证码并提交；提交后继续验证。也可停止任务。',
                );
              } else {
                this.store.event(id, '验证码等待已结束', 'info', run.id);
              }
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
        this.store.event(id, `通过：${task.title}`, 'success', run.id);
      } catch (error) {
        const cancelled = signal.aborted;
        const evidence =
          error && typeof error === 'object' && 'evidence' in error
            ? (error.evidence as object)
            : {};
        this.store.put('runs', {
          ...run,
          ...evidence,
          status: cancelled ? 'cancelled' : 'failed',
          finishedAt: now(),
          durationMs: Date.now() - started,
          error: errorMessage(error).slice(0, 4000),
        });
        this.store.put('tasks', { ...task, status: cancelled ? 'cancelled' : 'failed' });
        this.store.event(
          id,
          `${cancelled ? '停止' : '失败'}：${task.title} · ${errorMessage(error).slice(0, 500)}`,
          cancelled ? 'info' : 'error',
          run.id,
        );
        throwIfAborted(signal);
      }
    }
    const tasks = this.store.list('tasks', id);
    const passed = tasks.filter((t) => t.status === 'passed').length;
    const failed = tasks.filter((t) => t.status === 'failed').length;
    this.store.updateSession(id, { status: 'completed' });
    this.store.message(
      id,
      'assistant',
      `执行完成。本会话任务：${passed} 项通过，${failed} 项失败，${tasks.length - passed - failed} 项未完成。${failed ? '选择失败任务查看错误和截图，或发送“复跑失败任务”。' : '可在任务详情查看步骤、截图和执行记录。'}`,
    );
  }
  cancel(sessionId: string) {
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
    await this.active?.promise;
  }
  async close() {
    this.active?.controller.abort();
    await this.waitForIdle();
  }
}

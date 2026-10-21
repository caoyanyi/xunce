import { randomUUID } from 'node:crypto';
import type { CaptchaChallenge, InputRequest } from '../shared/types.ts';
import { UserError } from './policy.ts';

// Responses live only in the waiting promise; never put them in messages or records.
export class ManualInputs {
  private pending?: {
    sessionId: string;
    runId: string;
    request: InputRequest;
    resolve: (value: string) => void;
  };
  async wait(
    sessionId: string,
    runId: string,
    challenge: CaptchaChallenge,
    signal: AbortSignal,
    publish: (request: InputRequest | undefined) => void,
    timeoutMs = 300000,
  ): Promise<string> {
    signal.throwIfAborted();
    if (this.pending) throw new UserError('已有验证码等待输入', 409);
    const request: InputRequest = {
      ...challenge,
      id: randomUUID(),
      type: 'image_captcha',
      expiresAt: new Date(Date.now() + timeoutMs).toISOString(),
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    try {
      return await new Promise<string>((resolve, reject) => {
        abort = () => reject(signal.reason);
        signal.addEventListener('abort', abort, { once: true });
        timer = setTimeout(
          () => reject(new UserError('等待验证码超时，请重新运行任务')),
          timeoutMs,
        );
        this.pending = { sessionId, runId, request, resolve };
        publish(request);
      });
    } finally {
      clearTimeout(timer);
      if (abort) signal.removeEventListener('abort', abort);
      this.pending = undefined;
      publish(undefined);
    }
  }
  submit(sessionId: string, runId: string, requestId: string, value: string) {
    const pending = this.pending;
    if (
      !pending ||
      pending.sessionId !== sessionId ||
      pending.runId !== runId ||
      pending.request.id !== requestId ||
      Date.now() >= Date.parse(pending.request.expiresAt)
    )
      throw new UserError('验证码请求已失效或不属于此任务，请刷新页面查看当前请求', 409);
    // Consume synchronously: two HTTP submissions cannot resume the same wait twice.
    this.pending = undefined;
    pending.resolve(value);
  }
}

// Human response time has its own TTL and does not spend the browser execution budget.
export class ExecutionBudget {
  private controller = new AbortController();
  readonly signal: AbortSignal;
  private timer?: ReturnType<typeof setTimeout>;
  private remaining: number;
  private started = 0;
  constructor(signal: AbortSignal, durationMs = 120000) {
    this.signal = AbortSignal.any([signal, this.controller.signal]);
    this.remaining = durationMs;
    this.resume();
  }
  pause() {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.remaining -= Date.now() - this.started;
  }
  resume() {
    if (this.timer || this.signal.aborted) return;
    this.started = Date.now();
    this.timer = setTimeout(() => this.controller.abort(), Math.max(0, this.remaining));
  }
  close() {
    clearTimeout(this.timer);
  }
}

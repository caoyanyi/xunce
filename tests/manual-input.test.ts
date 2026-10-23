import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExecutionBudget, ManualInputs } from '../server/manual-input.ts';
import type { InputRequest } from '../shared/types.ts';

afterEach(() => vi.useRealTimers());
const challenge = {
  screenshot: '/artifacts/fixture.png',
  actualUrl: 'https://test.example/login',
  attempt: 1,
};
describe('human input lifecycle', () => {
  it('consumes a response once and rejects wrong sessions, runs and request IDs', async () => {
    const inputs = new ManualInputs();
    const published: (InputRequest | undefined)[] = [];
    const wait = inputs.wait('session', 'run', challenge, new AbortController().signal, (r) =>
      published.push(r),
    );
    const id = published[0]!.id;
    expect(() => inputs.submit('other', 'run', id, 'code')).toThrow('失效');
    expect(() => inputs.submit('session', 'other', id, 'code')).toThrow('失效');
    expect(() => inputs.submit('session', 'run', 'old-id', 'code')).toThrow('失效');
    inputs.submit('session', 'run', id, 'human-response');
    expect(() => inputs.submit('session', 'run', id, 'duplicate')).toThrow('失效');
    await expect(wait).resolves.toBe('human-response');
    expect(published.at(-1)).toBeUndefined();
    expect(JSON.stringify(published)).not.toContain('human-response');
  });
  it('expires pending input and clears metadata', async () => {
    vi.useFakeTimers();
    const inputs = new ManualInputs();
    const publish = vi.fn();
    const wait = inputs.wait('s', 'r', challenge, new AbortController().signal, publish, 100);
    const rejected = expect(wait).rejects.toThrow('超时');
    await vi.advanceTimersByTimeAsync(101);
    await rejected;
    expect(publish).toHaveBeenLastCalledWith(undefined);
    expect(() => inputs.submit('s', 'r', publish.mock.calls[0][0].id, 'late')).toThrow('失效');
  });
  it('aborts an outstanding wait immediately and releases it for another run', async () => {
    const inputs = new ManualInputs();
    const controller = new AbortController();
    const publish = vi.fn();
    const wait = inputs.wait('s', 'r', challenge, controller.signal, publish);
    controller.abort();
    await expect(wait).rejects.toBeDefined();
    expect(publish).toHaveBeenLastCalledWith(undefined);
    const second = inputs.wait('s', 'r2', challenge, new AbortController().signal, publish);
    inputs.submit('s', 'r2', publish.mock.calls.at(-1)![0].id, 'code');
    await expect(second).resolves.toBe('code');
  });
  it('keeps ownership until a submitted wait finishes cleanup', async () => {
    vi.useFakeTimers();
    const inputs = new ManualInputs();
    const publish = vi.fn();
    const wait = inputs.wait('s', 'r', challenge, new AbortController().signal, publish);
    inputs.submit('s', 'r', publish.mock.calls[0][0].id, 'first-response');

    // A new call in the same turn must not be accepted and then erased by the old finally.
    const nextPublish = vi.fn();
    const overlapping = inputs
      .wait('s', 'r2', challenge, new AbortController().signal, nextPublish, 100)
      .catch((error: Error) => error);
    await expect(wait).resolves.toBe('first-response');
    await vi.advanceTimersByTimeAsync(101);
    expect(await overlapping).toMatchObject({ message: '已有验证码等待输入' });
    expect(nextPublish).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);

    const next = inputs.wait('s', 'r2', challenge, new AbortController().signal, nextPublish);
    inputs.submit('s', 'r2', nextPublish.mock.calls[0][0].id, 'second-response');
    await expect(next).resolves.toBe('second-response');
  });
  it('rejects submission immediately after abort, before promise cleanup runs', async () => {
    const inputs = new ManualInputs();
    const controller = new AbortController();
    const publish = vi.fn();
    const wait = inputs.wait('s', 'r', challenge, controller.signal, publish);
    const rejected = expect(wait).rejects.toBeDefined();
    controller.abort();
    expect(() => inputs.submit('s', 'r', publish.mock.calls[0][0].id, 'late')).toThrow('失效');
    await rejected;
    expect(publish).toHaveBeenLastCalledWith(undefined);
  });
  it('rejects a concurrent wait without clearing the current request', async () => {
    const inputs = new ManualInputs();
    const publish = vi.fn();
    const wait = inputs.wait('s', 'r', challenge, new AbortController().signal, publish);
    const otherPublish = vi.fn();
    await expect(
      inputs.wait('s', 'other', challenge, new AbortController().signal, otherPublish),
    ).rejects.toThrow('已有验证码等待输入');
    expect(otherPublish).not.toHaveBeenCalled();
    expect(publish).toHaveBeenCalledTimes(1);
    inputs.submit('s', 'r', publish.mock.calls[0][0].id, 'code');
    await expect(wait).resolves.toBe('code');
  });
  it('does not publish or allocate timers when already aborted', async () => {
    vi.useFakeTimers();
    const inputs = new ManualInputs();
    const controller = new AbortController();
    controller.abort();
    const publish = vi.fn();
    await expect(inputs.wait('s', 'r', challenge, controller.signal, publish)).rejects.toBe(
      controller.signal.reason,
    );
    expect(publish).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('rejects an expired response even before the timeout callback runs', async () => {
    vi.useFakeTimers();
    const inputs = new ManualInputs();
    const controller = new AbortController();
    const publish = vi.fn();
    const wait = inputs.wait('s', 'r', challenge, controller.signal, publish, 100);
    const request = publish.mock.calls[0][0] as InputRequest;
    vi.setSystemTime(Date.parse(request.expiresAt));
    expect(() => inputs.submit('s', 'r', request.id, 'late')).toThrow('失效');
    controller.abort();
    await expect(wait).rejects.toBe(controller.signal.reason);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('excludes manual waiting from the total active execution budget', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const budget = new ExecutionBudget(controller.signal, 100);
    await vi.advanceTimersByTimeAsync(40);
    budget.pause();
    await vi.advanceTimersByTimeAsync(300000);
    expect(budget.signal.aborted).toBe(false);
    budget.resume();
    await vi.advanceTimersByTimeAsync(59);
    expect(budget.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    expect(budget.signal.aborted).toBe(true);
    budget.close();
  });
  it('still forwards cancellation during a paused budget', () => {
    const controller = new AbortController();
    const budget = new ExecutionBudget(controller.signal);
    budget.pause();
    controller.abort();
    expect(budget.signal.aborted).toBe(true);
    budget.close();
  });
});

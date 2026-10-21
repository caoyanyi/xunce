import type { Task } from '../shared/types.ts';
import { stepSchema } from '../shared/types.ts';

export class UserError extends Error {
  constructor(
    message: string,
    public statusCode = 400,
  ) {
    super(message);
  }
}
const dangerousPath =
  /(?:^|[\W_])(logout|signout|delete|destroy|remove|unsubscribe|purchase|checkout|pay|登出|退出|删除|支付|购买)(?:[\W_]|$)/i;
export function targetUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new UserError('请输入完整的 http:// 或 https:// 地址');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new UserError('目标只支持 HTTP(S)');
  if (url.username || url.password) throw new UserError('目标地址不能包含凭据');
  if (['169.254.169.254', 'metadata.google.internal'].includes(url.hostname))
    throw new UserError('不允许云元数据地址');
  url.hash = '';
  return url.href;
}
export function inScope(input: string, origin: string): boolean {
  try {
    const url = new URL(targetUrl(input));
    return url.origin === new URL(origin).origin;
  } catch {
    return false;
  }
}
export function isSafeNavigation(input: string): boolean {
  try {
    const url = new URL(input);
    return !dangerousPath.test(decodeURIComponent(url.pathname + url.search));
  } catch {
    return false;
  }
}
export function validateTask(task: Task, origin: string, allowWrites: boolean) {
  if (!inScope(task.url, origin)) throw new UserError('任务地址超出目标站点');
  if (task.steps.length === 0 || task.steps.length > 30)
    throw new UserError('任务步骤数必须在 1–30 之间');
  for (const raw of task.steps) {
    const step = stepSchema.parse(raw);
    if (['aiAct', 'aiAssert'].includes(step.action) && task.engine !== 'midscene')
      throw new UserError('视觉步骤必须使用 Midscene 执行器');
    if (
      task.engine === 'tester-army' &&
      ['validateForm', 'fill', 'click', 'navigateLink'].includes(step.action)
    )
      throw new UserError('此步骤请使用 Playwright 或 Midscene 执行器');
    if (
      (step.action === 'goto' ||
        step.action === 'assertUrl' ||
        step.action === 'assertLink' ||
        step.action === 'navigateLink') &&
      !inScope(step.url, origin)
    )
      throw new UserError('步骤地址超出目标站点');
    if (
      !allowWrites &&
      (step.action === 'goto' || step.action === 'navigateLink') &&
      !isSafeNavigation(step.url)
    )
      throw new UserError('该路径可能修改状态，请启用写操作后执行');
    if (!allowWrites && ['click', 'fill', 'aiAct'].includes(step.action))
      throw new UserError('交互任务需要启用写操作');
  }
  if (task.risk === 'write' && !allowWrites) throw new UserError('该任务需要启用写操作');
}
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
export function throwIfAborted(signal: AbortSignal) {
  if (signal.aborted) throw new UserError('操作已停止', 409);
}

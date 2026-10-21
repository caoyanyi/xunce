import type { SessionStatus, Task } from './types.ts';

export const busyStatuses: string[] = [
  'queued',
  'discovering',
  'planning',
  'running',
  'waiting_input',
];
export const statusLabels: Record<SessionStatus, string> = {
  idle: '准备就绪',
  queued: '排队中',
  discovering: '正在探索',
  planning: '正在规划',
  running: '正在执行',
  waiting_input: '等待验证码',
  completed: '已完成',
  failed: '失败',
  cancelled: '已停止',
};
export const runnableTask = (task: Task) => !task.archived && task.enabled !== false;

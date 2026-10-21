import { describe, expect, it } from 'vitest';
import { allowedWhileBusy, classifyMessage } from '../shared/commands.ts';
describe('conversation intent routing', () => {
  it.each([
    ['自动发现任务并执行', 'auto'],
    ['探索登录页面并自动运行', 'auto'],
    ['只探索站点并发现任务', 'discover'],
    ['发现任务', 'discover'],
    ['运行全部任务', 'run'],
    ['复跑失败任务', 'retry'],
    ['帮我重跑失败任务', 'retry'],
    ['有哪些失败任务？', 'status'],
    ['查看失败任务', 'status'],
    ['状态', 'status'],
    ['停止', 'stop'],
    ['取消探索', 'stop'],
    ['你能做什么？', 'help'],
  ])('%s → %s', (message, command) => {
    expect(classifyMessage(message)).toBe(command);
  });
  it('allows informational questions during a job without treating them as rerun approval', () => {
    expect(allowedWhileBusy('有哪些失败任务？')).toBe(true);
    expect(allowedWhileBusy('停止')).toBe(true);
    expect(allowedWhileBusy('复跑失败任务')).toBe(false);
    expect(allowedWhileBusy('测试登录')).toBe(false);
  });
});

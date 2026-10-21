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
    ['为什么登录失败？', 'explain'],
    ['验证码应该怎么填？', 'explain'],
    ['如何使用验证码？', 'explain'],
    ['继续未完成任务', 'continue'],
    ['继续执行', 'continue'],
    ['重新规划登录测试', 'plan'],
    ['重新规划并执行登录测试', 'auto'],
    ['你好', 'explain'],
    ['又失败了', 'explain'],
    ['验证码在哪里', 'explain'],
    ['检查登录是否成功？', 'auto'],
    ['继续', 'continue'],
    ['再测一次', 'run'],
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

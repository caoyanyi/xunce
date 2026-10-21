import type { Diagnosis, Run, Snapshot } from '../shared/types.ts';

export function diagnose(message: string, code?: Run['failureCode']): Diagnosis {
  if (code === 'captcha_required')
    return {
      title: '验证码步骤未完成',
      advice:
        '在验证码卡片中输入当前图片中的验证码。若已超时，重新运行本任务；在自己的浏览器登录不会传入测试浏览器。',
    };
  if (code === 'page_not_ready')
    return {
      title: '页面尚未加载就绪',
      advice: '检查目标地址和资源请求是否正常，查看截图及实际 URL；页面稳定后只复跑当前任务。',
    };
  if (/HTTP\s+[45]\d\d/.test(message))
    return {
      title: '目标服务返回错误',
      advice: '查看 HTTP 状态和目标页面。确认被测服务恢复后，复跑失败任务。',
    };
  if (/未配置|配置|API_KEY/.test(message))
    return {
      title: '执行器配置不完整',
      advice: '检查模型配置，或将确定性任务的执行器改为 Playwright 后运行。',
    };
  if (/URL 不匹配|waitForURL/.test(message))
    return {
      title: '页面地址未达到预期',
      advice: '比较实际 URL 与断言地址，确认自动跳转和登录是否完成；可编辑任务修正错误预期。',
    };
  if (/Timeout|超时|执行预算|timed out/i.test(message))
    return {
      title: '等待操作超时',
      advice:
        '查看失败步骤和截图，检查页面加载或定位条件；修订任务后再运行，避免直接重复提交写操作。',
    };
  if (/Assertion failed|断言|不存在|不可见|为空/.test(message))
    return {
      title: '页面未满足验证条件',
      advice:
        '根据截图确认是页面缺陷还是测试预期/定位不准确。可编辑当前任务，无需重新探索整个站点。',
    };
  if (/停止|中断|abort|closed|关闭/i.test(message))
    return {
      title: '执行已中断',
      advice: '已完成的记录会保留。使用“继续未完成”运行待执行或已中断的任务。',
    };
  return {
    title: '任务执行失败',
    advice: '查看失败步骤、截图和原始错误；修订当前任务或重新规划后再运行。',
  };
}

export function explain(
  snapshot: Snapshot,
  question: string,
  models: { planner: boolean; midscene: boolean },
): string {
  const pending = snapshot.runs.find((run) => run.pendingInput && run.status === 'waiting_input');
  if (/验证码|captcha/i.test(question) || pending)
    return pending
      ? '当前任务正在等待验证码。请查看工作台的验证码截图，在输入框填写后点击“提交并继续”。等待期间保留原登录会话；普通聊天不会代替验证码提交。'
      : '图形验证码会在交互任务受阻时显示输入卡片，手动输入后继续。平台不识别或猜测验证码；只读任务不会执行登录操作。';
  if (/登录|login|sign.?in/i.test(question))
    return !snapshot.session.options.allowWrites
      ? '当前会话未允许交互，因此只能验证登录界面。请开启“允许交互与写操作”，再重新规划登录任务；复跑旧的只读任务不会增加登录动作。'
      : !models.planner || !models.midscene
        ? '已经允许交互，但自动登录规划需要同时配置规划模型和 Midscene。也可以新建 Playwright 任务，填写账号、提交登录并添加结果断言。'
        : '已允许登录交互，且模型已配置。请提供测试账号并描述登录目标；同一个任务中需要包含填写、提交和登录结果断言。每个任务使用隔离浏览器，验证码受阻时会提示手动输入。';
  const failed = snapshot.runs.filter((run) => run.status === 'failed').at(-1);
  if (failed) {
    const detail = failed.diagnosis || diagnose(failed.error || '', failed.failureCode);
    return `最近一次失败：${detail.title}。${detail.advice} 可在任务详情查看原始证据；这条提问没有启动新测试。`;
  }
  return '可以描述测试目标来探索并执行，或使用“只探索”“重新规划”“继续未完成”“复跑失败任务”。也可以在任务列表新建、编辑、停用或归档任务。本次提问不会启动浏览器或模型请求。';
}

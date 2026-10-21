export type ChatCommand = 'stop' | 'status' | 'help' | 'retry' | 'discover' | 'run' | 'auto';

export function classifyMessage(message: string): ChatCommand {
  const text = message.trim();
  if (/^(停止|取消|stop|cancel)(任务|执行|探索)?[。！!]?$/i.test(text)) return 'stop';
  if (
    /^(状态|进度|status|progress|report)[？?。]?$/i.test(text) ||
    /^(?:查看|列出|展示)?(?:有哪些)?(?:失败任务|问题|测试结果|报告|结果)[？?。]?$/.test(text)
  )
    return 'status';
  if (/^(帮助|help|你能做什么|怎么使用)[？?。]?$/i.test(text)) return 'help';
  if (/^(?:请|帮我|麻烦)?(?:复跑|重跑|重新执行|retry|rerun)/i.test(text)) return 'retry';
  if (/只探索|仅探索|只发现|仅发现|discover only|^(?:请)?发现任务[。！!]?$/i.test(text))
    return 'discover';
  if (/^(运行|执行)(全部|所有)?(任务)?[。！!]?$/i.test(text)) return 'run';
  return 'auto';
}

export const allowedWhileBusy = (message: string) =>
  ['stop', 'status', 'help'].includes(classifyMessage(message));

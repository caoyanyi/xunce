export type ChatCommand =
  | 'stop'
  | 'status'
  | 'help'
  | 'explain'
  | 'retry'
  | 'continue'
  | 'plan'
  | 'discover'
  | 'run'
  | 'auto';

export function classifyMessage(message: string): ChatCommand {
  const text = message.trim();
  if (/^(停止|取消|stop|cancel)(任务|执行|探索)?[。！!]?$/i.test(text)) return 'stop';
  if (
    /^(状态|进度|status|progress|report)[？?。]?$/i.test(text) ||
    /^(?:查看|列出|展示)?(?:有哪些)?(?:失败任务|问题|测试结果|报告|结果)[？?。]?$/.test(text)
  )
    return 'status';
  if (/^(帮助|help|你能做什么|怎么使用)[？?。]?$/i.test(text)) return 'help';
  if (/^(?:继续|恢复)[。！!]?$/i.test(text)) return 'continue';
  if (/^(?:再测一次|再跑一次|再运行一次)[。！!]?$/i.test(text)) return 'run';
  if (
    /^(?:请|帮我)?(?:继续|恢复)(?:运行|执行|测试|任务|未完成)|^(?:continue|resume)(?:\s|$)/i.test(
      text,
    )
  )
    return 'continue';
  if (
    /(?:重新规划|重新生成|replan)/i.test(text) &&
    !/(?:并|然后)(?:自动)?(?:执行|运行|测试)/.test(text)
  )
    return 'plan';
  if (/^(?:请|帮我|麻烦)?(?:复跑|重跑|重新执行|retry|rerun)/i.test(text)) return 'retry';
  if (/只探索|仅探索|只发现|仅发现|discover only|^(?:请)?发现任务[。！!]?$/i.test(text))
    return 'discover';
  if (/^(运行|执行)(全部|所有)?(任务)?[。！!]?$/i.test(text)) return 'run';
  if (
    /^(?:为什么|为何|怎么|如何|什么是|是什么|能否|是否支持|支持什么|where|why|how|what|can you explain)/i.test(
      text,
    ) ||
    (/[？?]$/.test(text) && !/(?:测试|检查|探索|执行|运行|test|check|explore|run)/i.test(text))
  )
    return 'explain';
  if (
    /(?:怎么|如何|为什么|原因|失败了|不会|不好用|在哪|是什么)/.test(text) &&
    !/^(?:请|帮我)?(?:测试|检查|验证(?!码)|执行|运行|探索)/.test(text)
  )
    return 'explain';
  return /https?:\/\/|测试|检查|验证(?!码)|探索|发现|登录|点击|填写|搜索|筛选|执行|运行|流程|\b(?:test|check|verify|explore|login|navigate|run)\b/i.test(
    text,
  )
    ? 'auto'
    : 'explain';
}

export const allowedWhileBusy = (message: string) =>
  ['stop', 'status', 'help', 'explain'].includes(classifyMessage(message));

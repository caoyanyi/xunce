import type { RuntimeStatus, Snapshot } from '../shared/types.ts';
import { busyStatuses } from '../shared/workspace.ts';
import { statusNames } from './labels.ts';

export function JobPanel({
  snapshot,
  runtime,
  onSession,
}: {
  snapshot: Snapshot;
  runtime: RuntimeStatus;
  onSession: (id: string) => void;
}) {
  const job = snapshot.jobs?.at(-1);
  const other = runtime.active && runtime.active.sessionId !== snapshot.session.id;
  const position = runtime.queued.findIndex((item) => item.sessionId === snapshot.session.id);
  const planningOnly = job && ['plan', 'discover'].includes(job.mode);
  if (!job && !other) return null;
  return (
    <section className="job-panel" aria-label="作业进度">
      {other && (
        <div className="queue-notice">
          <span>
            {position >= 0
              ? `当前会话排在队列第 ${position + 1} 位`
              : '其他会话正在执行，新提交的作业会自动排队'}
          </span>
          <button onClick={() => onSession(runtime.active!.sessionId)}>查看执行中的会话</button>
        </div>
      )}
      {job && (
        <>
          <div className="job-heading">
            <strong>
              {busyStatuses.includes(job.status)
                ? statusNames[job.status]
                : job.status === 'failed'
                  ? '作业失败'
                  : job.status === 'cancelled'
                    ? '作业已停止'
                    : planningOnly
                      ? '规划完成'
                      : '最近一次运行'}
            </strong>
            <span>{new Date(job.createdAt).toLocaleTimeString('zh-CN', { hour12: false })}</span>
          </div>
          {job.activeTaskId && (
            <p>
              {snapshot.tasks.find((task) => task.id === job.activeTaskId)?.title}{' '}
              {job.currentStep ? `· 步骤 ${job.currentStep}/${job.stepCount}` : ''}
            </p>
          )}
          {planningOnly ? (
            <p>
              {job.status === 'completed'
                ? `${job.total} 项任务已就绪，可编辑或选择后运行`
                : job.status === 'queued'
                  ? '已排队，尚未开始规划'
                  : job.status === 'failed'
                    ? '规划未完成，未执行任务'
                    : job.status === 'cancelled'
                      ? '规划已停止'
                      : '正在观察页面与规划'}
            </p>
          ) : (
            <>
              <progress
                aria-label="本次运行进度"
                value={job.completed}
                max={Math.max(1, job.total)}
              />
              <div className="job-counts">
                <span>
                  {job.completed}/{job.total} 已完成
                </span>
                <span>
                  {job.passed} 通过 · {job.failed} 失败 · {job.cancelled} 中断
                </span>
              </div>
            </>
          )}
          {job.error && <p className="text-red">{job.error}</p>}
          {job.warning && <p className="editor-note">{job.warning}</p>}
          {job.status === 'waiting_input' && (
            <p>浏览器会话已保留，请在下方验证码卡片输入并提交。</p>
          )}
        </>
      )}
      {(snapshot.jobs?.length || 0) > 1 && (
        <details>
          <summary>
            最近 {Math.min(10, snapshot.jobs!.length)} 次作业（共 {snapshot.jobs!.length} 次）
          </summary>
          <ol>
            {snapshot
              .jobs!.slice(-10)
              .reverse()
              .map((item) => (
                <li key={item.id}>
                  <time>
                    {new Date(item.createdAt).toLocaleTimeString('zh-CN', { hour12: false })}
                  </time>
                  <span>{statusNames[item.status]}</span>
                  <span>
                    {['plan', 'discover'].includes(item.mode)
                      ? `规划 ${item.total} 项`
                      : `${item.passed} 通过 / ${item.failed} 失败`}
                  </span>
                </li>
              ))}
          </ol>
        </details>
      )}
    </section>
  );
}

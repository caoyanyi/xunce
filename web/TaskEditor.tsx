import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Plus, X, ArrowUp, ArrowDown } from 'lucide-react';
import type { ConfigStatus, Session, Step, Task } from '../shared/types.ts';
import { api } from './api.ts';
import { actionNames, engineNames, kindNames } from './labels.ts';

function newStep(action: Step['action'], url: string): Step {
  switch (action) {
    case 'goto':
    case 'assertUrl':
    case 'assertLink':
    case 'navigateLink':
      return { action, url };
    case 'assertText':
      return { action, text: '' };
    case 'click':
      return { action, selector: '' };
    case 'fill':
      return { action, selector: '', value: '' };
    case 'validateForm':
      return { action, index: 0 };
    case 'aiAct':
    case 'aiAssert':
      return { action, instruction: '' };
    case 'assertPage':
      return { action };
  }
}
export function TaskEditor({
  task,
  session,
  config,
  onClose,
  onSaved,
}: {
  task?: Task;
  session: Session;
  config?: ConfigStatus;
  onClose: () => void;
  onSaved: (task: Task) => Promise<void>;
}) {
  const [title, setTitle] = useState(task?.title || '新的测试任务');
  const [description, setDescription] = useState(task?.description || '');
  const [url, setUrl] = useState(task?.url || session.targetUrl);
  const [engine, setEngine] = useState<Task['engine']>(task?.engine || 'playwright');
  const [kind, setKind] = useState<Task['kind']>(task?.kind || 'smoke');
  const [priority, setPriority] = useState<Task['priority']>(task?.priority || 'P1');
  const [steps, setSteps] = useState<Step[]>(
    task
      ? structuredClone(task.steps)
      : [{ action: 'goto', url: session.targetUrl }, { action: 'assertPage' }],
  );
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [shownValues, setShownValues] = useState<number[]>([]);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current!;
    const previous = document.activeElement as HTMLElement | null;
    element.showModal();
    return () => {
      element.close();
      previous?.focus();
    };
  }, []);
  function update(index: number, fields: object) {
    setSteps((current) =>
      current.map((step, i) => (i === index ? ({ ...step, ...fields } as Step) : step)),
    );
  }
  function move(index: number, delta: number) {
    setShownValues([]);
    setSteps((current) => {
      const next = [...current];
      [next[index], next[index + delta]] = [next[index + delta], next[index]];
      return next;
    });
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    setError('');
    setSaving(true);
    try {
      const next = await api<Task>(
        `/api/sessions/${session.id}/tasks${task ? `/${task.id}` : ''}`,
        {
          title,
          description,
          url,
          engine,
          kind,
          priority,
          steps,
          ...(task ? { expectedRevision: task.revision || 1 } : {}),
        },
        undefined,
        task ? 'PATCH' : 'POST',
      );
      await onSaved(next);
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setSaving(false);
    }
  }
  const visual = engine === 'midscene';
  return (
    <dialog
      ref={dialog}
      className="task-editor"
      aria-labelledby="editor-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!saving) onClose();
      }}
    >
      <form onSubmit={(event) => void save(event)}>
        <header>
          <div>
            <span className="eyebrow">TEST WORKFLOW</span>
            <h2 id="editor-title">{task ? '编辑测试任务' : '新建测试任务'}</h2>
          </div>
          <button
            type="button"
            className="icon-button"
            aria-label="关闭任务编辑"
            onClick={onClose}
            disabled={saving}
          >
            <X size={20} />
          </button>
        </header>
        <div className="editor-body">
          <fieldset className="editor-content" disabled={saving}>
            <div className="editor-fields">
              <label className="wide">
                任务名称
                <input
                  required
                  maxLength={120}
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                />
              </label>
              <label className="wide">
                目标页面 URL
                <input
                  type="url"
                  required
                  value={url}
                  onChange={(event) => {
                    const next = event.target.value;
                    setUrl(next);
                    if (steps[0]?.action === 'goto' && steps[0].url === url)
                      update(0, { url: next });
                  }}
                />
              </label>
              <label>
                执行器
                <select
                  value={engine}
                  onChange={(event) => setEngine(event.target.value as Task['engine'])}
                >
                  {Object.entries(engineNames).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                任务类型
                <select
                  value={kind}
                  onChange={(event) => setKind(event.target.value as Task['kind'])}
                >
                  {Object.entries(kindNames).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                优先级
                <select
                  value={priority}
                  onChange={(event) => setPriority(event.target.value as Task['priority'])}
                >
                  <option>P0</option>
                  <option>P1</option>
                  <option>P2</option>
                </select>
              </label>
              <label className="wide">
                任务说明
                <textarea
                  maxLength={2000}
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                />
              </label>
            </div>
            {!session.options.allowWrites &&
              steps.some((step) => ['click', 'fill', 'aiAct'].includes(step.action)) && (
                <p className="editor-note">
                  当前只读：可以保存交互任务草稿，运行前需要在设置中允许交互。
                </p>
              )}
            {visual && !config?.midscene && (
              <p className="editor-note">
                视觉模型尚未配置。可以保存草稿，运行前请完成 Midscene 配置。
              </p>
            )}
            <div className="editor-section-title">
              <h3>执行步骤</h3>
              <span>至少保留一项结果断言</span>
            </div>
            <ol className="editor-steps">
              {steps.map((step, index) => (
                <li key={index}>
                  <div className="editor-step-heading">
                    <span>{String(index + 1).padStart(2, '0')}</span>
                    <select
                      aria-label={`步骤 ${index + 1} 操作`}
                      value={step.action}
                      onChange={(event) => {
                        setShownValues([]);
                        setSteps((current) =>
                          current.map((item, i) =>
                            i === index ? newStep(event.target.value as Step['action'], url) : item,
                          ),
                        );
                      }}
                    >
                      {Object.entries(actionNames).map(([value, label]) => (
                        <option value={value} key={value}>
                          {label}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      className="icon-button"
                      aria-label={`上移步骤 ${index + 1}`}
                      disabled={!index}
                      onClick={() => move(index, -1)}
                    >
                      <ArrowUp size={14} />
                    </button>
                    <button
                      type="button"
                      className="icon-button"
                      aria-label={`下移步骤 ${index + 1}`}
                      disabled={index === steps.length - 1}
                      onClick={() => move(index, 1)}
                    >
                      <ArrowDown size={14} />
                    </button>
                    <button
                      type="button"
                      className="icon-button"
                      aria-label={`删除步骤 ${index + 1}`}
                      disabled={steps.length <= 1}
                      onClick={() => {
                        setShownValues([]);
                        setSteps((current) => current.filter((_, i) => i !== index));
                      }}
                    >
                      <X size={15} />
                    </button>
                  </div>
                  <div className="editor-fields">
                    {'url' in step && (
                      <label className="wide">
                        页面地址
                        <input
                          type="url"
                          required
                          value={step.url}
                          onChange={(event) => update(index, { url: event.target.value })}
                        />
                      </label>
                    )}
                    {'text' in step && (
                      <label className="wide">
                        预期可见文本
                        <input
                          required
                          maxLength={500}
                          value={step.text}
                          onChange={(event) => update(index, { text: event.target.value })}
                        />
                      </label>
                    )}
                    {'selector' in step && (
                      <label className="wide">
                        元素选择器
                        <input
                          required
                          maxLength={300}
                          placeholder="例如 input[name=email]"
                          value={step.selector}
                          onChange={(event) => update(index, { selector: event.target.value })}
                        />
                      </label>
                    )}
                    {'value' in step && (
                      <label className="wide">
                        填写内容
                        <input
                          type={shownValues.includes(index) ? 'text' : 'password'}
                          autoComplete="new-password"
                          maxLength={1000}
                          value={step.value}
                          onChange={(event) => update(index, { value: event.target.value })}
                        />
                        <small>填写值默认隐藏；保存后测试会按该值填写。</small>
                        <button
                          type="button"
                          onClick={() =>
                            setShownValues((current) =>
                              current.includes(index)
                                ? current.filter((value) => value !== index)
                                : [...current, index],
                            )
                          }
                        >
                          {shownValues.includes(index) ? '隐藏填写内容' : '显示填写内容'}
                        </button>
                      </label>
                    )}
                    {'instruction' in step && (
                      <label className="wide">
                        {step.action === 'aiAct' ? '要执行的操作' : '预期页面结果'}
                        <textarea
                          required
                          maxLength={2000}
                          value={step.instruction}
                          onChange={(event) => update(index, { instruction: event.target.value })}
                        />
                      </label>
                    )}
                    {'index' in step && (
                      <label>
                        表单序号
                        <input
                          type="number"
                          min={1}
                          max={101}
                          required
                          value={step.index + 1}
                          onChange={(event) =>
                            update(index, { index: Math.max(0, Number(event.target.value) - 1) })
                          }
                        />
                      </label>
                    )}
                  </div>
                </li>
              ))}
            </ol>
            <button
              type="button"
              className="editor-add"
              disabled={steps.length >= 30}
              onClick={() =>
                setSteps((current) => [
                  ...current,
                  newStep(visual ? 'aiAssert' : 'assertText', url),
                ])
              }
            >
              <Plus size={15} />
              添加步骤
            </button>
            {error && (
              <p role="alert" className="error-banner">
                {error}
              </p>
            )}
          </fieldset>
        </div>
        <footer>
          <span>
            {task
              ? `当前版本 v${task.revision || 1} · 修改不会覆盖历史结果`
              : '保存后可选择任务运行'}
          </span>
          <button type="button" onClick={onClose} disabled={saving}>
            取消
          </button>
          <button type="submit" className="button-primary" disabled={saving}>
            {saving ? '正在保存…' : '保存任务'}
          </button>
        </footer>
      </form>
    </dialog>
  );
}

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import {
  Activity,
  ArrowDownToLine,
  ArrowRight,
  ArrowUp,
  Check,
  CheckCircle2,
  ChevronRight,
  Circle,
  Compass,
  ExternalLink,
  FileCode2,
  FileJson2,
  Globe2,
  Layers3,
  LoaderCircle,
  MessageSquare,
  Plus,
  RotateCcw,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  Square,
  Terminal,
  Workflow,
  X,
  XCircle,
} from 'lucide-react';
import type { ConfigStatus, Options, Run, Session, Snapshot, Step, Task } from '../shared/types.ts';
import { allowedWhileBusy } from '../shared/commands.ts';
import type { RuntimeStatus } from '../shared/types.ts';
import { busyStatuses, runnableTask } from '../shared/workspace.ts';
import { api } from './api.ts';
import { statusNames, engineNames, kindNames } from './labels.ts';
import { TaskEditor } from './TaskEditor.tsx';
import { JobPanel } from './JobPanel.tsx';

function StatusIcon({ status }: { status: string }) {
  if (status === 'passed') return <CheckCircle2 size={17} className="text-green" />;
  if (status === 'failed') return <XCircle size={17} className="text-red" />;
  if (['running', 'discovering', 'planning', 'queued'].includes(status))
    return <LoaderCircle size={17} className="spin text-accent" />;
  if (status === 'cancelled') return <Square size={15} className="text-muted" />;
  if (status === 'waiting_input') return <MessageSquare size={17} className="text-accent" />;
  return <Circle size={16} className="text-muted" />;
}
function stepLabel(step: Step) {
  switch (step.action) {
    case 'goto':
      return `打开 ${step.url}`;
    case 'assertPage':
      return '验证 HTTP 响应、页面标题和正文内容';
    case 'assertText':
      return `断言可见文本：${step.text}`;
    case 'assertUrl':
      return `验证当前 URL：${step.url}${step.match === 'path' ? ' · 同源 + 路径（忽略 query/hash，区分尾斜线）' : ''} · 等待 ${step.timeoutMs ?? 10000} 毫秒`;
    case 'navigateLink':
      return `点击同源导航链接：${step.url}`;
    case 'assertLink':
      return `验证入口链接可见：${step.url}${step.text ? ` · 文本包含“${step.text}”` : ''} · 等待 ${step.timeoutMs ?? 10000} 毫秒`;
    case 'validateForm':
      return `验证第 ${step.index + 1} 个表单的必填字段约束`;
    case 'click':
      return `点击：${step.selector}`;
    case 'fill':
      return `填写：${step.selector}`;
    case 'aiAct':
      return `视觉操作：${step.instruction}`;
    case 'aiAssert':
      return `视觉断言：${step.instruction}`;
  }
}
function shortUrl(url: string) {
  try {
    const parsed = new URL(url);
    return parsed.pathname + parsed.search;
  } catch {
    return url;
  }
}
function clockTime(date: string) {
  return new Date(date).toLocaleTimeString('zh-CN', { hour12: false });
}

export function App() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeId, setActiveId] = useState('');
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [config, setConfig] = useState<ConfigStatus>();
  const [target, setTarget] = useState('');
  const [message, setMessage] = useState('');
  const [options, setOptions] = useState<Options>({
    maxPages: 6,
    maxDepth: 2,
    engine: 'tester-army',
    allowWrites: false,
  });
  const [settings, setSettings] = useState(false);
  const [tab, setTab] = useState<'tasks' | 'pages' | 'events'>('tasks');
  const [filter, setFilter] = useState('all');
  const [runtime, setRuntime] = useState<RuntimeStatus>({ queued: [] });
  const [sessionName, setSessionName] = useState('');
  const [checkedIds, setCheckedIds] = useState<string[]>([]);
  const [editor, setEditor] = useState<Task | 'new' | null>(null);
  const [query, setQuery] = useState('');
  const [taskId, setTaskId] = useState('');
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const [initializing, setInitializing] = useState(true);
  const activeRef = useRef(activeId);
  const chatEnd = useRef<HTMLDivElement>(null);
  activeRef.current = activeId;
  const busy = Boolean(snapshot && busyStatuses.includes(snapshot.session.status));
  const waitingRun = snapshot?.runs.find(
    (run) => run.status === 'waiting_input' && run.pendingInput,
  );
  const refreshSessions = useCallback(async () => {
    setSessions(await api<Session[]>('/api/sessions'));
  }, []);
  const refresh = useCallback(
    async (id: string) => {
      const [next, state] = await Promise.all([
        api<Snapshot>(`/api/sessions/${id}`),
        api<RuntimeStatus>('/api/runtime'),
      ]);
      setRuntime(state);
      if (activeRef.current === id) setSnapshot(next);
      await refreshSessions();
    },
    [refreshSessions],
  );
  useEffect(() => {
    let disposed = false;
    void (async () => {
      try {
        const [cfg, list] = await Promise.all([
          api<ConfigStatus>('/api/config'),
          api<Session[]>('/api/sessions'),
        ]);
        if (disposed) return;
        setConfig(cfg);
        if (list.length) {
          setSessions(list);
          setActiveId(
            list.some((s) => s.id === localStorage.getItem('explorer-session'))
              ? localStorage.getItem('explorer-session')!
              : list[0].id,
          );
        } else {
          const session = await api<Session>('/api/sessions', {});
          if (!disposed) {
            setSessions([session]);
            setActiveId(session.id);
          }
        }
      } catch (e) {
        if (!disposed) setError((e as Error).message);
      } finally {
        if (!disposed) setInitializing(false);
      }
    })();
    return () => {
      disposed = true;
    };
  }, []);
  useEffect(() => {
    if (!activeId) return;
    localStorage.setItem('explorer-session', activeId);
    setSnapshot(undefined);
    setTaskId('');
    setCheckedIds([]);
    setEditor(null);
    setError('');
    let disposed = false;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async (initial: boolean) => {
      try {
        const [next, state, list] = await Promise.all([
          api<Snapshot>(`/api/sessions/${activeId}`, undefined, controller.signal),
          api<RuntimeStatus>('/api/runtime', undefined, controller.signal),
          api<Session[]>('/api/sessions', undefined, controller.signal),
        ]);
        if (!disposed) {
          setError((previous) => (previous === '无法连接服务，正在自动重连。' ? '' : previous));
          setSnapshot(next);
          setRuntime(state);
          setSessions(list);
          if (initial) {
            setTarget(next.session.targetUrl);
            setOptions(next.session.options);
            setSessionName(next.session.name);
          }
        }
      } catch (error) {
        if (!disposed && (error as Error).name !== 'AbortError')
          setError('无法连接服务，正在自动重连。');
      } finally {
        if (!disposed) timer = setTimeout(() => void load(false), 1400);
      }
    };
    void load(true);
    return () => {
      disposed = true;
      controller.abort();
      clearTimeout(timer);
    };
  }, [activeId]);
  useEffect(() => {
    chatEnd.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [snapshot?.messages.length]);

  async function perform(action: () => Promise<void>) {
    setError('');
    setSending(true);
    try {
      await action();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSending(false);
    }
  }
  async function newSession() {
    await perform(async () => {
      const session = await api<Session>('/api/sessions', {});
      setSessions((prev) => [session, ...prev]);
      setActiveId(session.id);
      setMessage('');
      setTab('tasks');
    });
  }
  async function send(text = message, useDemo = false, nextOptions = options) {
    if (!text.trim() || !activeId) return;
    const id = activeId;
    await perform(async () => {
      const targetUrl = useDemo ? config?.demoUrl : target;
      await api(`/api/sessions/${id}/chat`, {
        message: text,
        ...(targetUrl ? { targetUrl } : {}),
        options: nextOptions,
      });
      if (activeRef.current === id) {
        setMessage('');
        setOptions(nextOptions);
        if (useDemo && config) setTarget(config.demoUrl);
      }
      await refresh(id);
    });
  }
  async function run(taskIds?: string[], failedOnly = false, mode?: 'continue') {
    const id = activeId;
    await perform(async () => {
      if (snapshot && JSON.stringify(options) !== JSON.stringify(snapshot.session.options))
        await api(`/api/sessions/${id}`, { options }, undefined, 'PATCH');
      await api(`/api/sessions/${id}/run`, { taskIds, failedOnly, mode });
      if (activeRef.current === id) setCheckedIds([]);
      await refresh(id);
    });
  }
  async function stop() {
    await perform(async () => {
      await api(`/api/sessions/${activeId}/cancel`, {});
      await refresh(activeId);
    });
  }
  async function saveSettings() {
    const id = activeId;
    await perform(async () => {
      await api(
        `/api/sessions/${id}`,
        { name: sessionName, targetUrl: target, options },
        undefined,
        'PATCH',
      );
      await refresh(id);
    });
  }
  async function patchTask(task: Task, patch: object) {
    const id = activeId;
    await perform(async () => {
      await api(
        `/api/sessions/${id}/tasks/${task.id}`,
        { ...patch, expectedRevision: task.revision || 1 },
        undefined,
        'PATCH',
      );
      setCheckedIds([]);
      await refresh(id);
    });
  }
  const allTasks = snapshot?.tasks || [];
  const tasks = allTasks.filter((task) => !task.archived);
  const selectedIds = checkedIds.filter((id) =>
    allTasks.some((task) => task.id === id && runnableTask(task)),
  );
  const settingsDirty = Boolean(
    snapshot &&
    (sessionName !== snapshot.session.name ||
      target !== snapshot.session.targetUrl ||
      JSON.stringify(options) !== JSON.stringify(snapshot.session.options)),
  );
  const passed = tasks.filter((t) => t.status === 'passed').length;
  const failed = tasks.filter((t) => t.status === 'failed').length;
  const done = passed + failed;
  const selected = allTasks.find((t) => t.id === taskId);
  const visibleTasks = allTasks.filter(
    (t) =>
      (filter === 'archived'
        ? t.archived
        : !t.archived &&
          (filter === 'all' ||
            (filter === 'disabled' ? t.enabled === false : t.status === filter))) &&
      `${t.title} ${t.url}`.toLowerCase().includes(query.toLowerCase()),
  );
  const events = snapshot?.events || [];
  const currentEvent = events.at(-1);

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="/" aria-label="巡测首页">
          <span className="brand-mark">
            <Compass size={23} strokeWidth={1.8} />
          </span>
          <span>
            巡测<span className="brand-en">EXPLORER</span>
          </span>
          <span className="version">0.2</span>
        </a>
        <button className="new-session" onClick={() => void newSession()} disabled={sending}>
          <Plus size={17} /> 新建探索
        </button>
        <div className="nav-label">工作空间</div>
        <div className="nav-active">
          <Workflow size={17} /> 自主 E2E <span className="small-pill">BETA</span>
        </div>
        <div className="session-heading">
          <span>探索记录</span>
          <span>{sessions.length.toString().padStart(2, '0')}</span>
        </div>
        <nav className="session-list" aria-label="探索历史">
          {sessions.map((session) => (
            <button
              key={session.id}
              className={`session-item ${activeId === session.id ? 'selected' : ''}`}
              onClick={() => setActiveId(session.id)}
            >
              <MessageSquare size={15} />
              <span>{session.name}</span>
              {busyStatuses.includes(session.status) && <span className="live-dot" />}
            </button>
          ))}
          {!sessions.length && <p className="sidebar-empty">探索记录将保存在这里</p>}
        </nav>
        <div className="sidebar-bottom">
          <div className="local-label">
            <span className="live-dot" /> 本地工作空间
          </div>
          <p>测试任务与执行证据保存于本机</p>
          <button onClick={() => setSettings(true)}>
            <Settings2 size={16} /> 模型与探索设置 <ChevronRight size={15} />
          </button>
          <div className="profile">
            <span className="avatar">L</span>
            <span>
              Local workspace<small>Developer edition</small>
            </span>
            <span className="profile-dot" />
          </div>
        </div>
      </aside>

      <div className="workspace">
        <header className="topbar">
          <div className="breadcrumb">
            <Workflow size={15} />
            <span>工作空间</span>
            <ChevronRight size={14} />
            <strong>自主 E2E</strong>
          </div>
          <div className="topbar-right">
            <button
              className="icon-button mobile-new"
              title="新建探索"
              aria-label="新建探索"
              disabled={sending}
              onClick={() => void newSession()}
            >
              <Plus size={17} />
            </button>
            <span className="local-chip">
              <ShieldCheck size={14} /> 本地运行
            </span>
            <button className="icon-button" title="探索设置" onClick={() => setSettings(!settings)}>
              <Settings2 size={17} />
            </button>
          </div>
        </header>
        <main className="main-layout">
          <section className="test-workspace" aria-label="测试工作台">
            <div className="page-heading">
              <div>
                <div className="eyebrow">AUTONOMOUS QUALITY ASSURANCE</div>
                <h1>
                  让测试，自己发现任务<span className="accent-dot">.</span>
                </h1>
                <p>给出一个目标，自动探索、验证，并留下可追溯的证据。</p>
              </div>
              <div role="status" className={`session-status ${busy ? 'is-live' : ''}`}>
                <span className={busy ? 'live-dot pulse' : 'status-dot'} />
                {statusNames[snapshot?.session.status || 'idle']}
              </div>
            </div>
            <div className="target-bar">
              <Globe2 size={18} />
              <label className="sr-only" htmlFor="target-url">
                目标 URL
              </label>
              <input
                id="target-url"
                type="url"
                placeholder="输入测试站点，例如 http://localhost:3000"
                value={target}
                onChange={(e) => setTarget(e.target.value)}
                disabled={
                  !snapshot || snapshot.session.id !== activeId || busy || Boolean(allTasks.length)
                }
              />
              <button
                className="target-settings"
                onClick={() => setSettings(!settings)}
                title="配置探索预算"
              >
                <Settings2 size={15} />
                <span>{options.maxPages} 页</span>
              </button>
            </div>
            {settings && (
              <div className="settings-panel">
                <div className="section-title">
                  <strong>探索设置</strong>
                  <button
                    className="icon-button"
                    aria-label="关闭设置"
                    onClick={() => setSettings(false)}
                  >
                    <X size={16} />
                  </button>
                </div>
                <div className="settings-grid">
                  <label>
                    会话名称
                    <input
                      value={sessionName}
                      maxLength={80}
                      disabled={busy}
                      onChange={(event) => setSessionName(event.target.value)}
                    />
                  </label>
                  <label>
                    结构化执行器
                    <select
                      value={options.engine}
                      disabled={busy}
                      onChange={(e) =>
                        setOptions({ ...options, engine: e.target.value as Options['engine'] })
                      }
                    >
                      <option value="tester-army">TesterArmy e2e</option>
                      <option value="playwright">Playwright</option>
                      <option value="midscene">Midscene + Playwright 基线</option>
                    </select>
                  </label>
                  <label>
                    页面预算
                    <input
                      type="number"
                      min={1}
                      max={20}
                      value={options.maxPages}
                      disabled={busy}
                      onChange={(e) =>
                        setOptions({
                          ...options,
                          maxPages: Math.max(1, Math.min(20, Number(e.target.value) || 1)),
                        })
                      }
                    />
                  </label>
                  <label>
                    探索深度
                    <input
                      type="number"
                      min={0}
                      max={4}
                      value={options.maxDepth}
                      disabled={busy}
                      onChange={(e) =>
                        setOptions({
                          ...options,
                          maxDepth: Math.max(0, Math.min(4, Number(e.target.value) || 0)),
                        })
                      }
                    />
                  </label>
                </div>
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={options.allowWrites}
                    disabled={busy}
                    onChange={(e) => setOptions({ ...options, allowWrites: e.target.checked })}
                  />
                  允许交互与写操作（仅用于已授权的测试环境）
                </label>
                <div className="provider-status">
                  <span>
                    <i className={config?.planner ? 'connected' : ''} />
                    任务规划模型：{config?.planner ? '已配置' : '未配置 · 使用 DOM 规则'}
                  </span>
                  <span>
                    <i className={config?.midscene ? 'connected' : ''} />
                    Midscene 视觉：{config?.midscene ? '已配置' : '未配置'}
                  </span>
                </div>
                <p className="settings-note">
                  模型通过服务端 .env 配置。保存设置后立即生效；运行只读任务不会自动增加登录动作。
                </p>
                <button
                  className="button-primary compact"
                  disabled={busy || sending || !settingsDirty}
                  onClick={() => void saveSettings()}
                >
                  {settingsDirty ? '保存设置' : '设置已保存'}
                </button>
              </div>
            )}
            {error && (
              <div role="alert" className="error-banner">
                <XCircle size={17} />
                <span>{error}</span>
                <button
                  className="icon-button"
                  aria-label="关闭错误提示"
                  onClick={() => setError('')}
                >
                  <X size={15} />
                </button>
              </div>
            )}
            {waitingRun && (
              <ManualInputCard
                key={waitingRun.pendingInput!.id}
                run={waitingRun}
                onRefresh={() => refresh(activeId)}
                onCancel={stop}
              />
            )}
            {snapshot && <JobPanel snapshot={snapshot} runtime={runtime} onSession={setActiveId} />}
            {!snapshot?.session.options.allowWrites &&
              snapshot?.pages.some((page) =>
                page.inputs?.some((input) => input.type === 'password'),
              ) && (
                <div className="login-mode-notice" role="note">
                  <ShieldCheck size={18} />
                  <div>
                    <strong>当前为只读模式，不会自动登录</strong>
                    <p>
                      现有任务只验证登录界面。允许交互后，可使用本会话提供的账号重新规划填写、提交及登录结果验证；图形验证码会提示手动输入。
                    </p>
                  </div>
                  <button
                    className="button-primary"
                    disabled={busy || sending}
                    onClick={() =>
                      void send(
                        '使用本会话之前提供的测试账号和密码完成登录；如果尚未提供账号，请明确说明缺少登录信息，不要编造。遇到图形验证码暂停并提示我输入，再验证登录成功。请将登录操作和登录后的断言放在同一个任务。',
                        false,
                        { ...options, allowWrites: true },
                      )
                    }
                  >
                    允许交互并规划登录
                  </button>
                </div>
              )}
            <div className="metric-strip">
              <div>
                <span>发现页面</span>
                <strong>
                  {snapshot?.pages.length || 0}
                  <small>pages</small>
                </strong>
              </div>
              <div>
                <span>测试任务</span>
                <strong>
                  {tasks.length}
                  <small>tasks</small>
                </strong>
              </div>
              <div>
                <span>验证通过</span>
                <strong className={passed ? 'text-green' : ''}>
                  {passed}
                  <small>passed</small>
                </strong>
              </div>
              <div>
                <span>发现问题</span>
                <strong className={failed ? 'text-red' : ''}>
                  {failed}
                  <small>issues</small>
                </strong>
              </div>
            </div>
            <div className="results-section">
              <div className="results-toolbar">
                <div className="tabs" role="tablist" aria-label="测试结果视图">
                  {(
                    [
                      { value: 'tasks', label: '测试任务', icon: Layers3, count: tasks.length },
                      {
                        value: 'pages',
                        label: '发现页面',
                        icon: Globe2,
                        count: snapshot?.pages.length || 0,
                      },
                      { value: 'events', label: '执行日志', icon: Terminal, count: events.length },
                    ] as const
                  ).map((item) => (
                    <button
                      role="tab"
                      aria-selected={tab === item.value}
                      className={tab === item.value ? 'active' : ''}
                      key={item.value}
                      onClick={() => setTab(item.value)}
                    >
                      <item.icon size={15} />
                      {item.label}
                      <span>{item.count}</span>
                    </button>
                  ))}
                </div>
                <div className="toolbar-actions">
                  <button
                    className="icon-button"
                    aria-label="新建任务"
                    title="新建任务"
                    disabled={busy || sending || !snapshot?.session.targetUrl}
                    onClick={() => setEditor('new')}
                  >
                    <Plus size={17} />
                  </button>
                  {Boolean(snapshot?.pages.length) && !busy && (
                    <button
                      className="toolbar-text"
                      disabled={sending}
                      onClick={() => void send('重新规划当前测试目标')}
                    >
                      重新规划
                    </button>
                  )}
                  {!busy &&
                    tasks.some(
                      (task) =>
                        runnableTask(task) && ['pending', 'cancelled'].includes(task.status),
                    ) && (
                      <button
                        className="toolbar-text"
                        disabled={sending}
                        onClick={() => void run(undefined, false, 'continue')}
                      >
                        继续未完成
                      </button>
                    )}
                  {allTasks.length > 0 && (
                    <a
                      className="icon-button"
                      title="下载 JSON 报告"
                      aria-label="下载报告"
                      href={`/api/sessions/${activeId}/report`}
                      download
                    >
                      <ArrowDownToLine size={16} />
                    </a>
                  )}
                  {busy ? (
                    <button className="button-stop" onClick={() => void stop()} disabled={sending}>
                      <Square size={12} />
                      停止
                    </button>
                  ) : tasks.length > 0 ? (
                    <button
                      className="button-primary compact"
                      onClick={() => void run()}
                      disabled={sending || !tasks.some(runnableTask)}
                    >
                      <ArrowRight size={14} />
                      运行全部
                    </button>
                  ) : null}
                </div>
              </div>
              {(initializing || !snapshot) && !error ? (
                <div className="loading-state">
                  <LoaderCircle className="spin" size={25} />
                  <p>正在载入工作空间…</p>
                </div>
              ) : tab === 'tasks' && allTasks.length === 0 ? (
                <div className="empty-state">
                  <div className="empty-visual">
                    <span className="orbit orbit-one" />
                    <span className="orbit orbit-two" />
                    <div className="compass-icon">
                      <Compass size={38} strokeWidth={1.3} />
                    </div>
                    <span className="orbit-node n1" />
                    <span className="orbit-node n2" />
                    <span className="orbit-node n3" />
                  </div>
                  <h2>{busy ? '正在把站点变成测试任务' : '下一次探索，从这里开始'}</h2>
                  <p>
                    {busy
                      ? '观察页面结构、链接与表单，识别可以验证的用户路径。'
                      : '无需先写测试脚本。告诉巡测你想验证什么，剩下的交给它。'}
                  </p>
                  <div className="workflow-preview">
                    <span>
                      <Globe2 size={15} />
                      探索页面
                    </span>
                    <ChevronRight size={13} />
                    <span>
                      <Search size={15} />
                      发现任务
                    </span>
                    <ChevronRight size={13} />
                    <span>
                      <CheckCircle2 size={15} />
                      执行验证
                    </span>
                  </div>
                  {!busy && (
                    <button
                      className="demo-button"
                      onClick={() =>
                        void send('探索演示商城，检查页面、导航和登录表单，并自动运行测试', true)
                      }
                      disabled={sending || !config}
                    >
                      <Sparkles size={16} />
                      试运行演示商城
                      <ArrowRight size={15} />
                    </button>
                  )}
                  <span className="empty-footnote">
                    {busy ? '任务将在探索结束后出现在这里' : '内置可复现故障 · 无需模型密钥'}
                  </span>
                </div>
              ) : tab === 'tasks' ? (
                <>
                  <div className="task-filters">
                    <div className="filter-buttons">
                      {[
                        { value: 'all', label: '全部' },
                        { value: 'failed', label: '失败' },
                        { value: 'passed', label: '通过' },
                        { value: 'pending', label: '待执行' },
                        { value: 'disabled', label: '已停用' },
                        { value: 'archived', label: '已归档' },
                      ].map((item) => (
                        <button
                          className={filter === item.value ? 'active' : ''}
                          onClick={() => setFilter(item.value)}
                          key={item.value}
                        >
                          {item.label}
                        </button>
                      ))}
                    </div>
                    <label className="search-input">
                      <Search size={14} />
                      <input
                        placeholder="搜索任务"
                        aria-label="搜索任务"
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                      />
                    </label>
                  </div>
                  <div className="bulk-toolbar">
                    <label>
                      <input
                        type="checkbox"
                        aria-label="选择当前筛选任务"
                        disabled={busy || !visibleTasks.some(runnableTask)}
                        checked={
                          visibleTasks.filter(runnableTask).length > 0 &&
                          visibleTasks
                            .filter(runnableTask)
                            .every((task) => selectedIds.includes(task.id))
                        }
                        onChange={(event) =>
                          setCheckedIds((current) =>
                            event.target.checked
                              ? [
                                  ...new Set([
                                    ...current,
                                    ...visibleTasks.filter(runnableTask).map((task) => task.id),
                                  ]),
                                ]
                              : current.filter(
                                  (id) => !visibleTasks.some((task) => task.id === id),
                                ),
                          )
                        }
                      />
                      选择当前筛选任务
                    </label>
                    <span>已选 {selectedIds.length} 项</span>
                    <button
                      disabled={busy || sending || !selectedIds.length}
                      onClick={() => void run(selectedIds)}
                    >
                      运行选中
                    </button>
                    {selectedIds.length > 0 && (
                      <button onClick={() => setCheckedIds([])}>清空选择</button>
                    )}
                  </div>
                  <div className="task-table">
                    <div className="table-head">
                      <span>任务 / 验证目标</span>
                      <span>优先级</span>
                      <span>状态</span>
                      <span />
                    </div>
                    {visibleTasks.map((task) => (
                      <div className="task-row-wrap" key={task.id}>
                        <input
                          type="checkbox"
                          aria-label={`选择任务 ${task.title}`}
                          disabled={busy || !runnableTask(task)}
                          checked={selectedIds.includes(task.id)}
                          onChange={(event) =>
                            setCheckedIds((current) =>
                              event.target.checked
                                ? [...current, task.id]
                                : current.filter((id) => id !== task.id),
                            )
                          }
                        />
                        <button
                          className={`task-row ${taskId === task.id ? 'selected' : ''}`}
                          onClick={() => setTaskId(task.id)}
                        >
                          <span className="task-summary">
                            <StatusIcon status={task.status} />
                            <span>
                              <strong>{task.title}</strong>
                              <small>
                                {kindNames[task.kind]}
                                <i /> {shortUrl(task.url)}
                                <i />
                                {engineNames[task.engine]}
                              </small>
                            </span>
                          </span>
                          <span className={`priority ${task.priority.toLowerCase()}`}>
                            {task.priority}
                          </span>
                          <span className={`status-label ${task.status}`}>
                            {task.archived
                              ? '已归档'
                              : task.enabled === false
                                ? '已停用'
                                : statusNames[task.status]}
                          </span>
                          <ChevronRight size={15} />
                        </button>
                      </div>
                    ))}
                    {visibleTasks.length === 0 && <p className="no-matches">没有符合条件的任务</p>}
                  </div>
                </>
              ) : tab === 'pages' ? (
                <div className="page-list">
                  {snapshot?.pages.map((page) => (
                    <div key={page.id} className="observed-page">
                      <span className="page-node">
                        <Globe2 size={17} />
                      </span>
                      <div>
                        <strong>{page.title || '未能加载页面'}</strong>
                        <a href={page.url} target="_blank" rel="noreferrer">
                          {page.url}
                          <ExternalLink size={11} />
                        </a>
                        <small>
                          深度 {page.depth} · {page.links.length} 个链接 · {page.forms.length}{' '}
                          个表单
                        </small>
                      </div>
                      <span
                        className={page.status >= 400 || !page.status ? 'http-error' : 'http-ok'}
                      >
                        {page.status || 'ERR'}
                      </span>
                    </div>
                  ))}
                  {!snapshot?.pages.length && (
                    <p className="no-matches">开始探索后，会在这里显示观察到的页面。</p>
                  )}
                </div>
              ) : (
                <div className="event-list">
                  {events.map((event) => (
                    <div className={`event-row ${event.level}`} key={event.id}>
                      <time>{clockTime(event.createdAt)}</time>
                      <span className="event-dot" />
                      <span>{event.message}</span>
                    </div>
                  ))}
                  {events.length === 0 && (
                    <p className="no-matches">运行日志会显示每一步探索与验证过程。</p>
                  )}
                </div>
              )}
            </div>
            <footer className="workspace-footer">
              <span>
                <span className={busy ? 'live-dot pulse' : 'status-dot'} />
                {currentEvent ? currentEvent.message.slice(0, 100) : '工作空间就绪 · 等待测试目标'}
              </span>
              {tasks.length > 0 && (
                <span>
                  {done} / {tasks.length} 已验证
                </span>
              )}
            </footer>
          </section>

          <aside className="chat-panel" aria-label="对话助手">
            <div className="chat-heading">
              <span className="assistant-symbol">
                <Sparkles size={17} />
              </span>
              <div>
                <strong>探索助手</strong>
                <small>从意图到验证</small>
              </div>
              <span className="chat-online">
                <span className="live-dot" />
                在线
              </span>
            </div>
            <div className="chat-messages">
              {snapshot?.messages.map((item) => (
                <div className={`chat-message ${item.role}`} key={item.id}>
                  {item.role === 'assistant' && (
                    <span className="message-avatar">
                      <Compass size={16} />
                    </span>
                  )}
                  <div>
                    {item.role === 'assistant' && (
                      <span className="message-author">
                        巡测 <span>AGENT</span>
                      </span>
                    )}
                    <p>{item.content}</p>
                    <time>{clockTime(item.createdAt)}</time>
                  </div>
                </div>
              ))}
              {busy && (
                <div className="thinking">
                  <span />
                  <span />
                  <span />
                  {snapshot?.session.status === 'waiting_input'
                    ? '等待手动输入验证码'
                    : snapshot?.session.status === 'queued'
                      ? '等待前方作业完成'
                      : snapshot?.session.status === 'planning'
                        ? '正在规划任务'
                        : `正在${snapshot?.session.status === 'discovering' ? '观察站点' : '验证任务'}`}
                </div>
              )}
              <div ref={chatEnd} />
            </div>
            <div className="chat-compose-area">
              {!busy && (
                <div className="suggestion-chips">
                  {tasks.length ? (
                    <>
                      <button onClick={() => void send('状态')} disabled={sending}>
                        当前进度
                      </button>
                      <button
                        onClick={() => void run(undefined, true)}
                        disabled={
                          sending || !tasks.some((t) => ['failed', 'cancelled'].includes(t.status))
                        }
                      >
                        <RotateCcw size={11} />
                        复跑失败
                      </button>
                    </>
                  ) : (
                    <>
                      <button onClick={() => setMessage('只探索站点并发现可验证的任务')}>
                        只探索站点
                      </button>
                      <button
                        onClick={() => setMessage('检查所有可达页面、导航及表单，并自动执行')}
                      >
                        探索并自动执行
                      </button>
                    </>
                  )}
                </div>
              )}
              <form
                className="composer"
                onSubmit={(e: FormEvent) => {
                  e.preventDefault();
                  void send();
                }}
              >
                <label className="sr-only" htmlFor="chat-input">
                  测试目标或对话指令
                </label>
                <textarea
                  id="chat-input"
                  placeholder="描述测试目标，例如：检查登录和关键页面…"
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                      e.preventDefault();
                      if (!sending && (!busy || allowedWhileBusy(message))) void send();
                    }
                  }}
                />
                <div className="composer-bottom">
                  <span>
                    <ShieldCheck size={12} />
                    {options.allowWrites ? '允许交互与写操作' : '只读探索与验证'}
                  </span>
                  <button
                    type="submit"
                    aria-label="发送测试目标"
                    disabled={
                      sending || !message.trim() || Boolean(busy && !allowedWhileBusy(message))
                    }
                  >
                    {sending ? <LoaderCircle size={16} className="spin" /> : <ArrowUp size={17} />}
                  </button>
                </div>
              </form>
              <p className="composer-hint">Enter 发送 · Shift + Enter 换行</p>
            </div>
          </aside>
        </main>
      </div>
      {selected && snapshot && (
        <TaskDetail
          key={selected.id}
          task={selected}
          snapshot={snapshot}
          busy={Boolean(busy || sending)}
          onClose={() => setTaskId('')}
          onRun={() => void run([selected.id])}
          onRefresh={() => refresh(activeId)}
          onCancel={stop}
          onEdit={() => {
            setEditor(selected);
            setTaskId('');
          }}
          onPatch={(patch) => void patchTask(selected, patch)}
          actionError={error}
        />
      )}
      {editor && snapshot && (
        <TaskEditor
          key={editor === 'new' ? 'new' : `${editor.id}-${editor.revision || 1}`}
          task={editor === 'new' ? undefined : editor}
          session={snapshot.session}
          config={config}
          onClose={() => setEditor(null)}
          onSaved={async (next) => {
            await refresh(next.sessionId);
            setEditor(null);
            if (activeRef.current === next.sessionId) setTaskId(next.id);
          }}
        />
      )}
    </div>
  );
}

function ManualInputCard({
  run,
  onRefresh,
  onCancel,
}: {
  run: Run;
  onRefresh: () => Promise<void>;
  onCancel: () => Promise<void>;
}) {
  const request = run.pendingInput!;
  const [value, setValue] = useState('');
  const [state, setState] = useState<'ready' | 'sending' | 'submitted'>('ready');
  const [error, setError] = useState('');
  const [remaining, setRemaining] = useState(() =>
    Math.max(0, Date.parse(request.expiresAt) - Date.now()),
  );
  useEffect(() => {
    const timer = setInterval(
      () => setRemaining(Math.max(0, Date.parse(request.expiresAt) - Date.now())),
      1000,
    );
    return () => clearInterval(timer);
  }, [request.expiresAt]);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (state !== 'ready' || !value.trim() || !remaining) return;
    setState('sending');
    setError('');
    try {
      await api(`/api/sessions/${run.sessionId}/runs/${run.id}/input`, {
        requestId: request.id,
        value,
      });
      setValue('');
      setState('submitted');
    } catch (e) {
      setState('ready');
      setError((e as Error).message);
    }
    await onRefresh().catch(() => {});
  }
  return (
    <section className="manual-input-card" aria-label="手动输入验证码">
      <div className="section-title">
        <strong>
          <MessageSquare size={16} /> 需要你完成验证码
        </strong>
        <span>第 {request.attempt}/3 次</span>
      </div>
      <p>当前登录会话已保留。查看截图中的图形验证码，输入后将提交当前登录表单并继续验证。</p>
      <a className="captcha-screenshot" href={request.screenshot} target="_blank" rel="noreferrer">
        <img src={request.screenshot} alt="当前验证码页面截图，点击可放大" />
      </a>
      <form onSubmit={(e) => void submit(e)}>
        <label>
          图形验证码
          <input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            maxLength={64}
            required
            disabled={state !== 'ready' || !remaining}
          />
        </label>
        <button
          className="button-primary"
          type="submit"
          disabled={state !== 'ready' || !value.trim() || !remaining}
        >
          {state === 'ready'
            ? '提交并继续'
            : state === 'sending'
              ? '提交中…'
              : '已提交，继续验证中'}
        </button>
        <button type="button" onClick={() => void onCancel()} disabled={state === 'sending'}>
          停止任务
        </button>
      </form>
      <p role="status">
        {remaining
          ? `等待输入剩余 ${Math.ceil(remaining / 1000)} 秒；页面验证码可能提前过期。`
          : '等待已超时，请重新运行任务。'}
        {request.attempt > 1 ? ' 上次提交后预期仍未满足，请检查截图中的提示并重新输入。' : ''}
      </p>
      {error && (
        <p role="alert" className="text-red">
          {error}
        </p>
      )}
    </section>
  );
}

function TaskDetail({
  task,
  snapshot,
  busy,
  onClose,
  onRun,
  onRefresh,
  onCancel,
  onEdit,
  onPatch,
  actionError,
}: {
  task: Task;
  snapshot: Snapshot;
  busy: boolean;
  onClose: () => void;
  onRun: () => void;
  onRefresh: () => Promise<void>;
  onCancel: () => Promise<void>;
  onEdit: () => void;
  onPatch: (patch: object) => void;
  actionError: string;
}) {
  const runs = snapshot.runs.filter((run) => run.taskId === task.id).reverse();
  const [runId, setRunId] = useState('');
  const latest = runs.find((r) => r.id === runId) || runs[0];
  useEffect(() => {
    const listener = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', listener);
    return () => document.removeEventListener('keydown', listener);
  }, [onClose]);
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    return () => previous?.focus();
  }, []);
  return (
    <div
      className="drawer-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <section
        className="task-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="task-detail-title"
        onKeyDown={(e) => {
          if (e.key !== 'Tab') return;
          const elements = Array.from(
            e.currentTarget.querySelectorAll<HTMLElement>(
              'button:not(:disabled),a[href],select,input:not(:disabled)',
            ),
          );
          const first = elements[0];
          const last = elements.at(-1);
          if (e.shiftKey && document.activeElement === first) {
            e.preventDefault();
            last?.focus();
          } else if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault();
            first?.focus();
          }
        }}
      >
        <div className="drawer-heading">
          <span>
            <Layers3 size={17} />
            任务详情
          </span>
          <button
            className="icon-button"
            ref={closeRef}
            aria-label="关闭任务详情"
            onClick={onClose}
          >
            <X size={20} />
          </button>
        </div>
        <div className="drawer-body">
          <div className="detail-badges">
            <span className="priority">{task.priority}</span>
            <span>{kindNames[task.kind]}</span>
            <span>{engineNames[task.engine]}</span>
            <span>{{ dom: 'DOM 发现', model: '模型规划', manual: '手动创建' }[task.source]}</span>
            {task.edited && <span>已自定义</span>}
          </div>
          <h2 id="task-detail-title">{task.title}</h2>
          <p className="detail-description">{task.description}</p>
          {task.engineNote && <p className="editor-note">{task.engineNote}</p>}
          {task.risk === 'write' && !snapshot.session.options.allowWrites && (
            <p className="editor-note">
              该任务包含交互操作。保存草稿不会授予执行权限，请在探索设置允许交互后运行。
            </p>
          )}
          <div className="task-management">
            <span>任务版本 v{task.revision || 1}</span>
            <button disabled={busy} onClick={onEdit}>
              编辑任务
            </button>
            <button disabled={busy} onClick={() => onPatch({ enabled: task.enabled === false })}>
              {task.enabled === false ? '启用任务' : '停用任务'}
            </button>
            <button disabled={busy} onClick={() => onPatch({ archived: !task.archived })}>
              {task.archived ? '恢复任务' : '归档任务'}
            </button>
          </div>
          <a className="detail-url" href={task.url} target="_blank" rel="noreferrer">
            <Globe2 size={14} />
            {task.url}
            <ExternalLink size={12} />
          </a>
          <h3>
            验证步骤 <span>{task.steps.length}</span>
          </h3>
          <ol className="step-list">
            {task.steps.map((step, index) => (
              <li key={index}>
                <span>{String(index + 1).padStart(2, '0')}</span>
                {stepLabel(step)}
              </li>
            ))}
          </ol>
          <div className="run-history-heading">
            <h3>
              执行记录 <span>{runs.length}</span>
            </h3>
            {runs.length > 1 && (
              <select
                aria-label="执行记录"
                value={latest?.id || ''}
                onChange={(e) => setRunId(e.target.value)}
              >
                {runs.map((run, index) => (
                  <option key={run.id} value={run.id}>
                    第 {runs.length - index} 次 · {clockTime(run.startedAt)} ·{' '}
                    {statusNames[run.status]}
                  </option>
                ))}
              </select>
            )}
          </div>
          {actionError && (
            <p className="error-banner" role="alert">
              {actionError}
            </p>
          )}
          {snapshot.jobs?.some(
            (job) =>
              busyStatuses.includes(job.status) &&
              job.taskIds.includes(task.id) &&
              job.activeTaskId !== task.id,
          ) && (
            <p className="editor-note">
              当前任务正在等待执行。下方展示的是之前的执行记录，开始运行后会显示新结果。
            </p>
          )}
          {latest ? (
            <>
              {latest.pendingInput && latest.status === 'waiting_input' && (
                <ManualInputCard
                  key={latest.pendingInput.id}
                  run={latest}
                  onRefresh={onRefresh}
                  onCancel={onCancel}
                />
              )}
              <div className={`run-result ${latest.status}`}>
                <StatusIcon status={latest.status} />
                <strong>{statusNames[latest.status]}</strong>
                <span>
                  {latest.durationMs !== undefined
                    ? `${(latest.durationMs / 1000).toFixed(1)}s`
                    : '执行中'}
                </span>
              </div>
              {latest.actualUrl && (
                <p className="detail-url">
                  <Globe2 size={14} />
                  <span>实际 URL：</span>
                  <a href={latest.actualUrl} target="_blank" rel="noreferrer">
                    {latest.actualUrl}
                  </a>
                </p>
              )}
              {latest.diagnosis && (
                <div className="diagnosis-panel">
                  <strong>{latest.diagnosis.title}</strong>
                  <p>{latest.diagnosis.advice}</p>
                  {latest.failedStep && (
                    <p>
                      失败位置：步骤 {latest.failedStep.index + 1} · {latest.failedStep.action}
                    </p>
                  )}
                  <button disabled={busy} onClick={onEdit}>
                    编辑此任务
                  </button>
                </div>
              )}
              {latest.assertion && latest.status === 'failed' && (
                <section className="run-definition" aria-label="断言失败详情">
                  <strong>
                    {latest.assertion.action === 'assertUrl' ? 'URL 断言' : '链接断言'}
                  </strong>
                  <pre className="error-detail">
                    {[
                      `预期 URL：${latest.assertion.expectedUrl}`,
                      `匹配模式：${
                        latest.assertion.action === 'assertLink'
                          ? '规范化 href 完整匹配（不点击）'
                          : latest.assertion.match === 'path'
                            ? '同源 + 路径（忽略 query/hash，区分尾斜线）'
                            : '规范化 URL 完整匹配（含 query/hash）'
                      }`,
                      latest.assertion.text ? `链接文本包含：${latest.assertion.text}` : '',
                      `当前 URL：${latest.assertion.actualUrl}`,
                      `等待时间：${latest.assertion.timeoutMs} 毫秒`,
                    ]
                      .filter(Boolean)
                      .join('\n')}
                  </pre>
                  {latest.assertion.action === 'assertLink' && (
                    <div aria-label="可见链接证据">
                      <p>
                        {latest.assertion.links === undefined
                          ? '未采集到链接证据，不能据此判断页面没有链接。'
                          : latest.assertion.links.length === 0
                            ? '采集时未发现可见链接。'
                            : `采集到的可见链接（${latest.assertion.links.length} 条，文本与 href 配对）：`}
                      </p>
                      {latest.assertion.links && latest.assertion.links.length > 0 && (
                        <ul>
                          {latest.assertion.links.map((link, index) => (
                            <li key={index}>
                              <pre className="error-detail">
                                {`文本：${link.text || '（无文本）'}\nhref：${link.url}`}
                              </pre>
                            </li>
                          ))}
                        </ul>
                      )}
                      {latest.assertion.linksTruncated && (
                        <p>链接证据已截断，最多展示 40 条；实际断言扫描全部可见链接。</p>
                      )}
                    </div>
                  )}
                </section>
              )}
              {latest.error && <pre className="error-detail">{latest.error}</pre>}
              {latest.taskSnapshot && (
                <details className="run-definition">
                  <summary>
                    本记录使用任务 v{latest.taskRevision || 1}
                    {(latest.taskRevision || 1) !== (task.revision || 1)
                      ? '（当前任务已修订）'
                      : ''}
                  </summary>
                  <strong>{latest.taskSnapshot.title}</strong>
                  <ol className="step-list">
                    {latest.taskSnapshot.steps.map((step, index) => (
                      <li key={index}>
                        <span>{index + 1}</span>
                        {stepLabel(step)}
                      </li>
                    ))}
                  </ol>
                </details>
              )}
              {latest.screenshot && (
                <a
                  href={latest.screenshot}
                  target="_blank"
                  rel="noreferrer"
                  className="screenshot-link"
                >
                  <img src={latest.screenshot} alt={`${task.title} 执行截图`} />
                  <span>
                    打开执行截图
                    <ExternalLink size={12} />
                  </span>
                </a>
              )}
              <div className="artifact-links">
                {latest.trace && (
                  <a href={latest.trace} download>
                    <Activity size={14} />
                    执行 Trace
                  </a>
                )}
                {latest.report && (
                  <a href={latest.report} target="_blank" rel="noreferrer">
                    <FileJson2 size={14} />
                    原始报告
                  </a>
                )}
                {latest.script && (
                  <a href={latest.script} download>
                    <FileCode2 size={14} />
                    测试代码
                  </a>
                )}
              </div>
              <div className="detail-events">
                {snapshot.events
                  .filter((e) => e.runId === latest.id)
                  .map((event) => (
                    <div key={event.id}>
                      <time>{clockTime(event.createdAt)}</time>
                      <span>{event.message}</span>
                    </div>
                  ))}
              </div>
            </>
          ) : (
            <p className="no-matches">任务尚未运行。执行后会在这里显示截图和结果。</p>
          )}
        </div>
        <div className="drawer-footer">
          <span>
            <Check size={14} />
            结果与历史保存在本机
          </span>
          <button
            className="button-primary"
            disabled={busy || !runnableTask(task)}
            onClick={() => {
              setRunId('');
              onRun();
            }}
          >
            <RotateCcw size={15} />
            运行此任务
          </button>
        </div>
      </section>
    </div>
  );
}

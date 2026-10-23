import { z } from 'zod';

export const engineSchema = z.enum(['playwright', 'tester-army', 'midscene']);
export type Engine = z.infer<typeof engineSchema>;
export const stepSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('goto'), url: z.string().url() }),
  z.object({ action: z.literal('assertPage') }),
  z.object({ action: z.literal('assertText'), text: z.string().min(1).max(500) }),
  z.object({
    action: z.literal('assertUrl'),
    url: z.string().url(),
    match: z.enum(['exact', 'path']).optional(),
    timeoutMs: z.number().int().min(100).max(30000).optional(),
  }),
  z.object({
    action: z.literal('assertLink'),
    url: z.string().url(),
    text: z.string().trim().min(1).max(500).optional(),
    timeoutMs: z.number().int().min(100).max(30000).optional(),
  }),
  z.object({ action: z.literal('navigateLink'), url: z.string().url() }),
  z.object({ action: z.literal('validateForm'), index: z.number().int().min(0).max(100) }),
  z.object({ action: z.literal('click'), selector: z.string().min(1).max(300) }),
  z.object({
    action: z.literal('fill'),
    selector: z.string().min(1).max(300),
    value: z.string().max(1000),
  }),
  z.object({ action: z.literal('aiAct'), instruction: z.string().min(1).max(2000) }),
  z.object({ action: z.literal('aiAssert'), instruction: z.string().min(1).max(2000) }),
]);
export type Step = z.infer<typeof stepSchema>;
export const optionsSchema = z.object({
  maxPages: z.number().int().min(1).max(20).default(6),
  maxDepth: z.number().int().min(0).max(4).default(2),
  engine: engineSchema.default('tester-army'),
  allowWrites: z.boolean().default(false),
});
export type Options = z.infer<typeof optionsSchema>;
export const optionsPatchSchema = z.object({
  maxPages: optionsSchema.shape.maxPages.removeDefault().optional(),
  maxDepth: optionsSchema.shape.maxDepth.removeDefault().optional(),
  engine: optionsSchema.shape.engine.removeDefault().optional(),
  allowWrites: optionsSchema.shape.allowWrites.removeDefault().optional(),
});
export type SessionStatus =
  | 'idle'
  | 'queued'
  | 'discovering'
  | 'planning'
  | 'running'
  | 'waiting_input'
  | 'completed'
  | 'failed'
  | 'cancelled';
export { busyStatuses, statusLabels, runnableTask } from './workspace.ts';
export interface Session {
  id: string;
  name: string;
  targetUrl: string;
  status: SessionStatus;
  options: Options;
  goal?: string;
  createdAt: string;
  updatedAt: string;
}
export interface Message {
  id: string;
  sessionId: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
}
export interface Observation {
  id: string;
  sessionId: string;
  url: string;
  actualUrl?: string;
  title: string;
  status: number;
  depth: number;
  links: { text: string; url: string }[];
  forms: { index: number; name: string; required: number }[];
  inputs?: { label: string; type: string; required: boolean }[];
  text: string;
  error?: string;
  screenshot?: string;
}
export interface Task {
  id: string;
  sessionId: string;
  title: string;
  description: string;
  url: string;
  kind: 'smoke' | 'navigation' | 'form' | 'visual';
  priority: 'P0' | 'P1' | 'P2';
  source: 'dom' | 'model' | 'manual';
  engine: Engine;
  risk: 'read' | 'write';
  steps: Step[];
  status: 'pending' | 'running' | 'waiting_input' | 'passed' | 'failed' | 'cancelled';
  createdAt: string;
  updatedAt?: string;
  revision?: number;
  enabled?: boolean;
  archived?: boolean;
  archivedReason?: 'user' | 'replanned';
  edited?: boolean;
  planId?: string;
  engineNote?: string;
}
export type JobMode = 'discover' | 'auto' | 'run' | 'retry' | 'continue' | 'plan';
export interface Job {
  id: string;
  sessionId: string;
  mode: JobMode;
  status: Exclude<SessionStatus, 'idle'>;
  taskIds: string[];
  total: number;
  completed: number;
  passed: number;
  failed: number;
  cancelled: number;
  activeTaskId?: string;
  currentStep?: number;
  stepCount?: number;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  warning?: string;
}
export interface RuntimeStatus {
  active?: Job;
  queued: Job[];
}
export interface Diagnosis {
  title: string;
  advice: string;
}
export interface InputRequest {
  id: string;
  type: 'image_captcha';
  screenshot: string;
  actualUrl: string;
  attempt: number;
  expiresAt: string;
}
export type CaptchaChallenge = Pick<InputRequest, 'screenshot' | 'actualUrl' | 'attempt'>;
export interface Run {
  id: string;
  sessionId: string;
  taskId: string;
  engine: Engine;
  status: 'running' | 'waiting_input' | 'passed' | 'failed' | 'cancelled';
  pendingInput?: InputRequest;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  error?: string;
  actualUrl?: string;
  failureCode?: 'captcha_required' | 'page_not_ready' | 'url_mismatch' | 'link_mismatch';
  assertion?: {
    action: 'assertUrl' | 'assertLink';
    expectedUrl: string;
    actualUrl: string;
    timeoutMs: number;
    match?: 'exact' | 'path';
    text?: string;
    links?: { text: string; url: string }[];
    linksTruncated?: boolean;
  };
  screenshot?: string;
  trace?: string;
  report?: string;
  script?: string;
  jobId?: string;
  taskRevision?: number;
  taskSnapshot?: Task;
  failedStep?: { index: number; action: Step['action'] };
  diagnosis?: Diagnosis;
}
export interface RunEvent {
  id: string;
  sessionId: string;
  runId?: string;
  level: 'info' | 'success' | 'error';
  message: string;
  createdAt: string;
  jobId?: string;
}
export interface Snapshot {
  session: Session;
  messages: Message[];
  pages: Observation[];
  tasks: Task[];
  runs: Run[];
  events: RunEvent[];
  jobs?: Job[];
}
export interface ConfigStatus {
  planner: boolean;
  midscene: boolean;
  demoUrl: string;
  engines: Engine[];
}
export const now = () => new Date().toISOString();

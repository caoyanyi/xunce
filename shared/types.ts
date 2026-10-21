import { z } from 'zod';

export const engineSchema = z.enum(['playwright', 'tester-army', 'midscene']);
export type Engine = z.infer<typeof engineSchema>;
export const stepSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('goto'), url: z.string().url() }),
  z.object({ action: z.literal('assertPage') }),
  z.object({ action: z.literal('assertText'), text: z.string().min(1).max(500) }),
  z.object({ action: z.literal('assertUrl'), url: z.string().url() }),
  z.object({ action: z.literal('assertLink'), url: z.string().url() }),
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
export type SessionStatus =
  'idle' | 'discovering' | 'running' | 'completed' | 'failed' | 'cancelled';
export interface Session {
  id: string;
  name: string;
  targetUrl: string;
  status: SessionStatus;
  options: Options;
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
  title: string;
  status: number;
  depth: number;
  links: { text: string; url: string }[];
  forms: { index: number; name: string; required: number }[];
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
  status: 'pending' | 'running' | 'passed' | 'failed' | 'cancelled';
  createdAt: string;
}
export interface Run {
  id: string;
  sessionId: string;
  taskId: string;
  engine: Engine;
  status: 'running' | 'passed' | 'failed' | 'cancelled';
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  error?: string;
  screenshot?: string;
  trace?: string;
  report?: string;
  script?: string;
}
export interface RunEvent {
  id: string;
  sessionId: string;
  runId?: string;
  level: 'info' | 'success' | 'error';
  message: string;
  createdAt: string;
}
export interface Snapshot {
  session: Session;
  messages: Message[];
  pages: Observation[];
  tasks: Task[];
  runs: Run[];
  events: RunEvent[];
}
export interface ConfigStatus {
  planner: boolean;
  midscene: boolean;
  demoUrl: string;
  engines: Engine[];
}
export const now = () => new Date().toISOString();

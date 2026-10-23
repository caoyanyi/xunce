import { createServer } from 'node:net';
import { chromium, type Browser } from 'playwright';
import { inScope, isSafeNavigation } from './policy.ts';

// Playwright only routes the first request of an HTTP redirect chain. This
// independent, browser-level CDP session pauses EVERY hop before network I/O,
// including a popup's first request. No response prefetch or URL rewriting.
export async function guardChromium(
  browser: Browser,
  endpoint: string,
  target: string,
  allowWrites: boolean,
  allResources = false,
) {
  const response = await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(5000) });
  const { webSocketDebuggerUrl } = (await response.json()) as { webSocketDebuggerUrl: string };
  const socket = new WebSocket(webSocketDebuggerUrl);
  let closing = false;
  let nextId = 0;
  const pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: NodeJS.Timeout;
      sessionId?: string;
    }
  >();
  const sessions = new Map<string, { mainFrame?: string; type: string }>();
  const settlePending = (error: Error, sessionId?: string) => {
    for (const [id, job] of pending) {
      if (sessionId && job.sessionId !== sessionId) continue;
      clearTimeout(job.timer);
      pending.delete(id);
      job.reject(error);
    }
  };
  const close = async () => {
    closing = true;
    settlePending(new Error('浏览器安全拦截器已停止'));
    // Keep interception attached until the browser is closed; detaching can
    // release paused requests. Closing is idempotent in Playwright.
    await browser.close().catch(() => {});
    socket.close();
  };
  const failClosed = (error?: unknown) => {
    if (closing) return;
    console.error('浏览器安全拦截器已停止', error);
    void close();
  };
  const send = (method: string, params: object = {}, sessionId?: string) =>
    new Promise<unknown>((resolve, reject) => {
      if (closing) return reject(new Error('浏览器安全拦截器已停止'));
      const id = ++nextId;
      const timer = setTimeout(() => {
        pending.delete(id);
        const error = new Error(`浏览器安全拦截器超时：${method}`);
        reject(error);
        failClosed(error);
      }, 5000);
      pending.set(id, { resolve, reject, timer, sessionId });
      try {
        socket.send(JSON.stringify({ id, method, params, sessionId }));
      } catch (error) {
        failClosed(error);
      }
    });
  const filter = [
    { type: 'page' },
    { type: 'iframe' },
    { type: 'worker' },
    { type: 'shared_worker' },
    { type: 'service_worker' },
    { exclude: true },
  ];
  const autoAttach = { autoAttach: true, waitForDebuggerOnStart: true, flatten: true, filter };
  const handle = async (message: {
    id?: number;
    result?: unknown;
    error?: { message: string };
    method?: string;
    sessionId?: string;
    params: {
      sessionId: string;
      targetInfo: { type: string; targetId: string };
      requestId: string;
      frameId?: string;
      resourceType: string;
      request: { url: string; method: string };
    };
  }) => {
    if (message.id) {
      const job = pending.get(message.id);
      if (!job) return;
      pending.delete(message.id);
      clearTimeout(job.timer);
      if (message.error) job.reject(new Error(message.error.message));
      else job.resolve(message.result);
      return;
    }
    const event = message.params;
    if (message.method === 'Target.attachedToTarget') {
      // Page.getFrameTree can deadlock on a popup paused before its renderer
      // starts. Chromium's top-level frame ID is the page target ID; child
      // frames have different IDs (OOPIFs have their own iframe target).
      const session = { type: event.targetInfo.type, mainFrame: event.targetInfo.targetId };
      sessions.set(event.sessionId, session);
      // A target stays paused until interception installation has acknowledged.
      try {
        // Browser-level Fetch covers dedicated workers too; their own CDP
        // sessions do not implement Fetch. Never resume before global guard setup.
        await send('Target.setAutoAttach', autoAttach, event.sessionId);
        if (!sessions.has(event.sessionId)) return;
        await send('Runtime.runIfWaitingForDebugger', {}, event.sessionId);
      } catch (error) {
        if (sessions.has(event.sessionId)) throw error;
      }
    } else if (message.method === 'Target.detachedFromTarget') {
      sessions.delete(event.sessionId);
      settlePending(new Error('浏览器目标已关闭'), event.sessionId);
    } else if (message.method === 'Fetch.requestPaused') {
      const topLevel =
        event.resourceType === 'Document' &&
        [...sessions.values()].some(
          (session) => session.type === 'page' && session.mainFrame === event.frameId,
        );
      const { url, method } = event.request;
      const blocked =
        ((allResources || topLevel) && !inScope(url, target)) ||
        (!allowWrites && (!['GET', 'HEAD', 'OPTIONS'].includes(method) || !isSafeNavigation(url)));
      try {
        await send(
          blocked ? 'Fetch.failRequest' : 'Fetch.continueRequest',
          {
            requestId: event.requestId,
            ...(blocked ? { errorReason: 'BlockedByClient' } : {}),
          },
          message.sessionId,
        );
      } catch (error) {
        if (!message.sessionId || sessions.has(message.sessionId)) throw error;
      }
    }
  };
  socket.addEventListener('message', (event) => {
    void handle(JSON.parse(String(event.data))).catch(failClosed);
  });
  socket.addEventListener('close', () => {
    for (const job of pending.values()) {
      clearTimeout(job.timer);
      job.reject(new Error('浏览器安全拦截器已断开'));
    }
    pending.clear();
    failClosed();
  });
  socket.addEventListener('error', failClosed);
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('无法连接浏览器安全拦截器')), 5000);
      socket.addEventListener(
        'open',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
      socket.addEventListener(
        'error',
        () => {
          clearTimeout(timer);
          reject(new Error('无法连接浏览器安全拦截器'));
        },
        { once: true },
      );
    });
    await send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
    await send('Target.setAutoAttach', autoAttach);
  } catch (error) {
    await close();
    throw error;
  }
  return close;
}

export async function launchGuardedChromium(
  options: Parameters<typeof chromium.launch>[0],
  target: string,
  allowWrites: boolean,
  allResources = false,
) {
  const socket = createServer();
  await new Promise<void>((resolve, reject) => {
    socket.once('error', reject);
    socket.listen(0, '127.0.0.1', resolve);
  });
  const port = (socket.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) =>
    socket.close((error) => (error ? reject(error) : resolve())),
  );
  const endpoint = `http://127.0.0.1:${port}`;
  const browser = await chromium.launch({
    ...options,
    args: [
      ...(options?.args ?? []),
      '--remote-debugging-address=127.0.0.1',
      `--remote-debugging-port=${port}`,
    ],
  });
  try {
    const close = await guardChromium(browser, endpoint, target, allowWrites, allResources);
    return { browser, endpoint, close };
  } catch (error) {
    await browser.close().catch(() => {});
    throw error;
  }
}

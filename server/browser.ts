import { existsSync } from 'node:fs';
import { chromium, type BrowserContext } from 'playwright';
import { inScope, isSafeNavigation, throwIfAborted } from './policy.ts';
export function resolveChromiumPath(): string | undefined {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  if (existsSync(chromium.executablePath())) return undefined;
  return [
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/snap/bin/chromium',
  ].find((path) => existsSync(path));
}
export const browserLaunchOptions = () => ({
  headless: true,
  ...(resolveChromiumPath() ? { executablePath: resolveChromiumPath() } : {}),
  args: ['--disable-dev-shm-usage'],
});
export async function withBrowser<T>(
  target: string,
  allowWrites: boolean,
  signal: AbortSignal,
  action: (context: BrowserContext) => Promise<T>,
): Promise<T> {
  throwIfAborted(signal);
  const browser = await chromium.launch(browserLaunchOptions());
  let context: BrowserContext | undefined;
  const cancel = () => {
    void context?.close().catch(() => {});
  };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    context = await browser.newContext({
      viewport: { width: 1440, height: 960 },
      serviceWorkers: 'block',
      acceptDownloads: false,
    });

    throwIfAborted(signal);
    context.setDefaultTimeout(12000);
    context.setDefaultNavigationTimeout(20000);
    await context.route('**/*', async (route) => {
      const req = route.request();
      if (
        req.isNavigationRequest() &&
        req.frame().parentFrame() === null &&
        (!inScope(req.url(), target) || (!allowWrites && !isSafeNavigation(req.url())))
      )
        return route.abort('blockedbyclient');
      if (!allowWrites && !['GET', 'HEAD', 'OPTIONS'].includes(req.method()))
        return route.abort('blockedbyclient');
      return route.continue();
    });
    return await action(context);
  } finally {
    signal.removeEventListener('abort', cancel);
    await context?.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

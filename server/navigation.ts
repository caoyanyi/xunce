import type { Frame, Page, Request, Response } from 'playwright';

export class LinkNavigationError extends Error {
  constructor(
    message: string,
    public page: Page,
    cause: unknown,
  ) {
    super(message, { cause });
  }
}

export async function followLink(
  source: Page,
  targetUrl: string,
): Promise<{ page: Page; status?: number }> {
  const href = new URL(targetUrl).href;
  const expected = href.split('#')[0];
  const links = source.locator('a[href]').filter({ visible: true });
  const index = await links.evaluateAll(
    (elements, url) => elements.findIndex((element) => (element as HTMLAnchorElement).href === url),
    href,
  );
  if (index < 0) throw new Error('导航链接不存在或不可见');
  const target = await links
    .nth(index)
    .evaluate((element) =>
      (element.getAttribute('target') || document.querySelector('base')?.target || '_self').trim(),
    );
  const sameTab = ['', '_self', '_top', '_parent'].includes(target.toLowerCase());
  const context = source.context();
  const requests = new Set<Request>();
  const responses = new Map<Request, Response>();
  const popups = new Set<Page>();
  const candidates = new Set<Page>();
  let selected = source;
  let settled = false;
  let resolveDestination: (value: {
    page: Page;
    request?: Request;
    error?: Error;
  }) => void = () => {};
  const destination = new Promise<{ page: Page; request?: Request; error?: Error }>((resolve) => {
    resolveDestination = resolve;
  });
  const settle = (value: { page: Page; request?: Request; error?: Error }) => {
    if (settled) return;
    settled = true;
    selected = value.page;
    resolveDestination(value);
  };
  const belongsToLink = (request: Request) => {
    let root = request;
    while (root.redirectedFrom()) root = root.redirectedFrom()!;
    return root.url().split('#')[0] === expected;
  };
  const mainRequestPage = (request: Request) => {
    try {
      const frame = request.frame();
      return frame.parentFrame() === null ? frame.page() : undefined;
    } catch {
      // A popup's initial frame can be unavailable until its page event arrives.
      return undefined;
    }
  };
  const inspect = (page: Page, sameDocument = false) => {
    if (sameTab ? page !== source : !candidates.has(page)) return;
    for (const request of requests) {
      if (!belongsToLink(request) || mainRequestPage(request) !== page || request.redirectedTo())
        continue;
      const failure = request.failure();
      if (!failure && page.url().split('#')[0] !== request.url().split('#')[0]) continue;
      settle({
        page,
        request,
        ...(failure
          ? {
              error: new Error(`链接导航失败：${failure.errorText}；目标：${request.url()}`),
            }
          : {}),
      });
      return;
    }
    // Eligibility above also covers reused named windows, including the source
    // itself. A hash change on any other page cannot satisfy this navigation.
    if (sameDocument && page.url() === href) settle({ page });
  };
  const captureRequest = (request: Request) => {
    if (request.isNavigationRequest()) requests.add(request);
  };
  const captureResponse = (response: Response) => {
    if (requests.has(response.request())) responses.set(response.request(), response);
  };
  const captureFailure = (request: Request) => {
    const page = mainRequestPage(request);
    if (!page) return;
    inspect(page);
    if (
      requests.has(request) &&
      belongsToLink(request) &&
      (sameTab ? page === source : candidates.has(page))
    ) {
      rejectNavigation(
        new Error(`链接导航失败：${request.failure()?.errorText}；目标：${request.url()}`),
      );
    }
  };
  const frameNavigated = (frame: Frame) => {
    if (frame === frame.page().mainFrame()) inspect(frame.page(), true);
  };
  const popupReceived = (page: Page) => {
    popups.add(page);
    page.on('framenavigated', frameNavigated);
    if (sameTab) return;
    // Named windows are selected by their browsing-context name, not just URL.
    void (
      target.toLowerCase() === '_blank'
        ? Promise.resolve(true)
        : page.evaluate((name) => window.name === name, target).catch(() => false)
    ).then((matches) => {
      if (!matches) return;
      candidates.add(page);
      if (!settled && candidates.size === 1) selected = page;
      inspect(page);
    });
  };
  const closed = () => settle({ page: selected, error: new Error('链接导航期间页面已关闭') });
  const timer = setTimeout(
    () =>
      settle({
        page: selected,
        error: new Error(`链接在 12000ms 内未完成目标导航：${targetUrl}`),
      }),
    12000,
  );
  let rejectNavigation: (error: Error) => void = () => {};
  const timeout = new Promise<never>((_resolve, reject) => {
    rejectNavigation = reject;
  });
  // Consume rejection even if the click fails before the first race is awaited.
  void timeout.catch(() => {});
  const deadline = setTimeout(
    () => rejectNavigation(new Error(`链接在 12000ms 内未完成目标导航：${targetUrl}`)),
    12000,
  );
  source.on('popup', popupReceived);
  source.on('framenavigated', frameNavigated);
  source.on('close', closed);
  context.on('close', closed);
  context.on('request', captureRequest);
  context.on('response', captureResponse);
  context.on('requestfailed', captureFailure);
  try {
    if (!sameTab && target.toLowerCase() !== '_blank') {
      for (const page of context.pages()) {
        if (await page.evaluate((name) => window.name === name, target).catch(() => false)) {
          candidates.add(page);
          if (page !== source) {
            page.on('framenavigated', frameNavigated);
            popups.add(page);
          }
        }
      }
    }
    // Exactly one click; navigation and its response body share one deadline.
    await Promise.race([links.nth(index).click({ timeout: 12000, noWaitAfter: true }), timeout]);
    const result = await Promise.race([destination, timeout]);
    if (result.error) throw result.error;
    const response =
      result.request && (responses.get(result.request) ?? (await result.request.response()));
    const finishResponse = async () => {
      if (!response) return;
      const error = await response.finished();
      if (error) throw error;
      const failure = result.request?.failure();
      if (failure) throw new Error(`链接导航失败：${failure.errorText}`);
    };
    // A broken body can prevent DOMContentLoaded indefinitely. Observe transport
    // completion concurrently so its real failure wins over the navigation deadline.
    await Promise.race([
      Promise.all([
        result.page.waitForLoadState('domcontentloaded', { timeout: 12000 }),
        finishResponse(),
      ]),
      timeout,
    ]);
    // Do not guess when multiple indistinguishable popups navigate to this href.
    const ambiguous =
      [...candidates].filter((page) =>
        [...requests].some(
          (request) => belongsToLink(request) && mainRequestPage(request) === page,
        ),
      ).length > 1;
    if (ambiguous) throw new Error('多个新窗口导航到同一链接，无法唯一确认目标页面');
    return { page: result.page, ...(response ? { status: response.status() } : {}) };
  } catch (error) {
    throw new LinkNavigationError(
      error instanceof Error ? error.message : String(error),
      selected,
      error,
    );
  } finally {
    clearTimeout(timer);
    clearTimeout(deadline);
    source.off('popup', popupReceived);
    source.off('framenavigated', frameNavigated);
    source.off('close', closed);
    context.off('close', closed);
    context.off('request', captureRequest);
    context.off('response', captureResponse);
    context.off('requestfailed', captureFailure);
    for (const page of popups) page.off('framenavigated', frameNavigated);
  }
}

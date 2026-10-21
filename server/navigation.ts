import type { Page, Response } from 'playwright';

export async function followLink(
  source: Page,
  targetUrl: string,
): Promise<{ page: Page; status?: number }> {
  const expected = targetUrl.split('#')[0];
  const links = source.locator('a[href]').filter({ visible: true });
  const index = await links.evaluateAll(
    (elements, url) =>
      elements.findIndex((element) => (element as HTMLAnchorElement).href.split('#')[0] === url),
    expected,
  );
  if (index < 0) throw new Error('导航链接不存在或不可见');
  const context = source.context();
  const responses = new Map<string, number>();
  const capture = (response: Response) => {
    if (response.request().isNavigationRequest())
      responses.set(response.url().split('#')[0], response.status());
  };
  let popupReceived: (page: Page) => void = () => {};
  const popup = new Promise<{ page: Page }>((resolve) => {
    popupReceived = (page) => resolve({ page });
  });
  source.on('popup', popupReceived);
  context.on('response', capture);
  // Observe both outcomes before clicking. The losing waiter handles its own rejection,
  // including cancellation/context cleanup after the popup has already won the race.
  const sameTab = source
    .waitForEvent('framenavigated', {
      timeout: 12000,
      predicate: (frame) => frame === source.mainFrame() && frame.url().split('#')[0] === expected,
    })
    .then(
      () => ({ page: source }),
      (error) => ({ error }),
    );
  const destination = Promise.race([popup, sameTab]);
  try {
    await links.nth(index).click();
    const result = await destination;
    if ('error' in result) throw result.error;
    await result.page.waitForURL((url) => url.href.split('#')[0] === expected, {
      timeout: 12000,
      waitUntil: 'domcontentloaded',
    });
    return { page: result.page, status: responses.get(result.page.url().split('#')[0]) };
  } finally {
    source.off('popup', popupReceived);
    context.off('response', capture);
  }
}

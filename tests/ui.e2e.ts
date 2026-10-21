import { test, expect } from '@playwright/test';
import { startCaptchaFixture } from './captcha-fixture.ts';
test('human CAPTCHA input survives a console reload and resumes the same run', async ({ page }) => {
  const fixture = await startCaptchaFixture(true);
  try {
    const url = `${fixture.base}/login`;
    const session = await (
      await page.request.post('/api/sessions', {
        data: { targetUrl: url, options: { engine: 'playwright', allowWrites: true } },
      })
    ).json();
    const taskResponse = await page.request.post(`/api/sessions/${session.id}/tasks`, {
      data: {
        title: '人工验证码登录',
        url,
        kind: 'form',
        engine: 'playwright',
        risk: 'write',
        steps: [
          { action: 'goto', url },
          { action: 'fill', selector: '[name=email]', value: 'qa@example.test' },
          { action: 'fill', selector: '[name=password]', value: 'fixture-password' },
          { action: 'click', selector: '[data-login]' },
          { action: 'assertUrl', url: `${fixture.base}/home` },
          { action: 'assertText', text: '登录成功' },
        ],
      },
    });
    expect(taskResponse.status()).toBe(201);
    await page.request.post(`/api/sessions/${session.id}/run`, { data: {} });
    await page.goto('/');
    await page.evaluate((id) => localStorage.setItem('explorer-session', id), session.id);
    await page.reload();
    const card = page.getByRole('region', { name: '手动输入验证码' });
    await expect(card).toBeVisible({ timeout: 30000 });
    await expect(page.locator('.session-status')).toHaveText('等待验证码');
    const image = await card.getByRole('img').getAttribute('src');
    await page.reload();
    await expect(card.getByRole('img')).toHaveAttribute('src', image!);
    await card.getByLabel('图形验证码', { exact: true }).fill('WRONG');
    await card.getByRole('button', { name: '提交并继续', exact: true }).click();
    await expect(card).toContainText('第 2/3 次', { timeout: 20000 });
    await expect(card).toContainText('上次提交后预期仍未满足');
    await card.getByLabel('图形验证码', { exact: true }).fill('Q7K9');
    await card.getByRole('button', { name: '提交并继续', exact: true }).click();
    await expect(page.locator('.session-status')).toHaveText('已完成', { timeout: 20000 });
    await expect(page.locator('.status-label.passed')).toHaveCount(1);
    expect(fixture.visits()).toBe(1);
    const snapshot = await (await page.request.get(`/api/sessions/${session.id}`)).json();
    expect(snapshot.runs).toHaveLength(1);
    expect(JSON.stringify(snapshot)).not.toContain('Q7K9');
  } finally {
    await fixture.close();
  }
});
test('conversation drives discovery, execution, evidence and failed-task reruns', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '让测试，自己发现任务.' })).toBeVisible();
  await page.getByRole('button', { name: '新建探索', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '目标 URL', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '探索设置', exact: true }).click();
  await page.getByLabel('结构化执行器').selectOption('playwright');
  await page.getByRole('button', { name: '关闭设置' }).click();
  await page.screenshot({ path: 'docs/screenshots/workspace.png', fullPage: true });
  await page.getByRole('button', { name: '试运行演示商城' }).click();
  await expect(page.getByRole('button', { name: /活动暂不可用/ })).toBeVisible({ timeout: 90000 });
  await expect(page.locator('.session-status')).toHaveText('已完成', { timeout: 90000 });
  await expect(page.locator('.status-label.failed')).toHaveCount(1);
  await page.getByRole('button', { name: '失败', exact: true }).click();
  await page.getByRole('button', { name: /活动暂不可用/ }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.locator('.error-detail')).toBeVisible();
  await expect(
    dialog.locator('.detail-url').filter({ hasText: '实际 URL：' }).getByRole('link'),
  ).toHaveAttribute('href', 'http://127.0.0.1:4319/demo/sale');
  await expect(dialog.getByRole('img')).toBeVisible();
  await page.screenshot({ path: 'docs/screenshots/failed-task.png', fullPage: true });
  await dialog.getByRole('button', { name: '运行此任务' }).click();
  await expect(dialog.getByRole('combobox', { name: '执行记录' })).toBeVisible();
  await expect(dialog.locator('.run-result')).toHaveText(/失败/, { timeout: 30000 });
  await expect(dialog.getByRole('combobox', { name: '执行记录' }).locator('option')).toHaveCount(2);
  await page.getByRole('button', { name: '关闭任务详情' }).click();
  await page.getByRole('tab', { name: /发现页面/ }).click();
  await expect(page.locator('.observed-page')).toHaveCount(6);
  await page.getByRole('tab', { name: /执行日志/ }).click();
  await expect(page.locator('.event-row').first()).toBeVisible();
  await page.getByRole('tab', { name: /测试任务/ }).click();
  await page.getByRole('button', { name: '全部', exact: true }).click();
  await page.screenshot({ path: 'docs/screenshots/results.png', fullPage: true });
  await page.reload();
  await expect(page.locator('.status-label.failed')).toHaveCount(1);
});
test('mobile layout stays within the viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '让测试，自己发现任务.' })).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
    .toBe(true);
  await page.screenshot({ path: 'docs/screenshots/mobile.png', fullPage: true });
});

test('can stop initial exploration before the task list is populated', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '新建探索', exact: true }).click();
  await page.getByRole('button', { name: '试运行演示商城' }).click();
  await page.getByRole('button', { name: '停止', exact: true }).click();
  await expect(page.locator('.session-status')).toHaveText('已停止', { timeout: 30000 });
  await expect(page.getByRole('button', { name: '试运行演示商城' })).toBeEnabled();
});

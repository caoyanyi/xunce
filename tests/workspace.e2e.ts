import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';

test('workspace supports saved settings, task editing, selected runs, revisions and reversible archiving', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: '新建探索', exact: true }).click();
  const config = await (await page.request.get('/api/config')).json();
  await page.getByRole('textbox', { name: '目标 URL', exact: true }).fill(config.demoUrl);
  await page.getByRole('button', { name: '探索设置', exact: true }).click();
  await page.getByLabel('会话名称', { exact: true }).fill('任务管理回归');
  await page.getByLabel('结构化执行器').selectOption('playwright');
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  await expect(page.getByRole('button', { name: '设置已保存' })).toBeDisabled();
  await page.getByRole('button', { name: '关闭设置' }).click();
  await page.getByRole('button', { name: '新建任务', exact: true }).click();
  const editor = page.getByRole('dialog', { name: '新建测试任务' });
  await editor.getByLabel('任务名称', { exact: true }).fill('检查首页');
  await page.screenshot({
    path: 'docs/screenshots/task-editor.png',
    fullPage: true,
    animations: 'disabled',
  });
  await editor.getByRole('button', { name: '保存任务', exact: true }).click();
  await expect(
    page.getByRole('dialog').filter({ has: page.getByRole('button', { name: '关闭任务详情' }) }),
  ).toContainText('检查首页');
  await page.getByRole('button', { name: '关闭任务详情' }).click();
  await page.getByRole('button', { name: '新建任务', exact: true }).click();
  await editor.getByLabel('任务名称', { exact: true }).fill('另一项任务');
  await editor.getByRole('button', { name: '保存任务', exact: true }).click();
  await page.getByRole('button', { name: '关闭任务详情' }).click();
  await page.getByRole('checkbox', { name: '选择任务 检查首页', exact: true }).check();
  await page.getByRole('button', { name: '运行选中', exact: true }).click();
  await expect(page.locator('.session-status')).toHaveText('已完成', { timeout: 30000 });
  await expect(page.locator('.status-label.passed')).toHaveCount(1);
  await expect(page.locator('.status-label.pending')).toHaveCount(1);
  await expect(page.getByRole('region', { name: '作业进度' })).toContainText('1/1 已完成');
  await page.getByRole('button', { name: /检查首页 页面可用性/ }).click();
  await page.getByRole('button', { name: '编辑任务', exact: true }).click();
  const editing = page.getByRole('dialog', { name: '编辑测试任务' });
  await editing.getByLabel('任务名称', { exact: true }).fill('首页修订');
  await editing.getByLabel('步骤 2 操作', { exact: true }).selectOption('assertText');
  await editing.getByLabel('预期可见文本', { exact: true }).fill('让生活');
  await editing.getByRole('button', { name: '添加步骤', exact: true }).click();
  await editing.getByLabel('步骤 3 操作', { exact: true }).selectOption('assertPage');
  await editing.getByRole('button', { name: '上移步骤 3', exact: true }).click();
  await editing.getByRole('button', { name: '保存任务' }).click();
  const details = page
    .getByRole('dialog')
    .filter({ has: page.getByRole('button', { name: '关闭任务详情' }) });
  await expect(details).toContainText('任务版本 v2');
  await expect(details.getByRole('heading', { name: '验证步骤 3', exact: true })).toBeVisible();
  await details.getByRole('button', { name: '运行此任务' }).click();
  await expect(details.locator('.run-result')).toHaveText(/通过/, { timeout: 30000 });
  const history = details.getByRole('combobox', { name: '执行记录', exact: true });
  await expect(history.locator('option')).toHaveCount(2);
  await history.selectOption((await history.locator('option').last().getAttribute('value')) || '');
  await expect(details.locator('.run-definition summary')).toContainText('当前任务已修订');
  await details.getByRole('button', { name: '运行此任务' }).click();
  await expect(history.locator('option')).toHaveCount(3);
  await expect(details.locator('.run-result')).toHaveText(/通过/, { timeout: 30000 });
  await expect(details.locator('.run-definition summary')).not.toContainText('当前任务已修订');
  await details.getByRole('button', { name: '归档任务', exact: true }).click();
  await expect(details.getByRole('button', { name: '恢复任务', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '关闭任务详情' }).click();
  await expect(page.getByRole('button', { name: /首页修订 页面可用性/ })).toHaveCount(0);
  await page.getByRole('button', { name: '已归档', exact: true }).click();
  await page.getByRole('button', { name: /首页修订 页面可用性/ }).click();
  await details.getByRole('button', { name: '恢复任务', exact: true }).click();
  await expect(details.getByRole('button', { name: '归档任务', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '关闭任务详情' }).click();
  await page.getByRole('button', { name: '全部', exact: true }).click();
  await page.screenshot({
    path: 'docs/screenshots/workspace-upgrade.png',
    fullPage: true,
    animations: 'disabled',
  });
  for (const title of ['首页修订', '另一项任务']) {
    await page.getByRole('button', { name: new RegExp(`${title} 页面可用性`) }).click();
    await details.getByRole('button', { name: '归档任务', exact: true }).click();
    await expect(details.getByRole('button', { name: '恢复任务', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: '关闭任务详情' }).click();
  }
  await page.getByRole('button', { name: '已归档', exact: true }).click();
  await expect(page.locator('.task-row')).toHaveCount(2);
  await page.getByRole('button', { name: /首页修订 页面可用性/ }).click();
  await details.getByRole('button', { name: '恢复任务', exact: true }).click();
  await page.getByRole('button', { name: '关闭任务详情' }).click();
  await page.getByRole('button', { name: '全部', exact: true }).click();
  await expect(page.locator('.task-row')).toHaveCount(1);
});

test('questions do not start work, and a queued session can be cancelled and rerun', async ({
  page,
}) => {
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(
      req.url === '/slow'
        ? '<title>Slow</title><div id="app">Loading...</div><script>setTimeout(()=>document.querySelector("#app").textContent="Ready for testing",6000)</script>'
        : '<title>Ready</title><h1>Ready for testing</h1>',
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const target = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const sessions: string[] = [];
  try {
    for (const path of ['/slow', '/fast']) {
      const s = await (
        await page.request.post('/api/sessions', {
          data: { targetUrl: target + path, options: { engine: 'playwright' } },
        })
      ).json();
      sessions.push(s.id);
      await page.request.post(`/api/sessions/${s.id}/tasks`, {
        data: {
          title: path === '/slow' ? '前方运行' : '排队任务',
          url: target + path,
          engine: 'playwright',
          kind: 'smoke',
          steps: [{ action: 'goto', url: target + path }, { action: 'assertPage' }],
        },
      });
    }
    await page.goto('/');
    await page.evaluate((id) => localStorage.setItem('explorer-session', id), sessions[1]);
    await page.reload();
    const input = page.getByLabel('测试目标或对话指令');
    await input.fill('为什么不能自动登录？');
    await page.getByRole('button', { name: '发送测试目标' }).click();
    await expect(page.locator('.chat-messages')).toContainText('当前会话未允许交互');
    expect(
      (await (await page.request.get(`/api/sessions/${sessions[1]}`)).json()).jobs,
    ).toHaveLength(0);
    await page.request.post(`/api/sessions/${sessions[0]}/run`, { data: {} });
    await page.request.post(`/api/sessions/${sessions[1]}/run`, { data: {} });
    await expect(page.locator('.session-status')).toHaveText('排队中');
    await expect(page.getByRole('region', { name: '作业进度' })).toContainText('队列第 1 位');
    await page.getByRole('button', { name: '停止', exact: true }).click();
    await expect(page.locator('.session-status')).toHaveText('已停止');
    await page.getByRole('button', { name: '运行全部', exact: true }).click();
    await expect(page.locator('.session-status')).toHaveText('已完成', { timeout: 30000 });
    await expect(page.locator('.status-label.passed')).toHaveCount(1);
  } finally {
    for (const id of sessions) await page.request.post(`/api/sessions/${id}/cancel`, { data: {} });
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test('the task editor remains usable on a narrow screen', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const config = await (await page.request.get('/api/config')).json();
  const s = await (
    await page.request.post('/api/sessions', {
      data: { targetUrl: config.demoUrl, options: { engine: 'playwright' } },
    })
  ).json();
  await page.goto('/');
  await page.evaluate((id) => localStorage.setItem('explorer-session', id), s.id);
  await page.reload();
  await page.getByRole('button', { name: '新建任务', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '新建测试任务' });
  await expect(dialog.getByRole('button', { name: '保存任务' })).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
    .toBe(true);
  expect(
    await dialog.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return rect.top >= 0 && rect.bottom <= innerHeight;
    }),
  ).toBe(true);
  await page.screenshot({ path: 'docs/screenshots/task-editor-mobile.png' });
  await dialog.getByRole('button', { name: '添加步骤', exact: true }).click();
  await dialog.getByRole('button', { name: '添加步骤', exact: true }).click();
  await expect(dialog.locator('.editor-steps > li')).toHaveCount(4);
  expect(
    await dialog
      .getByRole('button', { name: '保存任务' })
      .evaluate((element) => element.getBoundingClientRect().bottom <= innerHeight),
  ).toBe(true);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
});

test('a run rejected by preflight displays its reason inside task details', async ({ page }) => {
  const config = await (await page.request.get('/api/config')).json();
  const s = await (
    await page.request.post('/api/sessions', {
      data: { targetUrl: config.demoUrl, options: { engine: 'playwright' } },
    })
  ).json();
  await page.request.post(`/api/sessions/${s.id}/tasks`, {
    data: {
      title: '只读交互草稿',
      url: config.demoUrl,
      engine: 'playwright',
      kind: 'form',
      steps: [
        { action: 'goto', url: config.demoUrl },
        { action: 'fill', selector: 'input', value: 'fixture' },
        { action: 'assertPage' },
      ],
    },
  });
  await page.goto('/');
  await page.evaluate((id) => localStorage.setItem('explorer-session', id), s.id);
  await page.reload();
  await page.getByRole('button', { name: /只读交互草稿 表单校验/ }).click();
  const details = page.getByRole('dialog', { name: '只读交互草稿' });
  await details.getByRole('button', { name: '运行此任务' }).click();
  await expect(details.getByRole('alert')).toContainText('交互');
  expect((await (await page.request.get(`/api/sessions/${s.id}`)).json()).jobs).toHaveLength(0);
});

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { browserLaunchOptions } from '../server/browser.ts';
import { assertionContext, captchaControls, readPageState } from '../server/page-state.ts';

let browser: Browser;
let page: Page;
beforeAll(async () => {
  browser = await chromium.launch(browserLaunchOptions());
});
beforeEach(async () => {
  page = await browser.newPage();
});
afterEach(async () => {
  await page.close();
});
afterAll(async () => {
  await browser?.close();
});

describe('browser-supplied assertion evidence', () => {
  it.each([
    ['<form><input name="captcha"><button>Checkout</button></form>', false],
    ['<form><input name="captcha"><input name="captcha2"><button>Log in</button></form>', false],
    ['<form><input name="captcha" disabled><button>Log in</button></form>', false],
    ['<div><input name="captcha"><button>Log in</button></div>', true],
    [
      '<div><input type="password"><input placeholder="Enter image code"><div style="cursor:pointer"><span>Log in</span></div></div>',
      true,
    ],
    ['<div><input name="captcha"><h1>Log in</h1></div>', false],
    [
      '<form><input type="password"><input name="captcha" value="wrong"><button type="submit">Continue</button></form>',
      true,
    ],
  ])(
    'requires one visible challenge and an identifiable login control: %s',
    async (html, expected) => {
      await page.setContent(html);
      const controls = await captchaControls(page);
      expect(Boolean(controls)).toBe(expected);
      await controls?.input.dispose();
      await controls?.submit.dispose();
    },
  );
  it.each([
    ['<input placeholder="Enter image code" aria-invalid="true">', true],
    ['<input aria-label="图形验证码" aria-invalid="true">', true],
    ['<input name="captcha" aria-invalid="true" value="test-fixture">', false],
    ['<input name="captcha" aria-invalid="true" style="display:none">', false],
    ['<div style="opacity:0"><input name="captcha" aria-invalid="true"></div>', false],
    ['<input name="captcha" aria-invalid="true" disabled>', false],
    ['<input placeholder="Enter image code" aria-invalid="false">', false],
    ['<input placeholder="短信验证码" aria-invalid="true">', false],
    ['<input type="email" aria-invalid="true">', false],
  ])(
    'checks visible invalid verification fields without guessing values: %s',
    async (html, expected) => {
      await page.setContent(html);
      expect((await readPageState(page)).missingImageCaptcha).toBe(expected);
    },
  );
  it('keeps credential values out of the collected state and tolerates a closed page', async () => {
    await page.setContent('<input type="password" value="fixture-password">');
    const state = await readPageState(page);
    expect(JSON.stringify(state)).not.toContain('fixture-password');
    expect(state.actualUrl).toBe(page.url());
    await page.close();
    expect(await readPageState(page)).toMatchObject({
      actualUrl: 'about:blank',
      missingImageCaptcha: false,
    });
  });
  it('retains execution guidance alongside the actual browser address', () => {
    const context = assertionContext('Stay on the approved origin.', {
      actualUrl: 'https://example.test/login',
      missingImageCaptcha: true,
    });
    expect(context).toContain('Stay on the approved origin.');
    expect(context).toContain('https://example.test/login');
    expect(context).toContain('"missingImageCaptcha":true');
  });
});

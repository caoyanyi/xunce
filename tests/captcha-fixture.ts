import { createServer } from 'node:http';

// Application-owned, fixed test challenge. No external site or model is involved.
export async function startCaptchaFixture(useDivButton = false) {
  const submissions: Record<string, string>[] = [];
  let visits = 0;
  const server = createServer(async (req, res) => {
    if (req.url === '/login' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const input = JSON.parse(body) as Record<string, string>;
      submissions.push({ ...input, cookie: req.headers.cookie || '' });
      const ok =
        input.email === 'qa@example.test' &&
        input.password === 'fixture-password' &&
        input.captcha === 'Q7K9' &&
        input.nonce === 'same-page-nonce' &&
        req.headers.cookie === 'qa=live-context';
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok }));
      return;
    }
    res.setHeader('content-type', 'text/html; charset=utf-8');
    if (req.url === '/home') {
      res.end('<title>Home</title><h1>登录成功 · 首页</h1>');
      return;
    }
    visits++;
    res.setHeader('set-cookie', 'qa=live-context; HttpOnly; SameSite=Strict; Path=/');
    res.end(`<!doctype html><title>CAPTCHA fixture</title>
      <style>body{font:18px sans-serif;padding:40px}form{display:grid;gap:16px;max-width:340px}label{display:grid;gap:6px}input,button{font:inherit;padding:10px}svg{background:#edf4f1}</style>
      <h1>测试登录</h1><form novalidate>
      <label>邮箱<input name="email" type="email"></label>
      <label>密码<input name="password" type="password"></label>
      <input type="hidden" name="nonce" value="same-page-nonce">
      <svg width="160" height="55" aria-label="测试图形验证码"><text x="20" y="35">Q7K9</text></svg>
      <label>图形验证码<input name="captcha" aria-invalid="false"></label>
      <p role="alert"></p>${useDivButton ? '<div data-login style="cursor:pointer"><span>Log in</span></div>' : '<button data-login type="submit">Log in</button>'}</form>
      <script>
      ${useDivButton ? "document.querySelector('[data-login]').addEventListener('click', () => document.forms[0].requestSubmit());" : ''}
      document.forms[0].addEventListener('submit', async (event) => {
        event.preventDefault();
        const form = event.target;
        const values = Object.fromEntries(new FormData(form));
        if (!values.captcha) {
          form.elements.captcha.setAttribute('aria-invalid', 'true');
          document.querySelector('[role=alert]').textContent = '请输入图形验证码';
          return;
        }
        const response = await fetch('/login', {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(values)});
        if ((await response.json()).ok) location.href = '/home';
        else {
          form.elements.captcha.setAttribute('aria-invalid', 'true');
          document.querySelector('[role=alert]').textContent = '验证码错误，请重新输入';
        }
      });
      </script>`);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture address');
  return {
    base: `http://127.0.0.1:${address.port}`,
    submissions,
    visits: () => visits,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

import type { FastifyInstance } from 'fastify';
const style = `<style>body{margin:0;background:#f6f5f0;color:#193a36;font:16px/1.6 ui-sans-serif,sans-serif}header,main{max-width:960px;margin:auto;padding:28px}header{display:flex;align-items:center;gap:28px;border-bottom:1px solid #deded5}header strong{margin-right:auto;font-size:24px}a{color:#137d71}h1{font-size:46px;line-height:1.2}article{padding:24px;background:white;margin:18px 0;border-radius:8px}input{display:block;padding:12px;margin:8px 0 20px;width:280px;border:1px solid #bccac6;border-radius:5px}button{background:#137d71;color:white;border:0;border-radius:5px;padding:12px 24px;cursor:pointer}.muted{color:#61716b}.tag{font-size:12px;padding:4px 10px;background:#e3ebe0;display:inline-block}label{display:block}</style>`;
function layout(title: string, content: string) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title} · 森屿商店</title>${style}</head><body><header><strong>森屿 / ISLE</strong><a href="/demo">首页</a><a href="/demo/products">全部商品</a><a href="/demo/login">会员登录</a><a href="/demo/help">帮助中心</a></header><main>${content}<p class="muted">巡测内置演示站点 · 所有内容仅用于本机测试</p></main></body></html>`;
}
export function registerDemo(app: FastifyInstance) {
  app.get('/demo', async (_, reply) =>
    reply
      .type('text/html')
      .send(
        layout(
          '首页',
          '<span class="tag">日常的好东西</span><h1>让生活，轻一点。</h1><p>从一只杯子开始，重新发现日常之美。</p><article><h2>秋日精选</h2><p>自然材质，实用设计。为每一个平凡的日子准备。</p><a href="/demo/products">发现全部商品 →</a></article><a href="/demo/sale">查看限时活动 →</a>',
        ),
      ),
  );
  app.get('/demo/products', async (_, reply) =>
    reply
      .type('text/html')
      .send(
        layout(
          '全部商品',
          '<h1>日常精选</h1><article><h2>山间陶瓷杯</h2><p>手工烧制 / 300ml</p><strong>¥ 89.00</strong><p><a href="/demo/products/cup">查看商品详情 →</a></p></article><article><h2>原木收纳盘</h2><p>北美白橡木 / 自然原色</p><strong>¥ 129.00</strong></article>',
        ),
      ),
  );
  app.get('/demo/products/cup', async (_, reply) =>
    reply
      .type('text/html')
      .send(
        layout(
          '山间陶瓷杯',
          '<span class="tag">手作系列</span><h1>山间陶瓷杯</h1><p>让每一口水，都有自然的温度。</p><article><p>容量：300ml</p><p>材质：高温陶土</p><strong>¥ 89.00</strong></article><a href="/demo/products">返回全部商品</a>',
        ),
      ),
  );
  app.get('/demo/login', async (_, reply) =>
    reply
      .type('text/html')
      .send(
        layout(
          '会员登录',
          '<h1>欢迎回来</h1><p>登录森屿会员，查看您的收藏。</p><form aria-label="会员登录" action="/demo/login" method="post"><label>邮箱<input type="email" name="email" autocomplete="username" placeholder="you@example.com" required></label><label>密码<input type="password" name="password" autocomplete="current-password" minlength="6" required></label><button type="submit">登录</button></form>',
        ),
      ),
  );
  app.get('/demo/help', async (_, reply) =>
    reply
      .type('text/html')
      .send(
        layout(
          '帮助中心',
          '<h1>我们可以帮您什么？</h1><article><h2>配送需要多久？</h2><p>常规订单将在 2–3 个工作日内发出。</p></article><article><h2>如何申请退换？</h2><p>收货后 7 天内可申请退换，请保留商品包装。</p></article>',
        ),
      ),
  );
  app.get('/demo/sale', async (_, reply) =>
    reply
      .code(500)
      .type('text/html')
      .send(
        layout(
          '活动暂不可用',
          '<h1>活动页面出了点问题</h1><p>这是一个故意保留的演示故障：HTTP 500。</p><p>巡测应该自动发现这个页面，并在执行报告中标记失败。</p><a href="/demo">返回首页</a>',
        ),
      ),
  );
}

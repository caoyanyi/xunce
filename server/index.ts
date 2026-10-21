import 'dotenv/config';
import { createApp } from './app.ts';
const port = Number(process.env.PORT || 4318);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error('PORT 必须在 1–65535 之间');
const { app } = await createApp({ logger: true });
await app.listen({ host: process.env.HOST || '0.0.0.0', port });
for (const signal of ['SIGTERM', 'SIGINT'] as const)
  process.on(signal, () => {
    void app.close();
  });

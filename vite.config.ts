import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const host = env.HOST || '0.0.0.0';
  const apiHost = host === '0.0.0.0' ? '127.0.0.1' : host === '::' ? '[::1]' : host;
  const target = `http://${apiHost}:${env.PORT || 4318}`;
  return {
    plugins: [react()],
    server: {
      host,
      allowedHosts: true,
      proxy: { '/api': target, '/artifacts': target, '/demo': target },
    },
    build: { outDir: 'dist' },
  };
});

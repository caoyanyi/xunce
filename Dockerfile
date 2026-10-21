ARG NODE_IMAGE=node:24-bookworm-slim

FROM ${NODE_IMAGE} AS build
WORKDIR /app
ARG NPM_REGISTRY=https://registry.npmjs.org
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --registry=${NPM_REGISTRY}
COPY tsconfig.json tsconfig.server.json vite.config.ts index.html ./
COPY server ./server
COPY shared ./shared
COPY web ./web
COPY tests ./tests
RUN npm run build && npm prune --omit=dev \
    && node --input-type=module -e "await import('@midscene/web/playwright'); await import('e2e/runner')"

FROM ${NODE_IMAGE} AS runtime
ARG DEBIAN_MIRROR=mirrors.aliyun.com
RUN sed -i "s|http://deb.debian.org|http://${DEBIAN_MIRROR}|g" /etc/apt/sources.list.d/debian.sources \
    && apt-get -o Acquire::Retries=3 -o Acquire::http::Timeout=30 update \
    && apt-get -o Acquire::Retries=3 -o Acquire::http::Timeout=30 install -y --no-install-recommends chromium fonts-noto-cjk fonts-liberation ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4318 \
    DATA_DIR=/app/data \
    CHROMIUM_PATH=/usr/bin/chromium
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/build ./build
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node scripts/smoke-container.mjs ./scripts/smoke-container.mjs
RUN mkdir -p /app/data && chown node:node /app/data
USER node
EXPOSE 4318
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "build/server/index.js"]

FROM node:24-alpine
RUN apk add --no-cache chromium font-noto-cjk
WORKDIR /opt/runner
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund && npm cache clean --force
COPY runner.mjs ./runner.mjs
ENV NODE_ENV=production
# Chromium writes its crash/config database even in headless mode. Keep those
# writes inside the existing tmpfs so the runner root filesystem stays read-only.
ENV XDG_CONFIG_HOME=/tmp/chromium-config XDG_CACHE_HOME=/tmp/chromium-cache
USER node
ENTRYPOINT ["node", "/opt/runner/runner.mjs"]

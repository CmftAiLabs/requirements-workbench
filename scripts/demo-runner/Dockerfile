FROM node:24-alpine
RUN apk add --no-cache chromium font-noto-cjk
WORKDIR /opt/runner
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund && npm cache clean --force
COPY runner.mjs ./runner.mjs
ENV NODE_ENV=production
USER node
ENTRYPOINT ["node", "/opt/runner/runner.mjs"]

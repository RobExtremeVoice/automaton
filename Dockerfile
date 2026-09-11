FROM node:22-bookworm-slim AS builder

WORKDIR /app

RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/cli/package.json packages/cli/package.json

RUN pnpm install --frozen-lockfile

COPY tsconfig.json vitest.config.ts ./
COPY src ./src
COPY packages ./packages
COPY constitution.md ./

RUN pnpm typecheck && pnpm build

FROM node:22-bookworm-slim AS runtime

RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV HOME=/home/node

WORKDIR /app

COPY --from=builder --chown=node:node /app/package.json ./
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/dist ./dist
COPY --from=builder --chown=node:node /app/packages ./packages
COPY --from=builder --chown=node:node /app/constitution.md ./

RUN mkdir -p /home/node/.automaton && chown -R node:node /home/node /app

USER node

ENTRYPOINT ["node", "dist/index.js"]
CMD ["--run"]

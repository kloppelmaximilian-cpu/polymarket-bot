# syntax=docker/dockerfile:1.7
# One Dockerfile, three targets: api, worker, web.
#   docker compose build            (see docker-compose.yml)
#   docker build --target api -t aoc-api .
ARG NODE_IMAGE=node:22-bookworm-slim

# ─────────────────────────────────────────────────────────────── build ──
FROM ${NODE_IMAGE} AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=1 NEXT_TELEMETRY_DISABLED=1
RUN corepack enable
WORKDIR /app
# Behind a TLS-intercepting corporate proxy, pass its CA as an optional secret:
#   docker build --secret id=ca,src=/path/to/ca.pem --build-arg HTTPS_PROXY=… .
# (HTTP(S)_PROXY / NO_PROXY are predefined build args; nothing is stored in the image.)
# Dependencies first (cached unless the lockfile changes).
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store --mount=type=secret,id=ca,required=false \
    if [ -f /run/secrets/ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/ca npm_config_cafile=/run/secrets/ca; fi; \
    pnpm fetch
COPY . .
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --offline --frozen-lockfile
RUN pnpm --filter @aoc/api build \
 && pnpm --filter @aoc/worker build \
 && NEXT_OUTPUT=standalone pnpm --filter @aoc/web build
# Self-contained production folders: bundle + migrations + prod node_modules only.
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm --filter @aoc/api deploy --legacy --prod /out/api \
 && pnpm --filter @aoc/worker deploy --legacy --prod /out/worker

# ───────────────────────────────────────────────────────────── runtime ──
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
USER node

FROM runtime AS api
COPY --from=build --chown=node:node /out/api /app
ENV API_HOST=0.0.0.0 API_PORT=4000
EXPOSE 4000
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.API_PORT||4000)+'/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]

FROM runtime AS worker
COPY --from=build --chown=node:node /out/worker /app
# Operator CLI inside the container: docker compose exec worker node dist/cli.js doctor
CMD ["node", "dist/main.js"]

FROM runtime AS web
COPY --from=build --chown=node:node /app/apps/web/.next/standalone /app
COPY --from=build --chown=node:node /app/apps/web/.next/static /app/apps/web/.next/static
ENV PORT=3000 HOSTNAME=0.0.0.0
EXPOSE 3000
CMD ["node", "apps/web/server.js"]

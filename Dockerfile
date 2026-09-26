FROM oven/bun:1.4.2-alpine AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

FROM oven/bun:1.4.2-alpine
WORKDIR /app
# CLUSTER_SERVERS=0 runs one standalone server; N runs the agent (PORT) plus N game
# servers on PORT+1..PORT+N (see docs/cluster.md for the other variables).
ENV NODE_ENV=production \
    PORT=3000 \
    CLUSTER_SERVERS=0
COPY shared/src shared/src
COPY server/src server/src
COPY --from=build /app/client/dist client/dist
USER bun
EXPOSE 3000-3004
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1
CMD ["bun", "server/src/supervisor.ts"]

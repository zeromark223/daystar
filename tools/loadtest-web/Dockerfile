# The load test with its web UI (tools/loadtest-web): the bots run in this
# container, the browser drives them. Build from the repo root (it needs shared/
# and server/ too): docker build -f tools/loadtest-web/Dockerfile . Point it at a server with LOADTEST_TARGET
# (or the Target field in the UI); with no target it spawns a server in here.
FROM oven/bun:1.4.2-alpine
# tini as PID 1: forwards signals and reaps the bot and server processes a run spawns.
RUN apk add --no-cache tini
WORKDIR /app
# LOADTEST_TOKEN guards the UI (one is made up and logged if unset); HEALTH_TOKEN
# is the target's /api/health token. Set both as secrets, not here.
ENV NODE_ENV=production \
    LOADTEST_PORT=3100
COPY package.json ./
COPY shared/src shared/src
# For runs without a target, which spawn a server in the container.
COPY server/src server/src
COPY tools/loadtest.ts tools/loadtest.ts
COPY tools/voice tools/voice
COPY tools/loadtest-web tools/loadtest-web
# Each run's CSV goes here (lost with the container; download it from the UI).
RUN mkdir loadtest-logs && chown bun:bun loadtest-logs
USER bun
EXPOSE 3100
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:3100/healthz || exit 1
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["bun", "tools/loadtest-web/server.ts"]

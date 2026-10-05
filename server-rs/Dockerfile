# Daystar's Rust game server (standalone), with the web client.
# Build from the repository root:
#   docker build -f server-rs/Dockerfile -t daystar-rs .
#   docker run -p 3000:3000 -e ROOM_SECRET=... daystar-rs

FROM oven/bun:1.4.2-alpine AS client
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY client client
COPY shared shared
RUN bun run build

FROM rust:1-slim-bookworm AS server
WORKDIR /src
COPY server-rs/Cargo.toml server-rs/Cargo.lock ./
# Dependencies in their own layer, rebuilt only when Cargo.lock changes.
RUN mkdir src && echo 'fn main() {}' > src/main.rs && cargo build --release && rm -rf src
COPY server-rs/src src
RUN touch src/main.rs && cargo build --release

FROM debian:bookworm-slim
WORKDIR /app
# RS_THREADS=1 matches Bun's single thread; 0 uses every core.
ENV PORT=3000 \
    HOST=0.0.0.0 \
    RS_THREADS=1 \
    CLIENT_DIR=/app/client/dist
COPY --from=server /src/target/release/daystar-rs /app/daystar-rs
COPY --from=client /app/client/dist /app/client/dist
USER 65534
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s CMD ["/app/daystar-rs", "healthcheck"]
CMD ["/app/daystar-rs"]

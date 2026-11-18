# Questlog server image: the bundled server (one JS file, no node_modules) and the built web app on Node's slim image.
#   docker build -t questlog-server .
#   docker run -d -p 8780:8780 -v questlog-data:/data questlog-server
# See README "Run a Questlog server with Docker". NODE_VERSION must equal scripts/node-version.txt (the build checks).
# podman/buildah: build with `--format docker`, or the OCI format drops the HEALTHCHECK.
ARG NODE_VERSION=26.13.1

FROM node:${NODE_VERSION}-bookworm-slim AS build
ARG PNPM_VERSION=10.33.2
WORKDIR /src
RUN npm install -g --no-fund --no-audit "pnpm@${PNPM_VERSION}"
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN test "$(node --version)" = "v$(tr -d '[:space:]v' < scripts/node-version.txt)" \
      || { echo "Dockerfile NODE_VERSION differs from scripts/node-version.txt" >&2; exit 1; }
# The archive layout of scripts/package-server.sh without its runtime/: server/server.mjs (+ migrations/) and web/
# beside it, which server/webRoot.ts finds on its own.
RUN pnpm build \
 && node scripts/build-server.mjs /out/server \
 && cp -r dist/web /out/web \
 && cp LICENSE NOTICE.md /out/

FROM node:${NODE_VERSION}-bookworm-slim
RUN groupadd --system --gid 10001 questlog \
 && useradd --system --uid 10001 --gid questlog --home-dir /nonexistent --no-create-home --shell /usr/sbin/nologin questlog \
 && mkdir /data && chown questlog:questlog /data
COPY --from=build /out /app
# JT_LOOPBACK_TRUST=0: in a container 127.0.0.1 can be a forwarded remote caller (userspace Tailscale sidecar, rootless
# port forwarding), so JATIFY_ADMIN_TOKEN never acts as the owner on /team/* and setup's body tailscaleLogin is ignored.
ENV NODE_ENV=production \
    JT_DB=/data/questlog.db \
    JT_FILES=/data/files \
    JT_HOST=0.0.0.0 \
    PORT=8780 \
    JT_LOOPBACK_TRUST=0
WORKDIR /data
USER questlog
VOLUME ["/data"]
EXPOSE 8780
# The check calls the address the server listens on (JT_HOST), loopback when it listens on all addresses.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "const h = process.env.JT_HOST || ''; const a = !h || h === '0.0.0.0' || h === '::' ? '127.0.0.1' : h.includes(':') ? `[${h}]` : h; fetch(`http://${a}:${process.env.PORT}/healthz`).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "/app/server/server.mjs"]

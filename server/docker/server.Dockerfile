FROM node:22.23.2-bookworm-slim@sha256:48e4b67d85f87bd551df43704e24d252f56cc5f8e9718841aace50f19948f0f9 AS node-build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY app/src app/src
COPY shared shared
COPY scripts/portable-sources.ts scripts/
RUN npm run build -- --sourceMap false && npm prune --omit=dev && find node_modules -type f -name '*.map' -delete

FROM mcr.microsoft.com/dotnet/sdk:10.0-noble@sha256:2fa828c68761b1b8c23d7662dc134421b9d3b59fe1425fdbc80804e390cdb24d AS worker-build
WORKDIR /app
COPY upstream/LibProsperoPKG-drakmor upstream/LibProsperoPKG-drakmor
COPY upstream/UFS2Tool upstream/UFS2Tool
COPY worker worker
RUN dotnet publish worker/PS5Library.Worker.csproj -c Release -o /worker --no-self-contained -p:DebugType=None -p:DebugSymbols=false
# Exercise the actual package and image builders on Linux during the image build.
RUN dotnet run --project worker/Tests/PS5Library.Worker.Checks.csproj -c Release

FROM mcr.microsoft.com/dotnet/runtime:10.0-noble@sha256:8a153b5889d796b6450295b383596b13308c24c230515f8a7770ce1b94e0c460
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates ffmpeg libgomp1 && rm -rf /var/lib/apt/lists/*
COPY --from=node-build /usr/local/bin/node /usr/local/bin/node
COPY --from=node-build /usr/local/LICENSE /licenses/Node.js-LICENSE
WORKDIR /app
COPY --from=node-build /app/node_modules node_modules
COPY --from=node-build /app/dist dist
COPY --from=worker-build /worker worker/bin/Release/net10.0
COPY --from=worker-build /app/upstream/LibProsperoPKG-drakmor/LICENSE /licenses/LibProsperoPKG-GPL-3.0
COPY --from=worker-build /app/upstream/LibProsperoPKG-drakmor/NOTICE /licenses/LibProsperoPKG-NOTICE
COPY --from=worker-build /app/upstream/UFS2Tool/LICENSE /licenses/UFS2Tool-BSD-2-Clause
RUN --mount=type=bind,source=.,target=/build-context,ro \
    if [ -f /build-context/LICENSE ]; then install -m 644 /build-context/LICENSE /licenses/PS5Library-LICENSE; else printf '%s\n' 'No server-scoped license was present at build time; release checks prohibit publishing this image.' > /licenses/PS5Library-LICENSE-MISSING; fi
COPY package.json ./
COPY app/public app/public
COPY app/schema.sql app/schema.sql
RUN test -z "$(find . -type f \( -name '*.map' -o -name '*.pdb' \) -print -quit)" \
    && test -z "$(find dist worker app -type f \( -name '*.ts' -o -name '*.cs' \) -print -quit)"
RUN install -d -m 1777 /worker-ipc
USER app
ENV HOST=0.0.0.0 DATA_DIR=/data SOURCE_ROOT=/data/sources DUMP_ROOT=/dumps TRAILER_WORKER_MODE=LOCAL
CMD ["node", "dist/app/src/main.js"]

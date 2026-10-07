# 오케스트레이터 이미지(T-138). 빌드 컨텍스트는 레포 루트(infra/compose/docker-compose.yml 의 orchestrator.build).
# 실행 이미지는 node:24-slim + git(D2: 읽기 전용으로 마운트한 /repo 에서 git sha/dirty 를 읽는다).
# runs·repo 경로는 env(RUNS_DIR·REPO_DIR)로 받는다. 컨테이너 제어는 socket-proxy 경유(DOCKER_HOST)만.
FROM node:24-slim AS build
RUN corepack enable
WORKDIR /repo

# 의존성 레이어: 매니페스트만 먼저 복사
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY orchestrator/package.json orchestrator/
COPY engine/contracts/package.json engine/contracts/
RUN pnpm install --frozen-lockfile --filter "@under-load/orchestrator..."

COPY engine/contracts engine/contracts
COPY orchestrator orchestrator
RUN pnpm --filter "@under-load/orchestrator..." run build \
  && pnpm --filter "@under-load/orchestrator" deploy --prod --legacy /out

FROM node:24-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out ./
USER node
EXPOSE 4000 4001
# exec form: PID 1 시그널 전달(SIGTERM → 리스너 close). init(tini)은 compose 의 `init: true` 로 붙인다.
ENTRYPOINT ["node", "dist/main.js"]

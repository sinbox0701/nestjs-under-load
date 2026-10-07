# 실험 대상 app 이미지. 빌드 컨텍스트는 레포 루트(infra/compose/docker-compose.yml에서 지정).
# 이미지는 한 번만 빌드하고, 실행마다 바뀌는 시나리오·strategy는 RunConfig(부팅 시 읽음)로 정한다(DESIGN §5.3).
FROM node:24-slim AS build
RUN corepack enable
WORKDIR /repo

# 의존성 레이어: 매니페스트만 먼저 복사
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/app/package.json apps/app/
COPY engine/contracts/package.json engine/contracts/
COPY packs/generic/g01-shared-document/package.json packs/generic/g01-shared-document/
COPY packs/generic/g02-stock-decrement/package.json packs/generic/g02-stock-decrement/
RUN pnpm install --frozen-lockfile --filter "@under-load/app..."

COPY apps/app apps/app
COPY engine engine
COPY packs packs
RUN pnpm --filter "@under-load/app..." run build \
  && pnpm --filter "@under-load/app" deploy --prod --legacy /out

FROM node:24-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out ./
USER node
EXPOSE 3000
# exec form: PID 1 시그널 전달. init(tini)은 compose의 `init: true`로 붙인다.
ENTRYPOINT ["node", "dist/main.js"]

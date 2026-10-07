# 웹 이미지(T-120): 정적 빌드 + nginx(비루트). 빌드 컨텍스트는 레포 루트다.
#   docker build -f web/Dockerfile .
# 웹이 packs/**·engine/contracts/fixtures 를 raw import 하므로 레포 루트가 필요하다.
# 컨텍스트에서 node_modules·dist·.git 은 .dockerignore 로 제외한다.
FROM node:24-slim AS build
RUN corepack enable
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile --filter @nul/web...
RUN pnpm --filter @nul/web build

FROM nginxinc/nginx-unprivileged:1.28-alpine
COPY web/nginx.conf /etc/nginx/nginx.conf
COPY --from=build /repo/web/dist /usr/share/nginx/html
# 비루트(uid 101)로 실행. 80 은 compose 포트 매핑(8080:80)에 맞춘 것 — Docker 는 컨테이너 안 비특권 포트 하한을 0 으로 둔다.
EXPOSE 80
HEALTHCHECK --interval=5s --timeout=3s --retries=10 \
  CMD wget -q -O /dev/null http://127.0.0.1:80/ || exit 1

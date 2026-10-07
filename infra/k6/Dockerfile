# k6 실행기 이미지: grafana/k6 의 k6 바이너리 + node:24 기반 실행기(server.mjs, C7).
# 태그는 infra/compose/docker-compose.yml 의 k6 이미지와 같게 유지한다.
FROM grafana/k6:1.3.0 AS k6bin

FROM node:24-slim
COPY --from=k6bin /usr/bin/k6 /usr/local/bin/k6
WORKDIR /app
# 빌드 컨텍스트는 레포 루트(compose context ../..)다.
COPY infra/k6/server.mjs ./
EXPOSE 7070
HEALTHCHECK --interval=5s --timeout=3s --retries=10 \
  CMD node -e "fetch('http://127.0.0.1:7070/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
USER node
CMD ["node", "server.mjs"]

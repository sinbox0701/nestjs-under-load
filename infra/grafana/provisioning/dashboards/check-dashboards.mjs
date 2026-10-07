#!/usr/bin/env node
// 대시보드 JSON 정적 검사(T-117, T-118 공용).
//   node infra/grafana/provisioning/dashboards/check-dashboards.mjs [대시보드.json ...]   (기본: infra/grafana/dashboards/*.json)
// 규칙: UID 가 contracts DASHBOARD_UIDS 안, 템플릿 변수 run_id, 태그 주석(nul + run:$run_id),
//       패널·변수 PromQL 의 지표 이름이 contracts METRIC_NAMES · 실측 k6_* 목록 · 외부 exporter 접두사 안.
// contracts 는 dist 로 소비한다(없으면 `pnpm --filter @under-load/contracts exec tsc -p tsconfig.json`).
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { METRIC_NAMES, DASHBOARD_UIDS, DASHBOARD_RUN_VAR, GRAFANA_ANNOTATION_TAG } from '../../../../engine/contracts/dist/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const DASHBOARD_DIR = path.resolve(here, '../../dashboards');

/** k6 1.3.0 + experimental-prometheus-rw(native histogram) 를 Prometheus 에 한 번 써서 확인한 이름(T-117). */
export const K6_METRICS = Object.freeze([
  'k6_data_received_total',
  'k6_data_sent_total',
  'k6_dropped_iterations_total',
  'k6_http_req_blocked_seconds',
  'k6_http_req_connecting_seconds',
  'k6_http_req_duration_seconds',
  'k6_http_req_failed_rate',
  'k6_http_req_receiving_seconds',
  'k6_http_req_sending_seconds',
  'k6_http_req_tls_handshaking_seconds',
  'k6_http_req_waiting_seconds',
  'k6_http_reqs_total',
  'k6_iteration_duration_seconds',
  'k6_iterations_total',
  'k6_vus',
  'k6_vus_max',
]);

/** 외부 exporter 지표(cAdvisor·postgres/redis/nginx exporter)는 이름 목록이 아니라 접두사로 허용한다. */
export const EXTERNAL_PREFIXES = Object.freeze(['container_', 'pg_', 'redis_', 'nginx_']);

const HIST_SUFFIX = /_(bucket|sum|count)$/;
const KEYWORDS = new Set(['bool', 'offset', 'and', 'or', 'unless', 'inf', 'nan', 'by', 'without', 'on', 'ignoring', 'group_left', 'group_right']);

/** PromQL 식 → 지표 이름 목록(라벨 이름·함수·집계·변수·문자열은 뺀다). */
export function extractMetricNames(expr) {
  let s = String(expr);
  s = s.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '""'); // 문자열
  s = s.replace(/\$\{[^}]*\}|\$\w+/g, 'X'); // Grafana 변수
  s = s.replace(/\{[^}]*\}/g, ''); // 라벨 매처
  s = s.replace(/\[[^\]]*\]/g, ''); // 범위·서브쿼리
  s = s.replace(/\b(by|without|on|ignoring|group_left|group_right)\s*\([^)]*\)/g, ''); // 라벨 목록
  const names = [];
  for (const m of s.matchAll(/[a-zA-Z_:][a-zA-Z0-9_:]*/g)) {
    const next = s.slice(m.index + m[0].length).match(/^\s*(.)/)?.[1];
    if (next === '(') continue; // 함수·집계
    if (KEYWORDS.has(m[0]) || m[0] === 'X') continue;
    names.push(m[0]);
  }
  return names;
}

/** 변수 쿼리 `label_values(지표{…}, 라벨)` 는 첫 인자를, `query_result(식)` 은 식을 PromQL 로 본다. */
export function promqlOfVariableQuery(q) {
  const text = typeof q === 'string' ? q : (q?.query ?? q?.expr ?? '');
  const lv = text.match(/^\s*label_values\((.*),\s*[a-zA-Z_]\w*\s*\)\s*$/s);
  if (lv) return lv[1];
  if (/^\s*label_values\(\s*[a-zA-Z_]\w*\s*\)\s*$/.test(text)) return '';
  const qr = text.match(/^\s*query_result\((.*)\)\s*$/s);
  return qr ? qr[1] : text;
}

export function isAllowedMetric(name, allowed = defaultAllowed()) {
  if (allowed.has(name) || allowed.has(name.replace(HIST_SUFFIX, ''))) return true;
  return EXTERNAL_PREFIXES.some((p) => name.startsWith(p));
}

export function defaultAllowed() {
  return new Set([...METRIC_NAMES, ...K6_METRICS]);
}

function* walkPanels(panels = []) {
  for (const p of panels) {
    yield p;
    if (Array.isArray(p.panels)) yield* walkPanels(p.panels);
  }
}

/** 대시보드 JSON 하나 검사. 문제 목록(빈 배열이면 통과). */
export function checkDashboard(dash, { allowed = defaultAllowed() } = {}) {
  const errors = [];
  const id = dash?.uid ?? '(uid 없음)';
  if (!DASHBOARD_UIDS.includes(dash?.uid)) errors.push(`${id}: uid 가 DASHBOARD_UIDS 에 없다`);
  if (!(dash.templating?.list ?? []).some((v) => v.name === DASHBOARD_RUN_VAR)) errors.push(`${id}: 템플릿 변수 ${DASHBOARD_RUN_VAR} 없음`);
  const runTag = `run:$${DASHBOARD_RUN_VAR}`;
  const tagAnno = (dash.annotations?.list ?? []).find(
    (a) => a.target?.type === 'tags' && a.enable !== false && (a.target.tags ?? []).includes(runTag) && (a.target.tags ?? []).includes(GRAFANA_ANNOTATION_TAG),
  );
  if (!tagAnno) errors.push(`${id}: 태그 주석(${GRAFANA_ANNOTATION_TAG}, ${runTag}) 없음`);

  const exprs = [];
  for (const p of walkPanels(dash.panels)) {
    for (const t of p.targets ?? []) if (typeof t.expr === 'string') exprs.push([`패널 "${p.title ?? p.id}"`, t.expr]);
  }
  for (const v of dash.templating?.list ?? []) {
    if (v.type === 'query') exprs.push([`변수 ${v.name}`, promqlOfVariableQuery(v.query)]);
  }
  for (const [where, expr] of exprs) {
    const names = extractMetricNames(expr);
    if (names.length === 0 && where.startsWith('패널')) errors.push(`${id} ${where}: 지표 이름을 찾지 못함 — ${expr}`);
    for (const n of names) if (!isAllowedMetric(n, allowed)) errors.push(`${id} ${where}: 허용되지 않은 지표 ${n}`);
  }
  return errors;
}

export function checkFiles(files) {
  const errors = [];
  for (const f of files) {
    let dash;
    try {
      dash = JSON.parse(readFileSync(f, 'utf8'));
    } catch (e) {
      errors.push(`${path.basename(f)}: JSON 파싱 실패 ${e.message}`);
      continue;
    }
    for (const e of checkDashboard(dash)) errors.push(`${path.basename(f)}: ${e}`);
  }
  return errors;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const files = args.length ? args : readdirSync(DASHBOARD_DIR).filter((f) => f.endsWith('.json')).map((f) => path.join(DASHBOARD_DIR, f));
  const errors = checkFiles(files);
  if (errors.length) {
    console.error(errors.join('\n'));
    process.exit(1);
  }
  console.log(`대시보드 ${files.length}개 통과`);
}

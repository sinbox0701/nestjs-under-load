#!/usr/bin/env node
// 대시보드 JSON 정적 검사(T-117, T-118 공용).
//   node infra/grafana/provisioning/dashboards/check-dashboards.mjs [대시보드.json ...]   (기본: infra/grafana/dashboards/*.json)
// 규칙: UID 가 contracts DASHBOARD_UIDS 안, 템플릿 변수 run_id, 태그 주석(nul + run:$run_id; 실행 개요·부하 발생기만),
//       패널·변수 PromQL 의 지표 이름이 contracts METRIC_NAMES · 실측 k6_* 목록 · 실측 외부 exporter 목록 안.
// contracts 는 dist 로 소비한다(없으면 `pnpm --filter @under-load/contracts exec tsc -p tsconfig.json`).
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { METRICS, METRIC_NAMES, DASHBOARD_UIDS, DASHBOARD_RUN_VAR, GRAFANA_ANNOTATION_TAG } from '../../../../engine/contracts/dist/index.js';

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

/**
 * 외부 exporter 지표는 접두사 허용이 아니라 실측 확인한 이름만 허용한다(T-117, cAdvisor v0.52.1·postgres-exporter v0.17.1).
 * 새 지표를 쓰려면 실제 스크레이프에서 이름을 확인한 뒤 여기에 추가한다.
 */
export const EXTERNAL_METRICS = Object.freeze([
  // cAdvisor
  'container_cpu_usage_seconds_total',
  'container_cpu_cfs_periods_total',
  'container_cpu_cfs_throttled_periods_total',
  'container_cpu_cfs_throttled_seconds_total',
  'container_memory_working_set_bytes',
  'container_spec_cpu_period',
  'container_spec_cpu_quota',
  // postgres-exporter
  'pg_locks_count',
  'pg_settings_max_connections',
  'pg_stat_activity_count',
  'pg_stat_activity_max_tx_duration',
  'pg_stat_database_blks_hit',
  'pg_stat_database_blks_read',
  'pg_stat_database_deadlocks',
  'pg_stat_database_numbackends',
  'pg_stat_database_temp_bytes',
  'pg_stat_database_temp_files',
  'pg_stat_database_xact_commit',
  'pg_stat_database_xact_rollback',
  'pg_wal_segments',
  'pg_wal_size_bytes',
  // 기본 수집기 밖이지만 옵션을 켜 이름을 실측함: --collector.stat_checkpointer, --collector.stat_user_tables(테이블이 있어야 시리즈가 생긴다)
  'pg_stat_checkpointer_num_requested_total',
  'pg_stat_checkpointer_num_timed_total',
  'pg_stat_checkpointer_sync_time_total',
  'pg_stat_checkpointer_write_time_total',
  'pg_stat_user_tables_n_dead_tup',
  // 실측 불가: 커스텀 쿼리(queries.yaml)가 만드는 이름. T-118 use-pg 대시보드 설명에 켜는 방법이 있다.
  'pg_wait_event_count',
]);

/** `_bucket`/`_sum`/`_count` 접미사를 벗겨 볼 수 있는 histogram 지표(contracts METRICS 의 histogram). k6 지표는 native histogram 이라 접미사 없이 쓴다. */
export const HISTOGRAM_METRICS = Object.freeze(METRICS.filter((m) => m.type === 'histogram').map((m) => m.name));

/** phase 주석(태그 쿼리)을 요구하는 대시보드. 나머지(RED·USE)는 변수 run_id 만 요구한다. */
export const TAG_ANNOTATION_UIDS = Object.freeze(['nul-run-overview', 'nul-loadgen']);

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
  if (allowed.has(name)) return true;
  const m = name.match(HIST_SUFFIX);
  return m !== null && HISTOGRAM_METRICS.includes(name.slice(0, -m[0].length));
}

export function defaultAllowed() {
  return new Set([...METRIC_NAMES, ...K6_METRICS, ...EXTERNAL_METRICS]);
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
  if (!tagAnno && TAG_ANNOTATION_UIDS.includes(dash?.uid)) errors.push(`${id}: 태그 주석(${GRAFANA_ANNOTATION_TAG}, ${runTag}) 없음`);

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

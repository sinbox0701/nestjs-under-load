// check-dashboards.mjs 단위 테스트 + 실제 대시보드 JSON 검사(T-117 AC-2~4).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { checkDashboard, checkFiles, extractMetricNames, promqlOfVariableQuery, isAllowedMetric, DASHBOARD_DIR } from './check-dashboards.mjs';

test('extractMetricNames: 함수·라벨·변수·범위는 빼고 지표 이름만', () => {
  assert.deepEqual(
    extractMetricNames('histogram_quantile(0.95, sum by (le, route) (rate(lab_http_request_duration_seconds_bucket{run_id="$run_id",status=~"2.."}[$__rate_interval])))'),
    ['lab_http_request_duration_seconds_bucket'],
  );
  assert.deepEqual(extractMetricNames('sum(a_total{x="1"}) / on(instance) sum(b_total)'), ['a_total', 'b_total']);
  assert.deepEqual(extractMetricNames('vector(1)'), []);
});

test('promqlOfVariableQuery: label_values 의 첫 인자', () => {
  assert.equal(promqlOfVariableQuery('label_values(k6_vus{a="b"}, run_id)'), 'k6_vus{a="b"}');
  assert.equal(promqlOfVariableQuery({ query: 'label_values(k6_vus, run_id)' }), 'k6_vus');
});

test('isAllowedMetric: contracts · k6 · 외부 접두사만 허용', () => {
  assert.ok(isAllowedMetric('lab_http_request_duration_seconds_bucket'));
  assert.ok(isAllowedMetric('k6_http_req_duration_seconds'));
  assert.ok(isAllowedMetric('container_cpu_usage_seconds_total'));
  assert.ok(!isAllowedMetric('k6_made_up_total'));
  assert.ok(!isAllowedMetric('lab_made_up_total'));
});

const base = () => ({
  uid: 'nul-loadgen',
  templating: { list: [{ name: 'run_id' }] },
  annotations: { list: [{ enable: true, target: { type: 'tags', tags: ['nul', 'run:$run_id'] } }] },
  panels: [{ title: 'p', targets: [{ expr: 'sum(rate(k6_iterations_total{run_id="$run_id"}[30s]))' }] }],
});

test('checkDashboard: 정상 / 변수·주석·지표 이름 위반 각각', () => {
  assert.deepEqual(checkDashboard(base()), []);
  const noVar = base();
  noVar.templating.list = [];
  assert.match(checkDashboard(noVar).join(), /run_id 없음/);
  const noAnno = base();
  noAnno.annotations.list[0].target.tags = ['nul'];
  assert.match(checkDashboard(noAnno).join(), /태그 주석/);
  const badMetric = base();
  badMetric.panels[0].targets[0].expr = 'rate(k6_unknown_total[1m])';
  assert.match(checkDashboard(badMetric).join(), /k6_unknown_total/);
  const badUid = { ...base(), uid: 'other' };
  assert.match(checkDashboard(badUid).join(), /DASHBOARD_UIDS/);
});

test('infra/grafana/dashboards/*.json 전체 통과', () => {
  const files = readdirSync(DASHBOARD_DIR).filter((f) => f.endsWith('.json')).map((f) => path.join(DASHBOARD_DIR, f));
  assert.ok(files.length >= 2);
  assert.deepEqual(checkFiles(files), []);
});

test('run-overview: 첫 패널이 정합성 텍스트 패널(지표 판정 흉내 금지, AC-4)', () => {
  const d = JSON.parse(readFileSync(path.join(DASHBOARD_DIR, 'run-overview.json'), 'utf8'));
  assert.equal(d.uid, 'nul-run-overview');
  const top = [...d.panels].sort((a, b) => a.gridPos.y - b.gridPos.y || a.gridPos.x - b.gridPos.x)[0];
  assert.equal(top.type, 'text');
  assert.match(top.options.content, /불변식 결과는 오케스트레이터 판정\(DB 원장\) — 실행 기록 화면 참조/);
  assert.equal(top.targets, undefined);
});

test('loadgen-validity: uid nul-loadgen', () => {
  const d = JSON.parse(readFileSync(path.join(DASHBOARD_DIR, 'loadgen-validity.json'), 'utf8'));
  assert.equal(d.uid, 'nul-loadgen');
});

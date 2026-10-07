// G01 k6 스크립트 (1단계: loadtest/lib 사용. 파라미터 목록은 params.schema.json)
// MODEL=closed(고정 VU, G01 기본) | open(constant-arrival-rate). closed 의 VU 수 = 같은 문서를 다투는 "사람 수".
// 한 번의 반복 = 사람 한 명이 문서 하나를 열어(GET) → EDIT_MS 동안 고치고 → 저장한다.
// STRATEGY 는 서버 strategy 와 같은 값을 넘긴다. 클라이언트가 409·423 을 받았을 때 하는 행동이 strategy 마다 다르기 때문이다.
// 웜업은 같은 스크립트를 PHASE=warmup 으로 별도 실행한다(끝난 뒤 manifest 의 discardSql 이 흔적을 지운다).
// import 경로: 레포 루트 기준 packs/generic/g01-shared-document/k6 → ../../../../loadtest/lib.
// 컨테이너에서는 /packs 와 /loadtest 를 같은 부모(/)에 마운트해야 풀린다.
import http from 'k6/http';
import { sleep } from 'k6';
import { Counter } from 'k6/metrics';
import { buildOptions, readEnv, createRng, makePicker, buildHeaders, thinkTimeSeconds } from '../../../../loadtest/lib/index.mjs';
import { FIELDS, makeEditToken, buildPutBody, buildPatchBody, blindRetryBody } from './client.mjs';

const env = (k, d) => (__ENV[k] !== undefined && __ENV[k] !== '' ? __ENV[k] : d);

const E = readEnv(__ENV);
const DOC_MIN = Number(env('DOC_MIN', '1'));
const DOC_MAX = Number(env('DOC_MAX', '5'));
const EDIT_MS = Number(env('EDIT_MS', '50'));
const LEASE_RETRY_MS = Number(env('LEASE_RETRY_MS', '20'));
const STRATEGY = env('STRATEGY', 'optimistic-version');

const STRATEGIES = ['naive-overwrite', 'blind-retry', 'optimistic-version', 'field-merge', 'edit-lease'];
if (!STRATEGIES.includes(STRATEGY)) throw new Error(`STRATEGY must be one of ${STRATEGIES.join('|')}, got "${STRATEGY}"`);

// 충돌 뒤 "다시 읽고 다시 적용"을 몇 번까지 되풀이할지. 무한 재시도는 부하를 키워 비교를 흐리므로 상한을 둔다.
const MAX_REAPPLY = 3;
// edit-lease: 잠금을 얻으려 기다리는 최대 시간. 서버가 줄을 세워 주지 않으므로 오래 못 얻는 사람(굶주림)이 생길 수 있다.
const MAX_LOCK_WAIT_MS = 10000;

// 카운터는 응답 단위다. success=저장 200 응답, conflict_409=409 응답(재시도 포함),
// locked_423=lease acquire 거절 응답, failed=계약 밖 응답(5xx·타임아웃·4xx 등).
// 재시도를 다 쓰고 포기한 편집은 failed 가 아니라 "반복 수 - success"로 드러난다(409·423 은 정상 거절이다).
const success = new Counter('g01_success');
const conflict409 = new Counter('g01_conflict_409');
const locked423 = new Counter('g01_locked_423');
const failed = new Counter('g01_failed');

export const options = buildOptions(__ENV);

// VU 별 시드 고정 PRNG(init 컨텍스트는 VU 마다 한 번 실행된다).
const rng = createRng(E.SEED, __VU);
const pickDoc = makePicker(rng, E, DOC_MIN, DOC_MAX);

// 요청 하나. 시도마다 새 X-Request-Id 를 쓴다(원장은 request_id 유니크, 거절된 시도는 원장에 남지 않는다).
function send(method, path, body, okStatuses, name) {
  const res = http.request(method, `${E.BASE_URL}${path}`, body === null ? null : JSON.stringify(body), {
    headers: buildHeaders(rng, __VU, __ITER, E.REP_ACTORS, crypto.randomUUID()),
    timeout: E.REQUEST_TIMEOUT,
    // 409·423 은 설계된 거절이라 http_req_failed 에서 뺀다.
    responseCallback: http.expectedStatuses(...okStatuses),
    tags: { phase: E.PHASE, name },
  });
  if (res.status === 409) conflict409.add(1);
  else if (res.status === 423) locked423.add(1);
  else if (!okStatuses.includes(res.status)) failed.add(1);
  return res;
}

function json(res) {
  try {
    return res.json();
  } catch (_) {
    return null;
  }
}

// 문서를 연다(화면을 여는 순간). 실패하면 null.
function openDoc(docId) {
  const res = send('GET', `/g01/documents/${docId}`, null, [200], 'GET /g01/documents/:id');
  return res.status === 200 ? json(res) : null;
}

// 사람이 고치는 시간. 이 동안 다른 사람이 같은 버전을 읽고 먼저 저장할 수 있다 → 충돌의 창.
function edit() {
  if (EDIT_MS > 0) sleep(EDIT_MS / 1000);
}

// ── strategy 별 클라이언트 ─────────────────────────────────────────────

// naive-overwrite: 서버가 버전을 비교하지 않으므로 충돌이 없다. 409 도 없고 재시도도 없다. 대신 앞사람 수정이 조용히 사라진다.
function runNaive(docId, field, token) {
  const doc = openDoc(docId);
  if (!doc) return;
  edit();
  const res = send('PUT', `/g01/documents/${docId}`, buildPutBody(doc, field, token), [200], 'PUT /g01/documents/:id');
  if (res.status === 200) success.add(1);
}

// blind-retry: 409 를 "버전만 새로 받으면 되는 일시 오류"로 오해한 클라이언트(broken).
// 재시도는 한 번. 같은 본문에 currentVersion 만 바꿔 다시 PUT 한다 — fields 를 다시 계산하지 않는다(blindRetryBody).
function runBlindRetry(docId, field, token) {
  const doc = openDoc(docId);
  if (!doc) return;
  edit();
  const body = buildPutBody(doc, field, token);
  let res = send('PUT', `/g01/documents/${docId}`, body, [200, 409], 'PUT /g01/documents/:id');
  if (res.status === 409) {
    const currentVersion = json(res)?.currentVersion;
    if (typeof currentVersion !== 'number') {
      failed.add(1); // 계약 밖 409 본문
      return;
    }
    // 여기가 핵심: 다시 GET 하지 않는다. body.fields 는 처음 읽은 옛 배열 그대로이고 version 만 현재 값이 된다.
    // 서버는 version 이 맞으니 저장하고, 그 사이 커밋된 앞사람 토큰은 이 저장에 덮여 사라진다.
    res = send('PUT', `/g01/documents/${docId}`, blindRetryBody(body, currentVersion), [200, 409], 'PUT /g01/documents/:id');
  }
  if (res.status === 200) success.add(1);
}

// optimistic-version: 409 를 받으면 다시 GET → 내 편집을 최신 필드에 다시 적용 → 새 버전으로 PUT (fixed).
// 다시 적용하는 건 "내 토큰을 최신 배열 뒤에 붙이는 것"이라 순간적이고, 편집 시간(EDIT_MS)은 다시 쓰지 않는다.
function runOptimistic(docId, field, token) {
  let doc = openDoc(docId);
  if (!doc) return;
  edit();
  for (let attempt = 0; attempt <= MAX_REAPPLY; attempt++) {
    const res = send('PUT', `/g01/documents/${docId}`, buildPutBody(doc, field, token), [200, 409], 'PUT /g01/documents/:id');
    if (res.status === 200) {
      success.add(1);
      return;
    }
    if (res.status !== 409) return;
    doc = openDoc(docId); // 최신본을 다시 읽어야 앞사람 수정이 내 본문에 들어온다
    if (!doc) return;
  }
}

// field-merge: 바뀐 필드만 PATCH. 다른 사람이 같은 필드를 고치지 않았다면 충돌하지 않는다.
// 같은 필드끼리 충돌(409)하면 optimistic 과 같이 다시 GET → 최신 필드 뒤에 내 토큰을 붙여 PATCH.
function runFieldMerge(docId, field, token) {
  let doc = openDoc(docId);
  if (!doc) return;
  edit();
  for (let attempt = 0; attempt <= MAX_REAPPLY; attempt++) {
    const res = send('PATCH', `/g01/documents/${docId}`, buildPatchBody(doc, field, token), [200, 409], 'PATCH /g01/documents/:id');
    if (res.status === 200) {
      success.add(1);
      return;
    }
    if (res.status !== 409) return;
    doc = openDoc(docId);
    if (!doc) return;
  }
}

// edit-lease: 편집 전에 잠금(acquire)을 얻는다. 잠금은 서버가 줄을 세워 주지 않는다 — 423 이면 클라이언트가 기다렸다 다시 시도한다(폴링).
// 순서 보장이 없으니 운 나쁜 사람은 계속 밀릴 수 있다(굶주림). 잠금을 얻은 뒤에 읽으므로 내가 읽은 버전은 잠금 동안 바뀌지 않는다.
function runEditLease(docId, field, token) {
  const holder = `vu${__VU}-it${__ITER}`;
  const leasePath = `/g01/documents/${docId}/lease`;
  const started = Date.now();
  let fence = null;
  while (fence === null) {
    const res = send('POST', leasePath, { holder }, [200, 423], 'POST /g01/documents/:id/lease');
    if (res.status === 200) {
      fence = json(res)?.fence ?? null;
      if (fence === null) {
        failed.add(1); // 계약 밖 acquire 본문
        return;
      }
    } else if (res.status === 423) {
      if (Date.now() - started >= MAX_LOCK_WAIT_MS) return; // 포기. 423 응답 수가 대기 압력을 보여 준다
      // Retry-After 헤더는 초 단위(최소 1초)라 ms 단위로 압축한 편집 시간보다 훨씬 길다.
      // 그래서 LEASE_RETRY_MS 간격으로 폴링한다. 이 폴링이 곧 "서버 큐 없음"의 비용이다.
      sleep(LEASE_RETRY_MS / 1000);
    } else {
      return; // send 가 failed 로 센 계약 밖 응답
    }
  }
  try {
    const doc = openDoc(docId);
    if (!doc) return;
    edit(); // 잠금을 쥔 채 편집한다 → EDIT_MS 가 길수록 다른 사람의 대기와 423 이 늘어난다
    // fence 를 같이 보낸다: 잠금이 만료돼 다른 사람 것이 되었다면 서버가 409 lease_lost|lease_expired 로 거절한다.
    const body = buildPutBody(doc, field, token, { holder, fence });
    const res = send('PUT', `/g01/documents/${docId}`, body, [200, 409], 'PUT /g01/documents/:id');
    if (res.status === 200) success.add(1);
  } finally {
    // 저장이 실패해도 놓아야 다음 사람이 TTL 만료까지 기다리지 않는다.
    send('DELETE', leasePath, { holder, fence }, [204, 409], 'DELETE /g01/documents/:id/lease');
  }
}

const RUNNERS = {
  'naive-overwrite': runNaive,
  'blind-retry': runBlindRetry,
  'optimistic-version': runOptimistic,
  'field-merge': runFieldMerge,
  'edit-lease': runEditLease,
};

export default function () {
  // k6 는 한 번도 add 하지 않은 Counter 를 summary 에 내지 않는다. 0 건이어도 네 카운터가 보이도록 첫 반복에 0 을 더한다.
  if (__ITER === 0) {
    success.add(0);
    conflict409.add(0);
    locked423.add(0);
    failed.add(0);
  }
  const docId = pickDoc();
  const field = FIELDS[Math.floor(rng() * FIELDS.length)]; // field-merge 에서 필드가 갈릴 때만 충돌이 줄어든다
  const token = makeEditToken(crypto.randomUUID());
  RUNNERS[STRATEGY](docId, field, token);
  const think = thinkTimeSeconds(rng, E.THINK_MIN_MS, E.THINK_MAX_MS);
  if (think > 0) sleep(think);
}

export function handleSummary(data) {
  const out = { stdout: `phase=${E.PHASE} done\n` };
  if (E.SUMMARY_PATH) out[E.SUMMARY_PATH] = JSON.stringify(data, null, 2);
  return out;
}

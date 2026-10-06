/**
 * 실제 실행 이벤트 NDJSON 로더(DESIGN §9.1 이벤트 프로토콜 한 줄 = 이벤트 하나).
 *   {"v":1,"runId":"…","ts":1759745523123456,"seq":10233,"instance":"app-2","reqId":"r_8f2c",
 *    "actor":"17-3","phase":"lock_wait","durMs":null,"attrs":{…},"sampled":true,"injected":false}
 * ts(epoch µs)를 기록 시작부터의 실제 ms로 정규화하고, ts → seq → instance → 원래 줄 순으로 정렬한다(v는 1만 받는다).
 * 잘못된 줄은 버리고 줄 번호와 이유를 errors에 남긴다(로더는 던지지 않는다).
 */
import { COMMON_PHASES } from './types';
import type { CodeRef, Phase, Recording, RecordingMeta, RunEvent } from './types';

export interface WireEvent {
  v: number;
  runId: string;
  ts: number;
  seq: number;
  instance: string;
  reqId?: string;
  traceId?: string;
  actor: string;
  entity?: { type: string; id: string };
  phase: string;
  durMs?: number | null;
  attrs?: Record<string, string | number | boolean | null>;
  sampled?: boolean;
  injected?: boolean;
  /** 확장(선택): 코드 위치·SQL 샘플·영향 행 수·한 줄 설명. */
  codeRef?: string;
  sql?: string;
  rows?: number;
  note?: string;
}

export interface NdjsonError {
  line: number;
  reason: string;
}

export interface NdjsonOptions {
  /** 기록 메타(시나리오·strategy 등). 없는 값은 이벤트에서 채운다. */
  meta?: Partial<RecordingMeta>;
  /** 대표 표본(sampled)만 쓸지. 기본 true. */
  onlySampled?: boolean;
  /** 마지막 이벤트 뒤 여유(ms). 기본 20. */
  tailMs?: number;
}

const PHASES = new Set<string>(COMMON_PHASES);
const isPhase = (p: unknown): p is Phase =>
  typeof p === 'string' && (PHASES.has(p) || /^custom:[\w-]+$/.test(p));
const isCodeRef = (s: unknown): s is CodeRef => typeof s === 'string' && /^.+:\d+$/.test(s);

function check(raw: unknown): WireEvent | string {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return '객체가 아님';
  const o = raw as Record<string, unknown>;
  if (o.v !== 1) return `모르는 프로토콜 버전 v=${String(o.v)}`;
  if (typeof o.runId !== 'string') return 'runId 없음';
  if (typeof o.ts !== 'number' || !Number.isFinite(o.ts)) return 'ts(epoch µs) 없음';
  if (typeof o.seq !== 'number') return 'seq 없음';
  if (typeof o.instance !== 'string') return 'instance 없음';
  if (typeof o.actor !== 'string') return 'actor 없음';
  if (!isPhase(o.phase)) return `모르는 phase ${String(o.phase)}`;
  return o as unknown as WireEvent;
}

/** NDJSON 문자열 → 줄별 이벤트(검증 포함). */
export function parseNdjson(text: string): { events: WireEvent[]; errors: NdjsonError[] } {
  const events: WireEvent[] = [];
  const errors: NdjsonError[] = [];
  text.split(/\r?\n/).forEach((line, idx) => {
    const s = line.trim();
    if (!s) return;
    let raw: unknown;
    try {
      raw = JSON.parse(s);
    } catch {
      errors.push({ line: idx + 1, reason: 'JSON 아님' });
      return;
    }
    const r = check(raw);
    if (typeof r === 'string') errors.push({ line: idx + 1, reason: r });
    else events.push(r);
  });
  return { events, errors };
}

/** 줄별 이벤트 → 재생용 Recording. */
export function toRecording(wire: WireEvent[], opts: NdjsonOptions = {}): Recording {
  const onlySampled = opts.onlySampled ?? true;
  const list = wire
    .filter((e) => !onlySampled || e.sampled !== false)
    .map((e, i) => ({ e, i }))
    // 전순서(안정): ts → seq → instance → 원래 줄 순. 인스턴스 사이 seq 비교도 해서 비교 함수가 추이적이다.
    .sort(
      (a, b) =>
        a.e.ts - b.e.ts ||
        a.e.seq - b.e.seq ||
        (a.e.instance < b.e.instance ? -1 : a.e.instance > b.e.instance ? 1 : 0) ||
        a.i - b.i,
    )
    .map((x) => x.e);
  const ts0 = list[0]?.ts ?? 0;
  const actors: string[] = [];
  const events: RunEvent[] = list.map((w) => {
    if (!actors.includes(w.actor)) actors.push(w.actor);
    const ev: RunEvent = {
      id: `${w.instance}#${w.seq}`,
      t: (w.ts - ts0) / 1000,
      actor: w.actor,
      phase: w.phase as Phase,
    };
    if (w.reqId) ev.reqId = w.reqId;
    if (typeof w.durMs === 'number') ev.durMs = w.durMs;
    if (w.injected) ev.injected = true;
    if (isCodeRef(w.codeRef)) ev.codeRef = w.codeRef;
    if (typeof w.sql === 'string') ev.sql = w.sql;
    if (typeof w.rows === 'number') ev.rows = w.rows;
    if (typeof w.note === 'string') ev.note = w.note;
    const attrs = { ...(w.attrs ?? {}), instance: w.instance };
    if (w.entity) Object.assign(attrs, { entityType: w.entity.type, entityId: w.entity.id });
    ev.attrs = attrs;
    return ev;
  });
  const last = events[events.length - 1];
  const m = opts.meta ?? {};
  const meta: RecordingMeta = {
    runId: m.runId ?? list[0]?.runId ?? 'unknown',
    pack: m.pack ?? '',
    scenario: m.scenario ?? '',
    scenarioTitle: m.scenarioTitle ?? m.scenario ?? '',
    strategy: m.strategy ?? { id: '', label: '', kind: 'broken' },
    sceneType: m.sceneType ?? 'generic-timeline',
    actors: m.actors ?? actors,
    totalActors: m.totalActors ?? actors.length,
    isolation: m.isolation ?? 'READ COMMITTED',
    route: m.route ?? '',
    durationMs: m.durationMs ?? (last ? last.t + (opts.tailMs ?? 20) : 0),
    ...(m.autoStopDelayMs !== undefined ? { autoStopDelayMs: m.autoStopDelayMs } : {}),
    ...(m.actorLabels ? { actorLabels: m.actorLabels } : {}),
  };
  return {
    meta,
    events,
    notice: {
      kind: 'measured',
      label: '실측 기록',
      text: `실제 실행(run ${meta.runId})의 이벤트 ${events.length}개를 그대로 재생한다. 이벤트는 샘플링된 대표 표본이라 판정은 DB 원장 기준이다.`,
      reference: { run: meta.runId, summary: null },
    },
  };
}

/** NDJSON 문자열 → Recording + 버린 줄. */
export function loadNdjson(
  text: string,
  opts: NdjsonOptions = {},
): { recording: Recording; errors: NdjsonError[] } {
  const { events, errors } = parseNdjson(text);
  return { recording: toRecording(events, opts), errors };
}

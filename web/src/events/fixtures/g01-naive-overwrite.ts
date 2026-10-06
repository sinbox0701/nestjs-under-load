import type { CodeRef, Phase, Recording, RunEvent } from '../types';

/**
 * 가짜 기록 1개: G01 문서 동시 수정 · naive-overwrite · 대표 2명.
 * 시각은 design/mockup.html의 덮어쓰기 1라운드(무대 ms ÷ 40)를 실제 ms로 옮긴 값이다.
 * 실제 측정값이 아니다.
 */

const PATH = 'packs/generic/g01-concurrent-edit/strategies/naive-overwrite.strategy.ts';

// 시안용 예시 코드. 실제 구현은 개발자가 직접 쓴다(DESIGN §5.4).
// 줄 끝 `// @event <phase…>` 마커로 codeRef 줄 번호를 만든다(DESIGN §10.3.2).
const SOURCE = `import { Injectable } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { Document } from '../entities/document.entity';
import type { UpdateDocumentDto } from '../api/update-document.dto';
import { contentionWindow } from '@nul/core/chaos-hooks';

// 버전 칼럼을 보지 않는다 → flush가 조건 없이 덮어쓴다
@Injectable()
export class NaiveOverwriteStrategy {
  constructor(private readonly em: EntityManager) {}

  async execute(id: number, dto: UpdateDocumentDto): Promise<Document> { // @event arrived
    const em = this.em.fork();
    const doc = await em.findOneOrFail(Document, id); // @event db_read
    await contentionWindow('after-read'); // 경합 창: 읽고 쓰기 사이
    em.assign(doc, { body: dto.body }); // 메모리에서 고침
    await em.flush(); // @event db_write committed custom:lost_update
    return doc; // @event responded — 늦게 쓴 쪽이 이긴다, 둘 다 200 OK
  }
}
`;

function lineOf(phase: Phase): CodeRef {
  const lines = SOURCE.split('\n');
  const i = lines.findIndex((l) => {
    const m = /\/\/ @event ([^—]+)/.exec(l);
    return m?.[1]?.trim().split(/\s+/).includes(phase) ?? false;
  });
  if (i < 0) throw new Error(`no @event marker for ${phase}`);
  return `${PATH}:${i + 1}`;
}

const A = '1-1';
const B = '2-1';
const READ_SQL = 'select d.id, d.body, d.version from document d where d.id = $1';
const WRITE_SQL = 'update document set body = $1 where id = $2';

let seq = 0;
function ev(t: number, actor: string, phase: Phase, rest: Partial<RunEvent> = {}): RunEvent {
  seq += 1;
  return { id: `app-1#${seq}`, t, actor, phase, codeRef: lineOf(phase), ...rest };
}

const events: RunEvent[] = [
  ev(0, A, 'arrived', { note: 'PUT /documents/7', reqId: 'r_a1' }),
  ev(8.5, B, 'arrived', { note: 'PUT /documents/7', reqId: 'r_b1' }),
  ev(37.5, A, 'db_read', { sql: READ_SQL, rows: 1, note: 'v7 본문 읽음', attrs: { version: 7 } }),
  ev(46, B, 'db_read', { sql: READ_SQL, rows: 1, note: 'v7 본문 읽음', attrs: { version: 7 } }),
  ev(81, A, 'db_write', { sql: WRITE_SQL, rows: 1, note: '버전 확인 없이 저장' }),
  ev(87.5, A, 'committed', { note: '최종 내용 = A안' }),
  ev(94, A, 'responded', { note: '200 OK' }),
  ev(103.5, B, 'db_write', { sql: WRITE_SQL, rows: 1, note: '버전 확인 없이 저장' }),
  ev(110, B, 'committed', { note: '최종 내용 = B안' }),
  ev(111, A, 'custom:lost_update', {
    note: 'B가 A의 수정을 덮어씀 · A도 200 OK를 받음',
    attrs: { by: B },
  }),
  ev(116.5, B, 'responded', { note: '200 OK' }),
];

export const g01NaiveOverwrite: Recording = {
  meta: {
    runId: 'fixture_g01_naive-overwrite_r1',
    pack: 'generic',
    scenario: 'g01-concurrent-edit',
    scenarioTitle: '문서 동시 수정',
    strategy: { id: 'naive-overwrite', label: '덮어쓰기', kind: 'broken' },
    sceneType: 'shared-document',
    actors: [A, B],
    totalActors: 2,
    isolation: 'READ COMMITTED',
    route: 'PUT /documents/7',
    durationMs: 156.5,
  },
  events,
  code: { path: PATH, lang: 'ts', source: SOURCE, example: true },
};

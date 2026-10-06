/*
 * G01 코드 패널 원문 — design/mockup.html 최종본(7-1절)을 글자 그대로 옮겼다. 임의로 고치지 말 것.
 * 서버 코드는 @mikro-orm/core·postgresql·decorators 7.1.4 + @nestjs/common 11.1.27 + TypeScript 5.9.3 strict로
 * tsc --noEmit 통과 확인(2026-10-07). 클라이언트 줄은 k6 의사 코드. 줄 끝의 ⟦tag⟧는 화면에 나오지 않고,
 * 이벤트가 가리킬 줄(마커 id)로만 쓴다. 시안 단계의 예시 코드다(G01 팩은 아직 없다).
 */
import type { CodeSource } from '../../events/types';
import type { G01StrategyId } from './constants';

export const ENTITY_SRC = `import { ArrayType, BigIntType } from '@mikro-orm/core';
import { Entity, PrimaryKey, Property } from '@mikro-orm/decorators/legacy';

// 5개 처리 방식이 함께 쓰는 문서 엔티티 하나 (같은 테이블에 클래스 여러 개 금지 — checkDuplicateTableNames)
@Entity({ tableName: 'document' })
export class Document {
  @PrimaryKey() id!: number;
  @Property({ type: 'text' }) body!: string;
  @Property({ type: ArrayType }) tokens!: string[]; // 이 본문에 반영된 수정 토큰 — 클라이언트가 본문과 함께 고쳐 보낸다
  @Property({ default: 0 }) editCount!: number; // 불변식: edit_count = 원장 성공 행 수
  @Property({ version: true }) version!: number; // flush가 WHERE version = ? 를 붙인다
  @Property({ type: 'string', nullable: true }) lockedBy?: string | null; // edit-lease 전용
  @Property({ type: 'datetime', nullable: true }) leaseUntil?: Date | null; // edit-lease 전용
  @Property({ type: new BigIntType('number'), default: 0 }) fence!: number; // edit-lease 전용 · acquire마다 +1
}

// 원장: 서버가 성공 처리한 수정마다 한 행 — 저장과 같은 트랜잭션에 쓴다
@Entity({ tableName: 'edit_ledger' })
export class EditLedger {
  @PrimaryKey() id!: number;
  @Property() documentId!: number;
  @Property() requestId!: string;
  @Property() editToken!: string;
  @Property({ type: new BigIntType('string') }) txid!: string;
}

// 문서 이력(append-only): 저장된 본문의 수정 토큰 목록. lost update = 원장엔 있는데 최종 이력에 없는 토큰
@Entity({ tableName: 'document_revision' })
export class DocumentRevision {
  @PrimaryKey() id!: number;
  @Property() documentId!: number;
  @Property({ type: ArrayType }) tokens!: string[];
}
// 7.1.4 소스 확인: 버전 칼럼이 있으면 MikroORM의 모든 UPDATE(nativeUpdate 포함)에 "version" = "version" + 1이 붙는다.
// 즉 nativeUpdate는 버전 조건 없이 쓰는 경로다 — 버전 칼럼은 올라가지만 아무도 비교하지 않는다.

// ── dto.ts ──
export interface EditMeta { requestId: string; editToken: string; tokens: string[]; }
export interface UpdateDocumentDto extends EditMeta { body: string; version: number; }
export interface LeaseSaveDto extends EditMeta { body: string; fence: number; }

// ── record-edit.ts · 모든 저장 경로가 같은 트랜잭션 안에서 부른다 ──
import { EntityManager, raw } from '@mikro-orm/postgresql';
import { DocumentRevision, EditLedger } from './document.entity';
import { EditMeta } from './dto';

// 원장(요청 ID·수정 토큰·txid) + 이력 INSERT. em은 em.transactional 콜백의 em — 롤백되면 함께 사라진다
export async function recordEdit(em: EntityManager, documentId: number, m: EditMeta) {
  await em.insert(EditLedger, { documentId, requestId: m.requestId, editToken: m.editToken, txid: raw('txid_current()') });
  await em.insert(DocumentRevision, { documentId, tokens: m.tokens });
}`;

const OPT_SERVER = `import { ConflictException, Injectable } from '@nestjs/common';
import { EntityManager, LockMode, OptimisticLockError } from '@mikro-orm/postgresql';
import { Document } from '../document.entity';
import { UpdateDocumentDto } from '../dto';
import { recordEdit } from '../record-edit';

@Injectable()
export class OptimisticVersionStrategy {
  constructor(private readonly em: EntityManager) {}

  async open(id: number) {⟦open⟧
    const doc = await this.em.fork().findOneOrFail(Document, id); // 자동 커밋 SELECT⟦read⟧
    return { body: doc.body, tokens: doc.tokens, version: doc.version }; // 화면이 v를 받아 간다 (요청 본문 version으로 돌려준다)⟦openret⟧
  }

  // dto.version은 컨트롤러가 검증한다: 없으면 428, number가 아니면 400 (undefined면 lockVersion 검사가 생략되기 때문)
  async update(id: number, dto: UpdateDocumentDto) {⟦entry⟧
    try {
      return await this.em.fork().transactional(async (em) => { // begin — 원장·이력을 저장과 한 트랜잭션에⟦begin⟧
        // 실패 지점 ①: 읽어 온 엔티티 version과 메모리 비교(락 SQL 아님) → OptimisticLockError → rollback
        const doc = await em.findOneOrFail(Document, id, { lockMode: LockMode.OPTIMISTIC, lockVersion: dto.version });⟦check⟧
        em.assign(doc, { body: dto.body, tokens: dto.tokens, editCount: doc.editCount + 1 });⟦assign⟧
        await em.flush(); // 실패 지점 ②(진짜 동시성 보장): UPDATE … WHERE version = ? 0행 → OptimisticLockError → rollback⟦flush⟧
        await recordEdit(em, id, dto); // 원장 + 이력 INSERT (같은 트랜잭션)⟦ledger⟧
        return { version: doc.version };⟦return⟧
      }); // commit⟦commit⟧
    } catch (e) {
      if (e instanceof OptimisticLockError) { // ①② 모두 409 version_mismatch, currentVersion은 다시 조회⟦catch⟧
        const cur = await this.em.fork().findOneOrFail(Document, id);⟦reread⟧
        throw new ConflictException({ reason: 'version_mismatch', currentVersion: cur.version, current: cur.body });⟦409⟧
      }
      throw e;
    }
  }
}
`;
const CLIENT_HEAD = `const doc0 = http.get(url).json(); // 화면 열기: body + tokens + version⟦cget⟧
sleep(editTime); // 편집 — 사람 시간 (실험실은 압축)⟦cedit⟧
const mine = edit(doc0); // 본문 수정 + tokens에 내 수정 토큰 추가 (+ requestId·editToken)`;
const CODE_SRC: Record<G01StrategyId, { file: string; client: string; cls: string; src: string }> =
  {
    naive: {
      file: 'strategies/naive-overwrite.ts',
      client: 'k6/naive-overwrite.js',
      cls: 'NaiveOverwriteStrategy',
      src: `import { Injectable } from '@nestjs/common';
import { EntityManager, raw } from '@mikro-orm/postgresql';
import { Document } from '../document.entity';
import { UpdateDocumentDto } from '../dto';
import { recordEdit } from '../record-edit';

@Injectable()
export class NaiveOverwriteStrategy {
  constructor(private readonly em: EntityManager) {}

  async open(id: number) {⟦open⟧
    const doc = await this.em.fork().findOneOrFail(Document, id); // 자동 커밋 SELECT⟦read⟧
    return { body: doc.body, tokens: doc.tokens, version: doc.version }; // 화면이 v를 받아 간다⟦openret⟧
  }

  async update(id: number, dto: UpdateDocumentDto) {⟦entry⟧
    // dto.version을 보지 않는다. 원장·이력과 한 트랜잭션이지만 UPDATE의 WHERE에 version이 없다
    return this.em.fork().transactional(async (em) => { // begin⟦begin⟧
      await em.nativeUpdate(Document, { id }, { body: dto.body, tokens: dto.tokens, editCount: raw('edit_count + 1') }); // WHERE id만⟦write⟧
      await recordEdit(em, id, dto); // 원장(요청 ID·수정 토큰·txid) + 이력 INSERT⟦ledger⟧
      return { ok: true }; // 늦게 쓴 쪽이 이긴다 — 둘 다 200 OK⟦return⟧
    }); // commit⟦commit⟧
  }
}

// ── 클라이언트 (k6 · 사람 한 명 = VU 하나) ──
${CLIENT_HEAD}
http.put(url, JSON.stringify({ ...mine, version: doc0.version }));⟦cput⟧`,
    },
    opt: {
      file: 'strategies/optimistic-version.ts',
      client: 'k6/optimistic-version.js',
      cls: 'OptimisticVersionStrategy',
      src: `${OPT_SERVER}
// ── 클라이언트 (k6) · 올바른 재시도 ──
${CLIENT_HEAD}
let res = http.put(url, JSON.stringify({ ...mine, version: doc0.version }));⟦cput⟧
if (res.status === 409) {⟦c409⟧
  const doc = http.get(url).json(); // 최신본 다시 받기⟦cregget⟧
  const merged = reapply(mine, doc); // 내 변경을 최신본에 다시 적용 (병합·사용자 결정)⟦creapply⟧
  res = http.put(url, JSON.stringify({ ...merged, version: doc.version })); // 새 버전으로⟦cretry⟧
}`,
    },
    blind: {
      file: 'strategies/optimistic-version.ts (서버는 버전 감지와 같음)',
      client: 'k6/blind-retry.js',
      cls: 'OptimisticVersionStrategy',
      src: `${OPT_SERVER}
// ── 클라이언트 (k6) · 맹목 재시도 (고장) ──
${CLIENT_HEAD}
let res = http.put(url, JSON.stringify({ ...mine, version: doc0.version }));⟦cput⟧
if (res.status === 409) { // 재시도는 이 if 한 번뿐 — 두 번째 409면 그대로 실패⟦c409⟧
  const { currentVersion } = res.json(); // 버전만 꺼낸다 — 최신 내용은 보지 않음⟦cregget⟧
  res = http.put(url, JSON.stringify({ ...mine, version: currentVersion })); // 같은 body⟦cretry⟧
}`,
    },
    lease: {
      file: 'strategies/edit-lease.ts',
      client: 'k6/edit-lease.js',
      cls: 'EditLeaseStrategy',
      src: `import { ConflictException, HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { EntityManager, raw } from '@mikro-orm/postgresql';
import { Document } from '../document.entity';
import { LeaseSaveDto } from '../dto';
import { recordEdit } from '../record-edit';

@Injectable()
export class EditLeaseStrategy {
  constructor(private readonly em: EntityManager) {}

  async acquire(id: number, user: string) {⟦acquire⟧
    // 조건부 UPDATE 한 번(자동 커밋): 비었거나 · 내 것이거나 · 만료된 잠금만 가져간다. version도 +1
    // 시각은 DB 시계 clock_timestamp() (now()는 트랜잭션 시작 시각이라 쓰지 않는다)
    const em = this.em.fork();
    const n = await em.nativeUpdate(Document,
      { id, $or: [{ lockedBy: null }, { lockedBy: user }, { leaseUntil: { $lte: raw('clock_timestamp()') } }] },⟦acqwhere⟧
      { lockedBy: user, leaseUntil: raw(\`clock_timestamp() + interval '30 seconds'\`), fence: raw('fence + 1') });⟦take⟧
    if (n === 0) { // 남이 쥐고 있음 → 서버는 줄을 세우지 않고 바로 거절⟦held⟧
      // 423은 WebDAV(RFC 4918) 코드를 일부러 빌려 쓴다. 컨트롤러가 Retry-After 헤더를 붙인다
      throw new HttpException({ reason: 'lease_held', retryAfterMs: 1000 }, HttpStatus.LOCKED);⟦423⟧
    }
    const doc = await em.findOneOrFail(Document, id);
    return { fence: doc.fence }; // fencing 토큰: 클라이언트가 save·release에 들고 온다⟦fenceret⟧
  }

  async save(id: number, user: string, dto: LeaseSaveDto) {⟦save⟧
    return this.em.fork().transactional(async (em) => { // begin⟦begin⟧
      // fence가 맞아야 저장된다 → 잠금을 잃은 옛 세션(멈췄다 깨어난 같은 클라이언트 포함)의 늦은 저장을 거른다
      const n = await em.nativeUpdate(Document,
        { id, lockedBy: user, fence: dto.fence, leaseUntil: { $gt: raw('clock_timestamp()') } },
        { body: dto.body, tokens: dto.tokens, editCount: raw('edit_count + 1') });⟦write⟧
      if (n === 0) { // 뺏겼거나 만료 → 409로 통일. 예외라 rollback되어 원장도 남지 않는다⟦lost⟧
        const cur = await em.findOneOrFail(Document, id); // 재조회: 새 보유자의 acquire(+1)까지 반영된 version⟦reread⟧
        const reason = cur.lockedBy !== user || cur.fence !== dto.fence ? 'lease_lost' : 'lease_expired';
        throw new ConflictException({ reason, currentVersion: cur.version, current: cur.body });⟦409⟧
      }
      await recordEdit(em, id, dto); // 원장 + 이력 INSERT (같은 트랜잭션)⟦ledger⟧
    }); // commit⟦commit⟧
  }

  async release(id: number, user: string, fence: number) {⟦relentry⟧
    // 내 잠금·내 fence일 때만 푼다 — 잠금을 잃은 옛 세션이 새 보유자의 잠금을 풀지 못하게
    await this.em.fork().nativeUpdate(Document, { id, lockedBy: user, fence }, { lockedBy: null, leaseUntil: null });⟦release⟧
  }
}

// ── 클라이언트 (k6) ──
let lease; while ((lease = http.post(\`\${url}/lease\`)).status === 423) sleep(retryAfter); // 다시 노크 — 서버 큐 없음 · 순서 보장 없음⟦cpoll⟧
const { fence } = lease.json();
${CLIENT_HEAD}
const res = http.put(url, JSON.stringify({ ...mine, fence })); // 409면 reason = lease_lost | lease_expired⟦cput⟧
http.del(\`\${url}/lease\`, JSON.stringify({ fence })); // 해제도 fence를 들고 간다 (이탈하면 이 줄이 실행되지 않는다)⟦crel⟧`,
    },
  };

/** 실제 MikroORM 7.1.4 + PostgreSQL SQL (드라이버가 만든 문장을 그대로 옮김, 파라미터는 $n으로 마스킹) */
export const SQL = {
  sel: 'select "d0".* from "document" as "d0" where "d0"."id" = $1 limit $2',
  naive:
    'update "document" set "body" = $1, "tokens" = $2, "edit_count" = edit_count + 1, "version" = "version" + 1 where "id" = $3 returning "version"',
  opt: 'update "document" set "body" = $1, "tokens" = $2, "edit_count" = $3, "version" = "version" + 1 where "id" = $4 and "version" = $5 returning "version"',
  led: 'insert into "edit_ledger" ("document_id", "request_id", "edit_token", "txid") values ($1, $2, $3, txid_current()) returning "id"',
  rev: 'insert into "document_revision" ("document_id", "tokens") values ($1, $2) returning "id"',
  acq: 'update "document" set "locked_by" = $1, "lease_until" = clock_timestamp() + interval \'30 seconds\', "fence" = fence + 1, "version" = "version" + 1 where "id" = $2 and ("locked_by" is null or "locked_by" = $3 or "lease_until" <= clock_timestamp()) returning "version"',
  save: 'update "document" set "body" = $1, "tokens" = $2, "edit_count" = edit_count + 1, "version" = "version" + 1 where "id" = $3 and "locked_by" = $4 and "fence" = $5 and "lease_until" > clock_timestamp() returning "version"',
  rel: 'update "document" set "locked_by" = $1, "lease_until" = $2, "version" = "version" + 1 where "id" = $3 and "locked_by" = $4 and "fence" = $5 returning "version"',
};
export const LEDGER_SQL = [SQL.led, '→ 1 row', SQL.rev, '→ 1 row'];
export const LEASE_VER =
  '버전 칼럼이 매핑돼 있어 acquire·save·release가 각각 version +1 → 한 차례에 +3. 그래서 같은 문서를 낙관 락으로 고치는 클라이언트는 내용이 안 바뀌어도 잠금 조작만으로 409를 받을 수 있다.';

export const G01_PACK_DIR = 'packs/generic/g01-shared-document';

export interface ParsedSource {
  /** ⟦tag⟧를 지운 줄들. */
  lines: string[];
  /** 마커 id → 1부터 세는 줄 번호. */
  tags: Record<string, number>;
  /** 클라이언트(k6) 구역이 시작하는 줄 번호(1부터). 없으면 0. */
  clientFrom: number;
}

export function parseTaggedSource(src: string): ParsedSource {
  const tags: Record<string, number> = {};
  const lines = src.split('\n').map((ln, i) =>
    ln.replace(/⟦(\w+)⟧$/, (_m, t: string) => {
      tags[t] = i + 1;
      return '';
    }),
  );
  return { lines, tags, clientFrom: lines.findIndex((l) => l.startsWith('// ── 클라이언트')) + 1 };
}

function toCodeSource(
  path: string,
  label: string,
  p: ParsedSource,
  extra: Partial<CodeSource>,
): CodeSource {
  return {
    path,
    lang: 'ts',
    source: p.lines.join('\n'),
    example: true,
    markers: p.tags,
    ...extra,
    label,
  };
}

const PARSED = Object.fromEntries(
  Object.entries(CODE_SRC).map(([k, v]) => [k, parseTaggedSource(v.src)]),
) as Record<G01StrategyId, ParsedSource>;

/** 처리 방식별 코드 패널 원문(서버 + k6 클라이언트 한 파일). */
const CODE_CACHE = new Map<G01StrategyId, CodeSource>();

/** 처리 방식별 코드(한 번 만들어 캐시 — 같은 id면 같은 객체라 화면 memo가 유지된다). */
export function g01Code(id: G01StrategyId): CodeSource {
  let hit = CODE_CACHE.get(id);
  if (!hit) CODE_CACHE.set(id, (hit = makeG01Code(id)));
  return hit;
}

function makeG01Code(id: G01StrategyId): CodeSource {
  const c = CODE_SRC[id];
  const p = PARSED[id];
  const file = c.file.replace(/\s*\(.*\)$/, '');
  return toCodeSource(`${G01_PACK_DIR}/${file}`, `${G01_PACK_DIR}/${c.file} + ${c.client}`, p, {
    className: c.cls,
    clientPath: `${G01_PACK_DIR}/${c.client}`,
    clientFrom: p.clientFrom,
  });
}

/** 엔티티·DTO·원장 기록 함수(코드 패널의 "엔티티" 탭). */
export const G01_ENTITY: CodeSource = toCodeSource(
  `${G01_PACK_DIR}/document.entity.ts`,
  `${G01_PACK_DIR}/document.entity.ts · dto.ts · record-edit.ts`,
  parseTaggedSource(ENTITY_SRC),
  {},
);

/** 마커 id의 줄 번호(없으면 undefined). */
export function g01Line(id: G01StrategyId, tag: string): number | undefined {
  return PARSED[id].tags[tag];
}

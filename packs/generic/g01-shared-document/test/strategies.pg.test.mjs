// 실제 PostgreSQL 통합 테스트: naive-overwrite · optimistic-version · blind-retry.
// 도커(compose postgres, 127.0.0.1:55432)가 꺼져 있으면 skip 하고 그 사실을 출력한다.
// 다른 DB를 쓰려면 G01_TEST_DATABASE_URL=postgresql://user:pass@host:port/db (CREATE DATABASE 권한 필요).
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { PG_URL, createTestDatabase, makeCtx, makeStrategy, probePostgres, recordingSink, saveCmd } from './helpers.mjs';

const probe = await probePostgres();
const skip = probe.ok ? false : `PostgreSQL 접속 불가(${new URL(PG_URL).host}): ${probe.reason}`;
if (skip) console.log(`[g01 pg] SKIP — ${skip}. 도커를 켜고 다시 실행하면 통합 테스트가 돈다.`);

// 쿼리 로그 한 줄에서 색 코드·꼬리([took …])를 떼고 SQL만 남긴다.
// eslint-disable-next-line no-control-regex
const cleanSql = (line) => line.replace(/\x1b\[[0-9;]*m/g, '').replace(/^\[query\]\s*/, '').replace(/\s*\[took .*$/, '');
const documentUpdates = (sql) => sql.map(cleanSql).filter((s) => s.startsWith('update "g01_document"'));
const whereOf = (s) => s.slice(s.indexOf(' where ')).replace(/ returning .*$/, '');

describe('G01 strategies × 실제 PostgreSQL', { skip }, () => {
  let t;
  before(async () => {
    t = await createTestDatabase();
  });
  after(async () => {
    await t?.drop();
  });

  const save = (id, cmd, opts = {}) => makeStrategy(id).strategy.save(cmd, makeCtx(t.main.em, opts));

  it('AC-1 naive-overwrite: 같은 version으로 두 번 저장 → 둘 다 성공, no_lost_update 위반 1', async () => {
    await t.reset();
    const seen = await t.read(); // 두 사람이 같은 화면(version 1)을 연다
    const first = await save('naive-overwrite', saveCmd(seen));
    const second = await save('naive-overwrite', saveCmd(seen));
    assert.deepEqual(first, { ok: true, version: 2 });
    assert.deepEqual(second, { ok: true, version: 3 }, 'version은 올라가지만 아무도 비교하지 않는다');
    assert.equal((await t.ledger()).length, 2, '원장엔 두 수정 모두 커밋');
    assert.equal(await t.lostUpdates(), 1, '첫 토큰이 최종 문서에 없다');
    const doc = await t.read();
    assert.equal(doc.editCount, 2);
    assert.equal(doc.fields.a.length, 1);
  });

  it('AC-1 optimistic-version: 같은 version으로 두 번 저장 → 두 번째는 version_mismatch(메모리 비교 ①), 원장 1행', async () => {
    await t.reset();
    const seen = await t.read();
    const events = recordingSink();
    const first = await save('optimistic-version', saveCmd(seen));
    const second = await save('optimistic-version', saveCmd(seen), { events });
    assert.deepEqual(first, { ok: true, version: 2 });
    assert.deepEqual(second, { ok: false, reason: 'version_mismatch', currentVersion: 2 });
    assert.equal((await t.ledger()).length, 1, '409는 롤백되어 원장에 남지 않는다');
    assert.equal((await t.revisions()).length, 1);
    assert.equal(await t.lostUpdates(), 0);
    assert.deepEqual(
      events.events.map((e) => e.phase),
      ['arrived', 'rolled_back', 'conflict'],
      'findOneOrFail 안에서 ①로 실패 → db_read 전에 롤백',
    );
    assert.deepEqual(events.events[2].attrs, { reason: 'version_mismatch', at: 'lockVersion', sentVersion: 1, currentVersion: 2 });
    // ①은 UPDATE를 보내지 않는다
    assert.equal(documentUpdates(t.sql).length, 1);
  });

  it('optimistic-version: 동시에 도착해 ①을 둘 다 통과하면 flush 0행(②)에서 갈린다 → currentVersion 재조회', async () => {
    await t.reset();
    const seen = await t.read();
    const sinks = [recordingSink(), recordingSink()];
    const res = await Promise.all(
      sinks.map((events) => save('optimistic-version', saveCmd(seen), { events, delays: [{ point: 'after-read', ms: 50 }] })),
    );
    const ok = res.filter((r) => r.ok);
    const lost = res.filter((r) => !r.ok);
    assert.equal(ok.length, 1, JSON.stringify(res));
    assert.deepEqual(lost[0], { ok: false, reason: 'version_mismatch', currentVersion: 2 });
    const conflict = sinks.flatMap((s) => s.events).find((e) => e.phase === 'conflict');
    assert.equal(conflict.attrs.at, 'flush', '둘 다 메모리 비교를 통과했고 UPDATE … WHERE version = 1 이 0행');
    assert.equal(await t.lostUpdates(), 0);
    assert.equal((await t.ledger()).length, 1);
    assert.equal((await t.read()).editCount, 1);
  });

  it('optimistic-version: 성공 경로 이벤트 순서 — committed는 트랜잭션이 끝난 뒤', async () => {
    await t.reset();
    const events = recordingSink();
    await save('optimistic-version', saveCmd(await t.read()), { events });
    assert.deepEqual(
      events.events.map((e) => e.phase),
      ['arrived', 'db_read', 'db_write', 'committed'],
    );
  });

  it('optimistic-version: version이 문자열 "1"로 새어 들어오면 `!==` 비교라 늘 불일치(그래서 타입이 number만 받는다)', async () => {
    await t.reset();
    const cmd = saveCmd(await t.read());
    const res = await save('optimistic-version', { ...cmd, version: String(cmd.version) });
    assert.deepEqual(res, { ok: false, reason: 'version_mismatch', currentVersion: 1 });
    assert.equal((await t.ledger()).length, 0);
  });

  it('blind-retry: 서버는 optimistic과 같다. 409 뒤 버전만 바꿔 같은 본문을 다시 보내면 통과 → 앞사람 토큰 유실', async () => {
    await t.reset();
    const seen = await t.read();
    const a = await save('blind-retry', saveCmd(seen));
    const bCmd = saveCmd(seen);
    const b1 = await save('blind-retry', bCmd);
    assert.deepEqual(a, { ok: true, version: 2 });
    assert.deepEqual(b1, { ok: false, reason: 'version_mismatch', currentVersion: 2 });
    // k6/blind-retry 클라이언트: currentVersion만 꺼내 같은 body로 재PUT(요청 ID는 새로)
    const b2 = await save('blind-retry', { ...bCmd, requestId: crypto.randomUUID(), version: b1.currentVersion });
    assert.deepEqual(b2, { ok: true, version: 3 });
    assert.equal(await t.lostUpdates(), 1, 'A의 토큰이 원장엔 있고 최종 문서엔 없다');
  });

  it('AC-3: 원장·이력·문서 UPDATE가 같은 트랜잭션(txid 같음, 문서 xmin = txid)', async () => {
    for (const id of ['naive-overwrite', 'optimistic-version']) {
      await t.reset();
      await save(id, saveCmd(await t.read()));
      const [ledger] = await t.ledger();
      const [revision] = await t.revisions();
      assert.equal(ledger.txid, revision.txid, `${id}: 원장 txid = 이력 txid`);
      // xmin은 32비트 xid, pg_current_xact_id()는 epoch를 붙인 64비트(xid8). 하위 32비트가 같아야 한다.
      const [{ xmin }] = await t.q('select xmin::text as xmin from g01_document where id = 1');
      assert.equal(String(BigInt(ledger.txid) % 2n ** 32n), xmin, `${id}: 문서를 마지막으로 바꾼 트랜잭션 = 원장 트랜잭션`);
    }
  });

  it('AC-4: naive의 실제 UPDATE에는 WHERE version 조건이 없고, optimistic에는 있다(쿼리 로그)', async () => {
    await t.reset();
    await save('naive-overwrite', saveCmd(await t.read()));
    const [naive] = documentUpdates(t.sql);
    assert.ok(naive, t.sql.join('\n'));
    assert.match(whereOf(naive), /^ where "id" = 1$/, naive);
    assert.doesNotMatch(whereOf(naive), /version/);
    assert.match(naive, /"version" = "version" \+ 1/, 'version은 SET에서 올라간다(비교는 안 함)');

    await t.reset();
    await save('optimistic-version', saveCmd(await t.read()));
    const [opt] = documentUpdates(t.sql);
    assert.match(whereOf(opt), /^ where "id" = 1 and "version" = 1$/, opt);
  });
});

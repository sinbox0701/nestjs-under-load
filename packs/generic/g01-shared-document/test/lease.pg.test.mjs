// 실제 PostgreSQL 통합 테스트: edit-lease(acquire·save·release, TTL 회수, fencing).
// 접속 대상이 없으면 skip 한다. 일회용 DB를 쓰려면 G01_TEST_DATABASE_URL=postgresql://user:pass@host:port/db (CREATE DATABASE 권한 필요).
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import { PG_URL, createTestDatabase, makeCtx, makeStrategy, probePostgres, recordingSink, saveCmd } from './helpers.mjs';

const probe = await probePostgres();
const skip = probe.ok ? false : `PostgreSQL 접속 불가(${new URL(PG_URL).host}): ${probe.reason}`;
if (skip) console.log(`[g01 lease pg] SKIP — ${skip}. 도커를 켜고 다시 실행하면 통합 테스트가 돈다.`);

// eslint-disable-next-line no-control-regex
const cleanSql = (line) => line.replace(/\x1b\[[0-9;]*m/g, '').replace(/^\[query\]\s*/, '').replace(/\s*\[took .*$/, '');

describe('G01 edit-lease × 실제 PostgreSQL', { skip }, () => {
  let t;
  before(async () => {
    t = await createTestDatabase();
  });
  after(async () => {
    await t?.drop();
  });

  const lease = (params) => {
    const { strategy, params: defaults } = makeStrategy('edit-lease');
    const ctx = (opts = {}) => makeCtx(t.main.em, { params: { ...defaults, ...params }, ...opts });
    return {
      acquire: (holder, opts) => strategy.acquire({ documentId: 1, holder }, ctx(opts)),
      release: (holder, fence, opts) => strategy.release({ documentId: 1, holder, fence }, ctx(opts)),
      save: (cmd, opts) => strategy.save(cmd, ctx(opts)),
    };
  };
  const row = async () => {
    const [r] = await t.q('select locked_by, fence::text as fence, lease_until > clock_timestamp() as live, version from g01_document where id = 1');
    return r;
  };
  /** 잠금을 만료시킨다(lease_until 을 DB 시계 기준 과거로). 실제 TTL 경과는 별도 테스트에서 본다. */
  const expire = () => t.q(`update g01_document set lease_until = clock_timestamp() - interval '1 second' where id = 1`);
  const withLease = (cmd, holder, fence) => ({ ...cmd, lease: { holder, fence } });

  it('AC-1: 보유 중 다른 holder 의 acquire → locked(423 원인), 보유자·Retry-After 를 알려 준다', async () => {
    await t.reset();
    const l = lease();
    const a = await l.acquire('A');
    assert.equal(a.ok, true);
    assert.equal(a.fence, '1', 'fence 는 bigint 를 string 으로');
    assert.ok(a.leaseUntil instanceof Date);
    const events = recordingSink();
    const b = await l.acquire('B', { events });
    assert.deepEqual(b, { ok: false, reason: 'locked', lockedBy: 'A', retryAfterMs: 1000 });
    assert.deepEqual(events.events.map((e) => e.phase), ['arrived', 'db_write', 'custom:lease_rejected']);
    assert.equal(events.events[1].rows, 0);
    const r = await row();
    assert.equal(r.locked_by, 'A');
    assert.equal(r.fence, '1', '거절된 acquire 는 아무것도 바꾸지 않는다');
  });

  it('Retry-After 는 남은 lease(DB 시계)보다 길지 않다', async () => {
    await t.reset();
    const l = lease({ ttlMs: 300, retryAfterMs: 5000 });
    await l.acquire('A');
    const b = await l.acquire('B');
    assert.equal(b.ok, false);
    assert.ok(b.retryAfterMs > 0 && b.retryAfterMs <= 300, String(b.retryAfterMs));
  });

  it('동시에 acquire 8건 → 정확히 1건만 잡는다(조건부 UPDATE 한 문장, 서버 큐 없음)', async () => {
    await t.reset();
    const l = lease();
    const res = await Promise.all(Array.from({ length: 8 }, (_, i) => l.acquire(`h${i}`)));
    const ok = res.filter((r) => r.ok);
    assert.equal(ok.length, 1, JSON.stringify(res));
    const winner = (await row()).locked_by;
    for (const r of res.filter((x) => !x.ok)) assert.equal(r.lockedBy, winner);
  });

  it('같은 holder 가 다시 acquire 하면 갱신되고 fence 가 오른다(옛 세션의 fence 는 무효)', async () => {
    await t.reset();
    const l = lease();
    const first = await l.acquire('A');
    const again = await l.acquire('A');
    assert.equal(again.ok, true);
    assert.equal(again.fence, '2');
    const stale = await l.save(withLease(saveCmd(await t.read()), 'A', first.fence));
    assert.deepEqual(stale, { ok: false, reason: 'lease_lost' }, '같은 사람이라도 옛 fence 의 저장은 거른다');
  });

  it('보유자의 save: 1행 → 원장·이력 커밋, 이벤트 순서 committed 는 트랜잭션 뒤', async () => {
    await t.reset();
    const l = lease();
    const { fence } = await l.acquire('A');
    const seen = await t.read();
    const events = recordingSink();
    const res = await l.save(withLease(saveCmd(seen), 'A', fence), { events });
    assert.deepEqual(res, { ok: true, version: seen.version + 1 });
    assert.deepEqual(events.events.map((e) => e.phase), ['arrived', 'db_write', 'committed']);
    assert.equal((await t.ledger()).length, 1);
    assert.equal(await t.lostUpdates(), 0);
    assert.equal((await t.read()).editCount, 1);
  });

  it('AC-2: 만료 후 새 holder 가 회수하면 fence 가 오르고, 옛 holder 의 늦은 save 는 lease_lost(원장 0)', async () => {
    await t.reset();
    const l = lease();
    const a = await l.acquire('A'); // A 가 잡고 멈춘다(GC·네트워크 단절)
    const seenByA = await t.read();
    await expire();
    const b = await l.acquire('B'); // TTL 만료 → B 가 회수
    assert.equal(b.ok, true);
    assert.equal(BigInt(b.fence), BigInt(a.fence) + 1n);
    const events = recordingSink();
    const late = await l.save(withLease(saveCmd(seenByA), 'A', a.fence), { events });
    assert.deepEqual(late, { ok: false, reason: 'lease_lost' });
    assert.deepEqual(events.events.map((e) => e.phase), ['arrived', 'db_write', 'rolled_back', 'conflict']);
    assert.deepEqual(events.events[3].attrs, {
      reason: 'lease_lost',
      lockedBy: 'B',
      fence: b.fence,
      sentFence: a.fence,
      currentVersion: (await t.read()).version,
    });
    assert.equal((await t.ledger()).length, 0, '거절은 롤백되어 원장에 남지 않는다');
    // B 의 저장은 통과한다
    const ok = await l.save(withLease(saveCmd(await t.read()), 'B', b.fence));
    assert.equal(ok.ok, true);
    assert.equal(await t.lostUpdates(), 0);
  });

  it('만료됐지만 아무도 회수하지 않았으면 lease_expired(같은 보유자·같은 fence)', async () => {
    await t.reset();
    const l = lease();
    const a = await l.acquire('A');
    const seen = await t.read();
    await expire();
    const events = recordingSink();
    const res = await l.save(withLease(saveCmd(seen), 'A', a.fence), { events });
    assert.deepEqual(res, { ok: false, reason: 'lease_expired' });
    assert.deepEqual(events.events.map((e) => e.phase), ['arrived', 'db_write', 'rolled_back', 'lease_expired', 'conflict']);
    assert.equal((await t.ledger()).length, 0);
  });

  it('fence 는 숫자로 비교한다: "01" 로 와도 UPDATE 와 재조회 분류가 같은 판단(lease_expired)', async () => {
    await t.reset();
    const l = lease();
    const a = await l.acquire('A');
    assert.equal(a.fence, '1');
    const seen = await t.read();
    assert.equal((await l.save(withLease(saveCmd(seen), 'A', '01'))).ok, true, 'WHERE fence = \'01\' 은 bigint 비교라 통과');
    await expire();
    assert.deepEqual(await l.save(withLease(saveCmd(await t.read()), 'A', '01')), { ok: false, reason: 'lease_expired' });
  });

  it('실제 TTL 경과(DB 시계)로 잠금이 풀린다 — release 없이 떠난 보유자', async () => {
    await t.reset();
    const l = lease({ ttlMs: 80 });
    assert.equal((await l.acquire('A')).ok, true);
    assert.equal((await l.acquire('B')).ok, false);
    await sleep(150); // 테스트 안에서 TTL 이 지나길 기다린다(폴링 아님)
    const b = await l.acquire('B');
    assert.equal(b.ok, true);
    assert.equal(b.fence, '2');
  });

  it('release: 내 잠금·내 fence 일 때만 푼다. 잠금을 잃은 옛 세션은 새 보유자를 풀지 못한다', async () => {
    await t.reset();
    const l = lease();
    const a = await l.acquire('A');
    await expire();
    const b = await l.acquire('B');
    await l.release('A', a.fence);
    assert.equal((await row()).locked_by, 'B', '옛 fence 의 release 는 0행');
    const events = recordingSink();
    await l.release('B', b.fence, { events });
    assert.deepEqual(events.events.map((e) => e.phase), ['lock_released']);
    const r = await row();
    assert.equal(r.locked_by, null);
    assert.equal((await l.acquire('C')).ok, true, '풀린 뒤엔 누구나 잡는다');
  });

  it('lease 없이 온 save 는 DB 에 가지 않고 lease_lost', async () => {
    await t.reset();
    const cmd = saveCmd(await t.read());
    t.sql.length = 0;
    const res = await lease().save(cmd);
    assert.deepEqual(res, { ok: false, reason: 'lease_lost' });
    assert.equal(t.sql.length, 0);
  });

  it('acquire·save 의 실제 SQL: 만료·유효 판단이 clock_timestamp() 이고 fence + 1 · fence 조건이 있다(쿼리 로그)', async () => {
    await t.reset();
    const l = lease();
    const { fence } = await l.acquire('A');
    await l.save(withLease(saveCmd(await t.read()), 'A', fence));
    const updates = t.sql.map(cleanSql).filter((s) => s.startsWith('update "g01_document"'));
    const [acq, save] = updates;
    assert.match(acq, /"lease_until" = clock_timestamp\(\) \+ 30000 \* interval '1 millisecond'/, acq);
    assert.match(acq, /"fence" = fence \+ 1/, acq);
    assert.match(acq, /"lease_until" <= clock_timestamp\(\)/, acq);
    assert.match(save, /where "id" = 1 and "locked_by" = 'A' and "fence" = '1' and "lease_until" > clock_timestamp\(\)/, save);
    for (const s of updates) assert.doesNotMatch(s, /\bnow\(\)/);
  });

  it('왜 clock_timestamp() 인가: 트랜잭션 안에서 now() 는 시작 시각에 멈춰 있다', async () => {
    const [r] = await t.main.em.fork().transactional(async (em) => {
      await em.execute('select pg_sleep(0.05)');
      return em.execute(`select (clock_timestamp() - now()) >= interval '40 milliseconds' as drift, now() = transaction_timestamp() as same`);
    });
    assert.equal(r.drift, true, 'now() 로 lease 를 계산하면 트랜잭션이 열린 시간만큼 과거 시각이 된다');
    assert.equal(r.same, true);
  });
});

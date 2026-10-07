import { DefaultLogger, type EventSubscriber, type Logger, type LoggerOptions } from '@mikro-orm/core';
import { INSTRUMENTATION_LEVELS, type InstrumentationLevel } from '@under-load/contracts';

import { getLabMetrics, type PoolLike } from './lab-metrics';

const secondsSince = (startNs: bigint): number => Number(process.hrtime.bigint() - startNs) / 1e9;

/** pg-pool 의 acquire 타임아웃 메시지('timeout exceeded when trying to connect' 등). */
const ACQUIRE_TIMEOUT = /timeout exceeded when trying to connect|connection timeout/i;

type PoolConnect = (...args: any[]) => any;
type HookedPool = PoolLike & { connect: PoolConnect };

/**
 * MikroORM `driverOptions.onPoolCreated`(PostgreSqlConnection.createKyselyDialect 가 pg Pool 을 만든 직후 호출)에
 * 꽂는 훅. off 면 빈 객체. 사용: `driverOptions: poolHooks(level)`.
 * 풀 게이지(total/idle/waiting)는 스크레이프 때 풀에서 읽고, `pool.connect` 를 감싸 acquire 시간·타임아웃을 센다.
 */
export function poolHooks(level: InstrumentationLevel): { onPoolCreated?: (pool: HookedPool) => void } {
  if (INSTRUMENTATION_LEVELS[level].metricsUpTo === 'off') return {};
  const m = getLabMetrics(level);
  return {
    onPoolCreated(pool) {
      m.attachPool(pool);
      const connect = pool.connect.bind(pool) as PoolConnect;
      const onError = (err: unknown): void => {
        if (err instanceof Error && ACQUIRE_TIMEOUT.test(err.message)) m.poolAcquireTimeouts?.inc();
      };
      pool.connect = (cb?: (...args: any[]) => void) => {
        const start = process.hrtime.bigint();
        if (typeof cb === 'function') {
          return connect((err: unknown, ...rest: unknown[]) => {
            m.poolAcquireDuration?.observe(secondsSince(start));
            if (err) onError(err);
            cb(err, ...rest);
          });
        }
        return (connect() as Promise<unknown>).then(
          (client) => {
            m.poolAcquireDuration?.observe(secondsSince(start));
            return client;
          },
          (err: unknown) => {
            m.poolAcquireDuration?.observe(secondsSince(start));
            onError(err);
            throw err;
          },
        );
      };
    },
  };
}

type QueryType = 'select' | 'insert' | 'update' | 'delete' | 'other';

function queryType(sql: string): QueryType {
  const head = /^\s*(\w+)/.exec(sql)?.[1]?.toLowerCase();
  return head === 'select' || head === 'insert' || head === 'update' || head === 'delete' ? head : 'other';
}

/** full: 쿼리 시간을 지표로만 보낸다. 로그 출력·디버그 모드는 바꾸지 않는다. */
class MetricsLogger extends DefaultLogger {
  constructor(
    options: LoggerOptions,
    private readonly onQuery: (type: QueryType, seconds: number) => void,
  ) {
    super(options);
  }

  override logQuery(context: Parameters<DefaultLogger['logQuery']>[0]): void {
    // slow-query 로거도 같은 팩토리를 쓰므로 이중 집계하지 않는다.
    if (context.took != null && (context.namespace ?? 'query') === 'query') {
      this.onQuery(queryType(context.query), context.took / 1000);
    }
    super.logQuery(context);
  }
}

/**
 * MikroORM 설정에 펼쳐 넣는 훅: `{ subscribers, loggerFactory? }`.
 * metrics+ 는 flush·트랜잭션 subscriber, full 은 추가로 loggerFactory(쿼리 시간)와 identity map 크기.
 * off 는 아무것도 등록하지 않는다.
 */
export function ormHooks(level: InstrumentationLevel): {
  subscribers: EventSubscriber[];
  loggerFactory?: (options: LoggerOptions) => Logger;
} {
  if (INSTRUMENTATION_LEVELS[level].metricsUpTo === 'off') return { subscribers: [] };
  const m = getLabMetrics(level);
  const flushStart = new WeakMap<object, bigint>();
  const txStart = new WeakMap<object, bigint>();

  const finishTx = (result: 'commit' | 'rollback', em: object, savepoint: string | undefined): void => {
    if (savepoint) return; // 중첩(savepoint)은 세지 않는다.
    m.ormTransactions?.inc({ result });
    const start = txStart.get(em);
    if (start !== undefined) {
      txStart.delete(em);
      m.ormTransactionDuration?.observe({ result }, secondsSince(start));
    }
  };

  const subscriber: EventSubscriber = {
    beforeFlush({ uow }) {
      flushStart.set(uow, process.hrtime.bigint());
    },
    onFlush({ uow }) {
      m.ormFlushChangesets?.observe(uow.getChangeSets().length);
    },
    afterFlush({ uow }) {
      const start = flushStart.get(uow);
      if (start !== undefined) {
        flushStart.delete(uow);
        m.ormFlushDuration?.observe(secondsSince(start));
      }
      m.ormIdentityMapSize?.observe(uow.getIdentityMap().values().length);
    },
    // 최상위 트랜잭션은 before 에서 transaction 이 없다(savepoint 는 부모 ctx 가 온다).
    beforeTransactionStart({ em, transaction }) {
      if (!transaction) txStart.set(em, process.hrtime.bigint());
    },
    afterTransactionCommit({ em, transaction }) {
      finishTx('commit', em, transaction?.savepointName);
    },
    afterTransactionRollback({ em, transaction }) {
      finishTx('rollback', em, transaction?.savepointName);
    },
  };

  const hooks: ReturnType<typeof ormHooks> = { subscribers: [subscriber] };
  if (INSTRUMENTATION_LEVELS[level].ormQueryLogger) {
    hooks.loggerFactory = (options) =>
      new MetricsLogger(options, (type, seconds) => m.ormQueryDuration?.observe({ type }, seconds));
  }
  return hooks;
}

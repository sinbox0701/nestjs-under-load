import { poolView, type PoolSnapshot } from './state';

/** 인스턴스별 커넥션 풀 게이지. 숫자 + 막대(활성·유휴 비율), 대기가 있으면 노랑 배지. */
export function PoolGauges({ pools }: { pools: Record<string, PoolSnapshot> }) {
  const names = Object.keys(pools).sort();
  if (names.length === 0) return <p className="live-empty">풀 상태 대기 중</p>;
  return (
    <ul className="pools" aria-label="인스턴스별 커넥션 풀">
      {names.map((name) => {
        const v = poolView(pools[name]!);
        const pct = v.total > 0 ? (v.active / v.total) * 100 : 0;
        return (
          <li key={name} className="pool" data-instance={name}>
            <span className="pool__name">{name}</span>
            <span
              className="pool__bar"
              role="meter"
              aria-label={`${name} 풀 사용`}
              aria-valuemin={0}
              aria-valuemax={v.total}
              aria-valuenow={v.active}
            >
              <i style={{ width: `${pct}%` }} />
            </span>
            <span className="pool__n">
              <span data-k="active">활성 {v.active}</span> / 전체 {v.total}
              {' · '}
              <span data-k="idle">유휴 {v.idle}</span>
            </span>
            <span data-k="waiting" className={`badge ${v.waiting > 0 ? 't-wait' : 't-neutral'}`}>
              대기 {v.waiting}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

import type { ProbeData } from '../../api';
import { blockTree } from './state';

/** 락 차단 트리(DESIGN §9.4): 누가 누구를 막는지. 들여쓰기 한 단 = 한 번 더 막힌 세션. */
export function ProbeTree({ probe }: { probe: ProbeData | null }) {
  if (!probe)
    return <p className="live-empty">PG 프로브 대기 중 (계측 수준이 꺼져 있으면 오지 않습니다)</p>;
  const byPid = new Map(probe.sessions.map((s) => [s.pid, s]));
  const nodes = blockTree(probe);
  if (nodes.length === 0)
    return <p className="live-empty">락 차단 없음 · 대기 {probe.lockWaiters}</p>;
  return (
    <ul className="ptree" role="tree" aria-label="락 차단 트리">
      {nodes.map((n, i) => {
        const s = byPid.get(n.pid);
        const waiting = s?.waitEventType === 'Lock';
        return (
          <li
            key={`${n.pid}:${i}`}
            role="treeitem"
            aria-level={n.depth + 1}
            aria-selected={false}
            data-depth={n.depth}
            style={{ paddingLeft: `${n.depth * 16}px` }}
          >
            <span className="ptree__pid">
              {n.depth > 0 ? '└ ' : ''}pid {n.pid}
            </span>
            <span className={`badge ${n.root ? 't-bad' : waiting ? 't-wait' : 't-info'}`}>
              {n.root ? '막는 쪽' : waiting ? '막힘 · Lock' : (s?.state ?? '?')}
            </span>
            {s?.xactAgeMs != null && <span className="ptree__age">트랜잭션 {s.xactAgeMs}ms</span>}
            {s?.waitEvent && <span className="ptree__age">{s.waitEvent}</span>}
            {s?.query && <code className="ptree__q">{s.query}</code>}
          </li>
        );
      })}
    </ul>
  );
}

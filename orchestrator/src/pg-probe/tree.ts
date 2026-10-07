// pg_blocking_pids 결과(`blocking`)에서 차단 트리를 만든다. 루트 = 남을 막지만 자신은 막히지 않은 pid.

export type BlockingEdge = { pid: number; blockedBy: number[] };

export type BlockingTree = {
  /** 루트 pid → 그 루트가 (직·간접으로) 막고 있는 pid 트리 */
  roots: BlockingNode[];
  /** 가장 긴 차단 사슬의 간선 수(1→2→3 이면 2). 차단이 없으면 0 */
  depth: number;
};

export type BlockingNode = { pid: number; waiters: BlockingNode[] };

export function buildBlockingTree(blocking: readonly BlockingEdge[]): BlockingTree {
  const waitersOf = new Map<number, number[]>();
  const blockedPids = new Set<number>();
  for (const { pid, blockedBy } of blocking) {
    if (blockedBy.length === 0) continue;
    blockedPids.add(pid);
    for (const b of blockedBy) {
      const list = waitersOf.get(b) ?? [];
      list.push(pid);
      waitersOf.set(b, list);
    }
  }

  let depth = 0;
  // path 로 교착(순환)·다중 차단에서의 무한 재귀를 막는다.
  const grow = (pid: number, level: number, path: Set<number>): BlockingNode => {
    depth = Math.max(depth, level);
    const waiters: BlockingNode[] = [];
    for (const w of waitersOf.get(pid) ?? []) {
      if (path.has(w)) continue;
      waiters.push(grow(w, level + 1, new Set(path).add(w)));
    }
    return { pid, waiters };
  };

  const roots: BlockingNode[] = [];
  for (const pid of waitersOf.keys()) {
    if (blockedPids.has(pid)) continue;
    roots.push(grow(pid, 0, new Set([pid])));
  }
  return { roots, depth };
}

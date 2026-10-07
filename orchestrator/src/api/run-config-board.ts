// RunConfigBoard 구현: T-110(RunEngine)이 게시하고 `GET /internal/run-config` 가 서빙한다.
import type { RunConfigV1 } from '@under-load/contracts';

import type { RunConfigBoard } from '../ports.js';

export function createRunConfigBoard(): RunConfigBoard {
  let config: RunConfigV1 | null = null;
  let fetched = new Set<string>();
  return {
    publish(next) {
      config = next;
      fetched = new Set();
    },
    get(instance) {
      if (!config) return null;
      fetched.add(instance);
      return config;
    },
    clear() {
      config = null;
      fetched = new Set();
    },
    current: () => config,
    fetchedBy: () => [...fetched],
  };
}

// C3 null 허용 표 기반 완전성 검사. 표(NULLABLE_WHEN)는 계약에서 가져오고 복제하지 않는다.
import { NULLABLE_WHEN } from '@under-load/contracts';
import type { RunMetadata } from '@under-load/contracts';

/** 값 칸이 자유 형식(키가 고정되지 않은) 인 경로. 안쪽은 검사하지 않는다. */
const OPAQUE_PATHS = new Set(['strategy.params', 'data.seedOptions', 'data.rows', 'data.scenarioParams', 'validity.checks.k6Cpu']);

export type CompletenessReport = {
  /** 미채움(null 인데 C3 표가 허용하지 않는) 경로. 문서 순서 */
  missing: string[];
  /** 표가 null 을 허용해서 통과시킨 경로 */
  allowedNull: string[];
  complete: boolean;
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 메타데이터를 훑어 null 잎을 모으고, 허용 표와 대조해 미채움을 보고한다. */
export function completeness(md: RunMetadata): CompletenessReport {
  const missing: string[] = [];
  const allowedNull: string[] = [];
  const allowed = new Map(NULLABLE_WHEN.filter((r) => r.allowed === null && r.applies(md)).map((r) => [r.path, r]));

  const walk = (value: unknown, path: string): void => {
    if (value === null) {
      (allowed.has(path) ? allowedNull : missing).push(path);
      return;
    }
    if (!isPlainObject(value) || OPAQUE_PATHS.has(path)) return;
    for (const [key, child] of Object.entries(value)) walk(child, path === '' ? key : `${path}.${key}`);
  };
  walk(md, '');

  return { missing, allowedNull, complete: missing.length === 0 };
}

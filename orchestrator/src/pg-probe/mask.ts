// 프로브 query 정리: 리터럴 마스킹 후 200자로 자른다(마스킹 먼저 → 잘린 리터럴이 새지 않는다).

export const QUERY_MAX = 200;

/** 문자열 리터럴 → `$s`, 숫자 리터럴 → `$n`. 식별자 안의 숫자(t1)는 건드리지 않는다. */
export function maskQuery(query: string | null): string | null {
  if (query === null) return null;
  const masked = query
    .replace(/'(?:[^']|'')*'/g, '$s')
    .replace(/(?<![\w$])\d+(?:\.\d+)?(?![\w$])/g, '$n');
  return masked.slice(0, QUERY_MAX);
}

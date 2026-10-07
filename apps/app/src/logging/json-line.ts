/**
 * Nest 를 불러오기 전(main.ts 의 RunConfig 조회 단계)에도 쓰는 한 줄 JSON 로그.
 * 필드는 LabJsonLogger(Nest ConsoleLogger json 모드)와 같다: level·pid·timestamp·message·context(·trace_id).
 */
export function writeJsonLine(level: 'log' | 'warn' | 'error', message: string, context: string): void {
  const line = JSON.stringify({ level, pid: process.pid, timestamp: Date.now(), message, context });
  process[level === 'log' ? 'stdout' : 'stderr'].write(`${line}\n`);
}

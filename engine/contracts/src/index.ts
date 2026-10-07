/**
 * @under-load/contracts — 1단계 인터페이스 계약 C1–C7·C9 의 정본(zod 스키마·상수).
 * 문서: docs/CONTRACTS-phase1.md. fixture: engine/contracts/fixtures/*.
 * C8(오케스트레이터 내부 포트)은 orchestrator/src/ports.ts, C10(G01 HTTP)은 팩이 갖는다.
 */
export * from './run-config.js';
export * from './metadata.js';
export * from './events.js';
export * from './api.js';

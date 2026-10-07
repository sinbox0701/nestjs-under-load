/**
 * mock 응답용 contracts fixture. 정본 engine/contracts/fixtures 를 그대로 읽는다(복제하지 않는다).
 * client.ts 가 mock 일 때만 동적으로 불러온다.
 * 경로 상대 참조는 vite.config.ts 의 server.fs.allow(레포 루트)가 이미 허용한다.
 */
import batchSummary from '../../../engine/contracts/fixtures/batch-summary.json';
import compareResult from '../../../engine/contracts/fixtures/compare-result.json';
import health from '../../../engine/contracts/fixtures/health.json';
import metadataV1 from '../../../engine/contracts/fixtures/metadata.v1.json';
import runRow from '../../../engine/contracts/fixtures/run-row.json';
import scenarios from '../../../engine/contracts/fixtures/scenarios.json';
import session from '../../../engine/contracts/fixtures/session.json';
import wsMessages from '../../../engine/contracts/fixtures/ws-messages.json';
import type {
  BatchSummary,
  CompareResult,
  Health,
  RunMetadata,
  RunRow,
  ScenarioInfo,
  Session,
  WsMessage,
} from './types';

export const fixtures = {
  health: health as unknown as Health,
  scenarios: scenarios as unknown as ScenarioInfo[],
  session: session as unknown as Session,
  runRow: runRow as unknown as RunRow,
  metadata: metadataV1 as unknown as RunMetadata,
  batch: batchSummary as unknown as BatchSummary,
  compare: compareResult as unknown as CompareResult,
  wsMessages: wsMessages as unknown as WsMessage[],
};

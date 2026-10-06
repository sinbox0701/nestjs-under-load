import { defaultLabels, type StageInput } from './events';
import type { StageScene } from './model';
import { queueCounterSceneAt } from './queueCounter';
import { sharedDocumentSceneAt } from './sharedDocument';

export type StageKind = 'shared-document' | 'queue-at-counter';

/**
 * 장면 타입(DESIGN §10.3, `meta.sceneType`) → 무대 장면.
 * 모르는 장면 타입은 shared-document 틀에서 도착·퇴장과 말풍선 글자로만 보인다(매핑 없는 phase 규칙).
 */
export function stageKindOf(sceneType: string): StageKind {
  return sceneType === 'queue-at-counter' ? 'queue-at-counter' : 'shared-document';
}

/** 화면 상태 = f(P). 같은 입력·같은 P면 언제나 같은 장면이다(되감기 안전). */
export function stageSceneAt(
  input: StageInput | null | undefined,
  P: number,
  labels?: readonly string[],
): StageScene {
  if (!input) return { kind: 'empty' };
  const L = labels ?? defaultLabels(input.meta.actors.length);
  return stageKindOf(input.meta.sceneType) === 'queue-at-counter'
    ? queueCounterSceneAt(input, P, L)
    : sharedDocumentSceneAt(input, P, L);
}

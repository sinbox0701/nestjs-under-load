import { describe, expect, it } from 'vitest';
import { prepare } from '../playback';
import { SCENARIOS, buildRecording, codeFor, parseRich, richToPlain } from './index';

describe('시나리오 레지스트리', () => {
  it('모든 (시나리오, 처리 방식)의 기본 옵션 기록이 만들어지고 재생 준비가 된다', () => {
    for (const s of SCENARIOS) {
      for (const st of s.strategies.filter((x) => !x.disabled)) {
        const defaults = Object.fromEntries(s.options.map((o) => [o.key, o.default]));
        const r = buildRecording({ scenario: s.id, strategy: st.id, ...defaults } as never);
        expect(r.meta.scenario).toBe(s.id);
        expect(r.meta.strategy.id).toBe(st.id);
        expect(r.meta.sceneType).toBe(s.sceneType);
        expect(r.notice?.label).toBe('시뮬레이션 기록(실측 아님)');
        expect(prepare(r).total).toBe(r.meta.durationMs);
        expect(codeFor(s.id, st.id).path).toBe(r.code!.path);
      }
    }
  });

  it('rich 서식: **굵게**와 {{용어|말}}', () => {
    const segs = parseRich('앞 **강조** 뒤 {{epq|WHERE 재평가}} 끝');
    expect(segs.map((x) => x.kind)).toEqual(['text', 'bold', 'text', 'term', 'text']);
    expect(segs[3]).toMatchObject({ term: 'epq', text: 'WHERE 재평가' });
    expect((segs[3] as { tip: string }).tip).toMatch(/EvalPlanQual/);
    expect(richToPlain('**a** {{rc|b}}')).toBe('a b');
  });
});

import { describe, expect, it } from 'vitest';

import { calculateScore, defaultPolicy } from './service.js';
describe('explainable operational scoring', () => {
  it('is deterministic, bounded, additive, and preserves unknown evidence', () => {
    const input={severity:'critical',urgency:'high',criticality:undefined,impact:'medium',confidence:'high'} as const;
    const first=calculateScore(input,defaultPolicy); const second=calculateScore(input,defaultPolicy);
    expect(first).toEqual(second); expect(first.score).toBeGreaterThanOrEqual(0); expect(first.score).toBeLessThanOrEqual(100);
    expect(first.factors.reduce((sum,f)=>sum+f.contribution,0)).toBeCloseTo(first.score,0); expect(first.factors.find(f=>f.key==='criticality')?.unknown).toBe(true);
  });
  it('bounds every factor contribution by its immutable configured weight', () => {
    const score=calculateScore({severity:'critical',urgency:'critical',criticality:'tier1',impact:'critical',confidence:'critical'},defaultPolicy);
    expect(score.score).toBe(100); for(const factor of score.factors) expect(factor.contribution).toBeLessThanOrEqual(factor.weight);
  });
});

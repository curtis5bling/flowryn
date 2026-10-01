import { describe, expect, it } from 'vitest';

import { factorWeightsSchema, intelligenceQueueQuerySchema, policyCreateSchema, recommendationFeedbackSchema } from './intelligence.js';
describe('operational intelligence contracts', () => {
  it('requires bounded weights totalling one hundred and ordered thresholds', () => {
    expect(factorWeightsSchema.safeParse({ severity:30,urgency:25,criticality:20,impact:15,confidence:10 }).success).toBe(true);
    expect(factorWeightsSchema.safeParse({ severity:30,urgency:25,criticality:20,impact:15,confidence:9 }).success).toBe(false);
    const base={name:'Policy',weights:{severity:30,urgency:25,criticality:20,impact:15,confidence:10},thresholds:{now:70,soon:40},includedSignalTypes:['task.overdue'],criticality:{tier1:1,tier2:.75,tier3:.5,tier4:.25},ageBandsHours:[1,24],notificationThreshold:80,digest:'hourly',quietHours:null,maximumActiveRecommendations:100,expectedActiveVersion:1};
    expect(policyCreateSchema.safeParse(base).success).toBe(true); expect(policyCreateSchema.safeParse({...base,thresholds:{now:40,soon:70}}).success).toBe(false);
  });
  it('bounds queues and requires idempotent feedback operations', () => {
    expect(intelligenceQueueQuerySchema.safeParse({limit:101}).success).toBe(false);
    expect(recommendationFeedbackSchema.safeParse({operationId:'85c06636-285d-4f15-9933-906517bd1d7c'}).success).toBe(true);
    expect(recommendationFeedbackSchema.safeParse({operationId:'retry'}).success).toBe(false);
  });
});

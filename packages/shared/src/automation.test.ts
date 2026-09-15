import { describe, expect, it } from 'vitest';

import { automationRuleSchema, type AutomationCondition } from './automation.js';

const rule = {
  name: 'Rule',
  description: '',
  enabled: false,
  triggerType: 'automation.manual',
  triggerVersion: 1,
  conditions: { mode: 'all', children: [] },
  actions: [
    { id: '55555555-5555-4555-8555-555555555555', type: 'incident.timeline', message: 'Update' },
  ],
};
describe('bounded automation contracts', () => {
  it('accepts a versioned structured rule', () =>
    expect(automationRuleSchema.safeParse(rule).success).toBe(true));
  it('rejects code, queries, unknown fields, versions, duplicated IDs and oversized actions', () => {
    for (const bad of [
      { ...rule, javascript: 'eval()' },
      { ...rule, triggerVersion: 2 },
      { ...rule, name: 'x'.repeat(201) },
      { ...rule, actions: Array(17).fill(rule.actions[0]) },
      { ...rule, actions: [...rule.actions, ...rule.actions] },
      { ...rule, conditions: { field: '$where', operator: 'regex', values: ['.*'] } },
    ])
      expect(automationRuleSchema.safeParse(bad).success).toBe(false);
  });
  it('rejects deep or wide condition trees and large arrays', () => {
    let conditions: AutomationCondition = { field: 'actorId', operator: 'eq', values: ['actor'] };
    for (let n = 0; n < 5; n++) conditions = { mode: 'all', children: [conditions] };
    expect(automationRuleSchema.safeParse({ ...rule, conditions }).success).toBe(false);
    expect(
      automationRuleSchema.safeParse({
        ...rule,
        conditions: {
          mode: 'all',
          children: Array(32).fill({ field: 'actorId', operator: 'eq', values: ['actor'] }),
        },
      }).success,
    ).toBe(false);
    expect(
      automationRuleSchema.safeParse({
        ...rule,
        conditions: { field: 'actorId', operator: 'in', values: Array(33).fill('actor') },
      }).success,
    ).toBe(false);
  });
});

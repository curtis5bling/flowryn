import { describe, expect, it } from 'vitest';

import { automationRuleSchema, automationTriggerSchema, integrationInputSchema, type AutomationCondition } from './automation.js';

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
  it('allows an integration to subscribe to every supported outbound event', () => {
    expect(integrationInputSchema.safeParse({ name: 'All events', type: 'genericWebhook', status: 'active', inboundEvents: [], outboundEvents: automationTriggerSchema.options }).success).toBe(true);
  });
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
  it('validates explicit automation SLI actions and reliability triggers', () => {
    const action = { id: '55555555-5555-4555-8555-555555555556', type: 'sli.ingest', serviceId: '507f1f77bcf86cd799439011', sloId: '507f1f77bcf86cd799439012', good: 9, total: 10, metadata: {} };
    expect(automationRuleSchema.safeParse({ ...rule, triggerType: 'monitor.failed', actions: [action] }).success).toBe(true);
    expect(automationRuleSchema.safeParse({ ...rule, actions: [{ ...action, good: 11 }] }).success).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';

import {
  canTransitionIncident,
  incidentCommandSchema,
  incidentStatusSchema,
  incidentTransitions,
} from './incidents.js';

describe('incident contracts', () => {
  it('allows only the explicit lifecycle edges', () => {
    for (const from of incidentStatusSchema.options)
      for (const to of incidentStatusSchema.options)
        expect(canTransitionIncident(from, to)).toBe(incidentTransitions[from].includes(to));
    expect(incidentTransitions).toEqual({
      declared: ['investigating'],
      investigating: ['identified'],
      identified: ['monitoring'],
      monitoring: ['resolved'],
      resolved: ['investigating'],
    });
  });
  it('rejects protected fields, malformed IDs and duplicate assignments', () => {
    const operationId = '11111111-1111-4111-8111-111111111111';
    expect(
      incidentCommandSchema.safeParse({
        operationId,
        command: { action: 'edit', fields: { status: 'resolved' } },
      }).success,
    ).toBe(false);
    expect(
      incidentCommandSchema.safeParse({
        operationId,
        command: { action: 'responders', userIds: ['invalid'] },
      }).success,
    ).toBe(false);
    expect(
      incidentCommandSchema.safeParse({
        operationId,
        command: {
          action: 'responders',
          userIds: ['111111111111111111111111', '111111111111111111111111'],
        },
      }).success,
    ).toBe(false);
  });
});

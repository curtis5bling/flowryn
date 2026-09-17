import { randomUUID } from 'node:crypto';

import {
  forecastSchema,
  overrideSchema,
  policySchema,
  scheduleSchema,
  type ScheduleInput,
} from '@flowryn/shared';
import { describe, expect, it } from 'vitest';

import { calculateOncall, forecastOncall, matchesRoute } from './schedules.js';
const a = '000000000000000000000001',
  b = '000000000000000000000002';
const active = new Set([a, b]);
const schedule = (): ScheduleInput => ({
  name: 'Primary',
  description: '',
  timezone: 'America/New_York',
  enabled: true,
  allowSelfOverrides: false,
  layers: [
    {
      id: randomUUID(),
      name: 'Primary',
      participants: [a, b],
      startsAt: '2026-03-08T05:00:00.000Z',
      shiftMinutes: 60,
      handoff: 'elapsedUTC',
    },
  ],
});
describe('UTC rotations and local coverage', () => {
  it('rotates by elapsed UTC across a daylight-saving jump', () => {
    const value = schedule();
    expect(calculateOncall(value, new Date('2026-03-08T06:30:00Z'), active)[0]!.userId).toBe(b);
    expect(calculateOncall(value, new Date('2026-03-08T07:30:00Z'), active)[0]!.userId).toBe(a);
  });
  it('does not invent coverage in the missing spring hour', () => {
    const value = schedule();
    value.layers[0]!.coverage = { days: [0], startsMinute: 120, endsMinute: 180 };
    const result = forecastOncall(
      value,
      new Date('2026-03-08T06:00:00Z'),
      new Date('2026-03-08T08:00:00Z'),
      active,
    );
    expect(result).toHaveLength(1);
    expect(result[0]!.gap).toBe(true);
  });
  it('covers both occurrences of the repeated fall hour', () => {
    const value = schedule();
    value.layers[0]!.startsAt = '2026-11-01T00:00:00Z';
    value.layers[0]!.coverage = { days: [0], startsMinute: 60, endsMinute: 120 };
    expect(
      calculateOncall(value, new Date('2026-11-01T05:30:00Z'), active)[0]!.userId,
    ).not.toBeNull();
    expect(
      calculateOncall(value, new Date('2026-11-01T06:30:00Z'), active)[0]!.userId,
    ).not.toBeNull();
    expect(calculateOncall(value, new Date('2026-11-01T07:00:00Z'), active)[0]!.userId).toBeNull();
  });
  it('evaluates ordered layers and reports missing participants as gaps', () => {
    const value = schedule();
    value.layers.push({ ...value.layers[0]!, id: randomUUID(), name: 'Backup', participants: [b] });
    const result = calculateOncall(value, new Date('2026-03-08T05:30:00Z'), new Set([b]));
    expect(result.map((row) => row.userId)).toEqual([null, b]);
    expect(
      forecastOncall(
        value,
        new Date('2026-03-08T05:00:00Z'),
        new Date('2026-03-08T05:15:00Z'),
        new Set(),
      )[0]!.gap,
    ).toBe(true);
  });
  it('uses half-open overrides before rotation and ignores cancellations', () => {
    const value = schedule();
    const override = {
      id: randomUUID(),
      layerId: value.layers[0]!.id,
      startsAt: '2026-03-08T05:00:00Z',
      endsAt: '2026-03-08T05:30:00Z',
      originalUserId: a,
      replacementUserId: b,
      reason: 'Swap',
    };
    expect(
      calculateOncall(value, new Date('2026-03-08T05:29:00Z'), active, [override])[0]!.userId,
    ).toBe(b);
    expect(calculateOncall(value, new Date(override.endsAt), active, [override])[0]!.userId).toBe(
      a,
    );
    expect(
      calculateOncall(value, new Date(override.startsAt), active, [
        { ...override, cancelledAt: new Date() },
      ])[0]!.userId,
    ).toBe(a);
  });
  it('uses weekly windows and does not page before rotation start or while disabled', () => {
    const value = schedule();
    value.layers[0]!.coverage = { days: [1], startsMinute: 0, endsMinute: 1440 };
    expect(calculateOncall(value, new Date('2026-03-08T05:30:00Z'), active)[0]!.userId).toBeNull();
    value.layers[0]!.coverage = undefined;
    expect(calculateOncall(value, new Date('2026-03-08T04:59:00Z'), active)[0]!.userId).toBeNull();
    value.enabled = false;
    expect(calculateOncall(value, new Date('2026-03-08T05:30:00Z'), active)[0]!.userId).toBeNull();
  });
  it('bounds invalid rotations, timezones, overrides and forecasts', () => {
    const value = schedule();
    expect(scheduleSchema.safeParse({ ...value, timezone: 'Mars/Base' }).success).toBe(false);
    expect(scheduleSchema.safeParse({ ...value, layers: [] }).success).toBe(false);
    expect(
      scheduleSchema.safeParse({ ...value, layers: [{ ...value.layers[0], participants: [a, a] }] })
        .success,
    ).toBe(false);
    expect(
      scheduleSchema.safeParse({ ...value, layers: [{ ...value.layers[0], shiftMinutes: 0 }] })
        .success,
    ).toBe(false);
    expect(
      forecastSchema.safeParse({ from: '2026-01-01T00:00:00Z', to: '2026-02-01T00:00:00Z' })
        .success,
    ).toBe(false);
    expect(
      overrideSchema.safeParse({
        layerId: randomUUID(),
        startsAt: '2026-01-01T00:00:00Z',
        endsAt: '2026-01-01T00:00:00Z',
        replacementUserId: a,
        reason: 'Swap',
      }).success,
    ).toBe(false);
  });
  it('bounds repeats and prevents zero-delay subsequent steps', () => {
    const step = {
      id: randomUUID(),
      delayMinutes: 0,
      target: { type: 'users', userIds: [a] },
      webhookIntegrationIds: [],
    };
    expect(
      policySchema.safeParse({ name: 'Policy', enabled: true, steps: [step], repeatCount: 4 })
        .success,
    ).toBe(false);
    expect(
      policySchema.safeParse({
        name: 'Policy',
        enabled: true,
        steps: [step, { ...step, id: randomUUID() }],
      }).success,
    ).toBe(false);
  });
  it('evaluates only allowlisted routing equalities and timezone windows', () => {
    const rule = {
      name: 'Route',
      enabled: true,
      priority: 0,
      policyId: a,
      conditions: [
        { field: 'label' as const, key: 'env', value: 'prod' },
        { field: 'hasIncident' as const, value: false },
        {
          field: 'timeWindow' as const,
          timezone: 'UTC',
          coverage: { days: [0], startsMinute: 0, endsMinute: 600 },
        },
      ],
    };
    expect(
      matchesRoute(
        rule,
        { severity: 'sev3', labels: { env: 'prod' } },
        new Date('2026-03-08T05:00:00Z'),
      ),
    ).toBe(true);
    expect(
      matchesRoute(
        rule,
        { severity: 'sev3', labels: { env: 'dev' } },
        new Date('2026-03-08T05:00:00Z'),
      ),
    ).toBe(false);
  });
});

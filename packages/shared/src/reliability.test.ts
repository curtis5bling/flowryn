import { describe, expect, it } from 'vitest';

import { dependencyInputSchema, monitorInputSchema, reliabilityMetricsQuerySchema, serviceInputSchema, signedSliBatchSchema, sliBatchSchema, sloInputSchema } from './reliability.js';

const id = '507f1f77bcf86cd799439011';
describe('reliability contracts', () => {
  it('bounds service metadata and rejects unsafe links', () => {
    const base = { name: 'API', slug: 'api', description: '', lifecycle: 'active', criticality: 'tier1', ownerIds: [id], projectIds: [], labels: {}, links: [] };
    expect(serviceInputSchema.safeParse(base).success).toBe(true);
    expect(serviceInputSchema.safeParse({ ...base, links: [{ label: 'runbook', url: 'javascript:alert(1)' }] }).success).toBe(false);
    expect(serviceInputSchema.safeParse({ ...base, labels: Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`k${i}`, 'v'])) }).success).toBe(false);
  });
  it('rejects self dependencies and invalid latency objectives', () => {
    expect(dependencyInputSchema.safeParse({ upstreamServiceId: id, downstreamServiceId: id, type: 'runtime', criticality: 'required', description: '', enabled: true }).success).toBe(false);
    expect(sloInputSchema.safeParse({ serviceId: id, name: 'Latency', description: '', enabled: true, indicatorType: 'latency', objectiveTarget: 99, rollingWindowDays: 30, dataSource: { type: 'api' }, missingDataPolicy: 'unknown', burnRateAlerts: [] }).success).toBe(false);
  });
  it('bounds ingestion batches and monitor behavior', () => {
    const sample = { serviceId: id, sloId: id, timestamp: new Date().toISOString(), good: 2, total: 1, idempotencyKey: 'sample:0001', metadata: {} };
    expect(sliBatchSchema.safeParse({ samples: [sample] }).success).toBe(false);
    expect(sliBatchSchema.safeParse({ samples: Array.from({ length: 101 }, () => ({ ...sample, good: 1 })) }).success).toBe(false);
    expect(monitorInputSchema.safeParse({ serviceId: id, name: 'health', enabled: false, url: 'https://service.example/health', method: 'GET', intervalSeconds: 10, timeoutMs: 5000, maxRedirects: 1, expectedStatusMin: 200, expectedStatusMax: 299 }).success).toBe(false);
  });
  it('accepts bounded latency and burn-rate objectives with source identities', () => {
    const input = { serviceId: id, name: 'Latency', description: '', enabled: true, indicatorType: 'latency', objectiveTarget: 99, rollingWindowDays: 30, latencyThresholdMs: 500, percentile: 95, dataSource: { type: 'webhook', sourceId: id }, missingDataPolicy: 'unknown', burnRateAlerts: [{ shortWindowMinutes: 5, longWindowMinutes: 60, threshold: 14.4 }] };
    expect(sloInputSchema.safeParse(input).success).toBe(true);
    expect(sloInputSchema.safeParse({ ...input, dataSource: { type: 'webhook' } }).success).toBe(false);
    expect(sloInputSchema.safeParse({ ...input, burnRateAlerts: [{ shortWindowMinutes: 60, longWindowMinutes: 60, threshold: 2 }] }).success).toBe(false);
  });
  it('requires a typed signed envelope and bounds metrics ranges', () => {
    const sample = { serviceId: id, sloId: id, timestamp: new Date().toISOString(), good: 1, total: 1, idempotencyKey: 'delivery:sample:1', metadata: {} };
    expect(signedSliBatchSchema.safeParse({ schemaVersion: 1, eventType: 'sli.received', samples: [sample] }).success).toBe(true);
    expect(signedSliBatchSchema.safeParse({ schemaVersion: 1, eventType: 'alert.received', samples: [sample] }).success).toBe(false);
    expect(reliabilityMetricsQuerySchema.safeParse({ from: '2026-01-01T00:00:00.000Z', to: '2026-05-01T00:00:00.000Z' }).success).toBe(false);
  });
});

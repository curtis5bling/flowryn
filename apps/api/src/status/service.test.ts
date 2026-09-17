import { statusPageInputSchema, subscriptionInputSchema } from '@flowryn/shared';
import { describe, expect, it } from 'vitest';

import { normalizePublicSlug, overallStatus, publicComponent, publicIncident, publicPage, token, tokenHash, tokenMatches, validTimezone } from './service.js';

describe('public status boundaries', () => {
  it('normalizes only unambiguous ASCII slugs and reserves application routes', () => {
    expect(normalizePublicSlug('acme-cloud')).toBe('acme-cloud');
    for (const value of ['API', 'status', 'acme_cloud', 'аcme']) expect(() => normalizePublicSlug(value)).toThrow();
  });
  it('calculates the deterministic worst visible component state', () => {
    expect(overallStatus(['operational', 'maintenance', 'partialOutage'])).toBe('partialOutage');
    expect(overallStatus([])).toBe('operational');
  });
  it('uses dedicated public allowlists', () => {
    const date = new Date('2026-01-01T00:00:00.000Z');
    const page = publicPage({ name: '<b>Acme</b>', slug: 'acme', description: 'safe text', branding: {}, timezone: 'UTC', updatedAt: date, workspaceId: 'private' });
    expect(page).not.toHaveProperty('workspaceId');
    const component = publicComponent({ stableId: 'stable', name: 'API', description: '', slug: 'api-service', order: 1, status: 'operational', workspaceId: 'private' });
    expect(component).not.toHaveProperty('workspaceId');
    const incident = publicIncident({ id: 'public', publicTitle: 'Notice', publicSummary: 'Summary', publicImpact: 'Impact', impact: 'minor', status: 'investigating', affectedComponentIds: [], publishedAt: date, internalIncidentId: 'private' });
    expect(incident).not.toHaveProperty('internalIncidentId');
  });
  it('hashes high-entropy tokens without retaining the plaintext', () => {
    const value = token(); expect(value.length).toBeGreaterThan(30); expect(tokenHash(value)).toMatch(/^[a-f0-9]{64}$/); expect(tokenHash(value)).not.toContain(value); expect(tokenMatches(value, tokenHash(value))).toBe(true); expect(tokenMatches('replay', tokenHash(value))).toBe(false);
  });
  it('validates IANA timezones', () => { expect(validTimezone('America/New_York')).toBe(true); expect(validTimezone('Not/AZone')).toBe(false); });
  it('rejects executable and non-http public links', () => {
    const base = { name: 'Acme', slug: 'acme', description: '', visibility: 'public', enabled: true, timezone: 'UTC', branding: { primaryColor: '#123456' } };
    expect(statusPageInputSchema.safeParse({ ...base, supportUrl: 'javascript:alert(1)' }).success).toBe(false);
    expect(statusPageInputSchema.safeParse({ ...base, supportUrl: 'https://example.com/help' }).success).toBe(true);
  });
  it('validates subscriber addresses by channel', () => {
    const common = { componentIds: [], incidents: true, maintenance: true };
    expect(subscriptionInputSchema.safeParse({ ...common, channel: 'email', address: 'person@example.com' }).success).toBe(true);
    expect(subscriptionInputSchema.safeParse({ ...common, channel: 'email', address: 'https://example.com' }).success).toBe(false);
    expect(subscriptionInputSchema.safeParse({ ...common, channel: 'webhook', address: 'file:///secret' }).success).toBe(false);
  });
});

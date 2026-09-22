import { describe, expect, it } from 'vitest';

import { assertSafeMonitorUrl, nextMonitorRunAt, normalizeServiceSlug } from './service.js';

describe('reliability security boundaries', () => {
  it('normalizes service slugs deterministically', () => expect(normalizeServiceSlug('API-Core')).toBe('api-core'));
  it('skips missed monitor slots after worker downtime', () => {
    const recoveredAt = new Date('2026-09-23T12:00:00.000Z');
    expect(nextMonitorRunAt(recoveredAt, 60).toISOString()).toBe('2026-09-23T12:01:00.000Z');
  });
  it('rejects private, credentialed and downgraded monitor URLs', () => {
    for (const value of ['http://example.com', 'https://user:pass@example.com', 'https://127.0.0.1', 'https://[::1]', 'https://169.254.169.254/latest']) expect(() => assertSafeMonitorUrl(value)).toThrow();
    expect(assertSafeMonitorUrl('https://openai.com/health').protocol).toBe('https:');
  });
});

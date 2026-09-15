import { randomUUID } from 'node:crypto';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  encryptionConfig,
  endpointUrl,
  publicAddress,
  sendWebhook,
  signBody,
  verifySignature,
  WebhookError,
  type NetworkAdapters,
} from './security.js';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});
describe('webhook security', () => {
  it.each([
    '127.0.0.1',
    '0.0.0.0',
    '10.1.2.3',
    '169.254.169.254',
    '172.31.0.1',
    '192.168.0.1',
    '100.64.0.1',
    '198.18.0.1',
    '192.0.0.1',
    '203.0.113.1',
    '224.0.0.1',
    '255.255.255.255',
    '::1',
    '::',
    'fc00::1',
    'fe80::1',
    'ff02::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '2001:db8::1',
    '2002:7f00:1::',
    '3fff::1',
    '3000::1',
    '2003:4000::1',
    '2620:200::1',
    '2d00::1',
    '3ffe::1',
  ])('denies special-use address %s', (address) => expect(publicAddress(address)).toBe(false));
  it.each(['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '2620:fe::fe'])(
    'allows public address %s',
    (address) => expect(publicAddress(address)).toBe(true),
  );
  it.each([
    'http://company.com',
    'https://user:secret@company.com',
    'https://company.com:8443',
    'https://company.com/?token=secret',
    'https://localhost',
    'https://internal',
    'https://127.1',
    'https://2130706433',
    'https://[::1]',
    'https://company.internal',
    'file:///tmp/test',
  ])('denies unsafe URL %s', (raw) => expect(() => endpointUrl(raw)).toThrow());
  it('verifies raw body, timestamp and delivery identity with a fixed clock', () => {
    const now = 1800000000000;
    const timestamp = String(now / 1000);
    const deliveryId = randomUUID();
    const body = Buffer.from('{"schemaVersion":1}');
    const signature = signBody('secret', timestamp, deliveryId, body);
    expect(verifySignature('secret', timestamp, deliveryId, body, signature, now)).toBe(true);
    expect(
      verifySignature('secret', timestamp, deliveryId, Buffer.from('{}'), signature, now),
    ).toBe(false);
    expect(verifySignature('secret', timestamp, randomUUID(), body, signature, now)).toBe(false);
    expect(verifySignature('secret', timestamp, deliveryId, body, signature, now + 301000)).toBe(
      false,
    );
    expect(verifySignature('secret', timestamp, deliveryId, body, 'bad', now)).toBe(false);
  });
  it('fails production encryption configuration clearly and never invents a key', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('AUTOMATION_ENCRYPTION_KEYS', '{}');
    expect(encryptionConfig).toThrow('AUTOMATION_ENCRYPTION_KEYS');
    vi.stubEnv('AUTOMATION_ENCRYPTION_KEYS', JSON.stringify({ '1': 'short' }));
    expect(encryptionConfig).toThrow();
  });
  const input = () => ({
    endpoint: 'https://hooks.company.com/events',
    secret: 'test-secret',
    eventId: randomUUID(),
    deliveryId: randomUUID(),
    body: '{}',
  });
  it('validates every DNS answer, rejects rebinding and pins the approved address', async () => {
    const send = vi.fn().mockResolvedValue(204);
    const adapters: NetworkAdapters = {
      resolve: async () => [
        { address: '8.8.8.8', family: 4 },
        { address: '127.0.0.1', family: 4 },
      ],
      send,
    };
    await expect(sendWebhook(input(), adapters)).rejects.toThrow('DESTINATION_DENIED');
    expect(send).not.toHaveBeenCalled();
    adapters.resolve = async () => [{ address: '8.8.8.8', family: 4 }];
    await sendWebhook(input(), adapters);
    expect(send.mock.calls[0]![1]).toEqual({ address: '8.8.8.8', family: 4 });
    expect(send.mock.calls[0]![2]['x-flowryn-schema-version']).toBe('1');
  });
  it('rejects all redirects without forwarding credentials', async () => {
    const send = vi.fn().mockResolvedValue(302);
    await expect(
      sendWebhook(input(), { resolve: async () => [{ address: '8.8.8.8', family: 4 }], send }),
    ).rejects.toThrow('DELIVERY_FAILED');
    expect(send).toHaveBeenCalledTimes(1);
  });
  it('bounds total DNS and delivery time and sanitizes network errors', async () => {
    vi.useFakeTimers();
    const pending = sendWebhook(input(), { resolve: () => new Promise(() => {}), send: vi.fn() });
    const rejection = expect(pending).rejects.toThrow('TIMEOUT');
    await vi.advanceTimersByTimeAsync(10001);
    await rejection;
    vi.useRealTimers();
    await expect(
      sendWebhook(input(), {
        resolve: async () => [{ address: '8.8.8.8', family: 4 }],
        send: async () => {
          throw new Error('secret response headers');
        },
      }),
    ).rejects.toEqual(new WebhookError('DELIVERY_FAILED', true));
  });
});

import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';

export class WebhookError extends Error {
  constructor(
    readonly code: 'DESTINATION_DENIED' | 'TIMEOUT' | 'RESPONSE_LIMIT' | 'DELIVERY_FAILED',
    readonly retryable = false,
    readonly statusCode?: number,
  ) {
    super(code);
  }
}
export const encryptionConfig = () => {
  const version = process.env.AUTOMATION_KEY_VERSION ?? '1';
  const raw = process.env.AUTOMATION_ENCRYPTION_KEYS;
  let keys: Record<string, string>;
  try {
    keys = JSON.parse(raw ?? '{}');
  } catch {
    throw new Error('Invalid automation encryption configuration');
  }
  if (
    !/^[a-zA-Z0-9_-]{1,32}$/.test(version) ||
    !keys[version] ||
    Object.entries(keys).some(
      ([v, k]) =>
        !/^[a-zA-Z0-9_-]{1,32}$/.test(v) || typeof k !== 'string' || !/^[a-f0-9]{64}$/i.test(k),
    )
  )
    throw new Error(
      'Configure AUTOMATION_ENCRYPTION_KEYS with 32-byte hex keys and AUTOMATION_KEY_VERSION',
    );
  return { version, keys };
};
export const newSigningSecret = () => randomBytes(32).toString('hex');
export const encryptSecret = (secret: string, workspaceId: string, integrationId: string) => {
  const { version, keys } = encryptionConfig();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(keys[version]!, 'hex'), iv);
  cipher.setAAD(Buffer.from(`${workspaceId}:${integrationId}:${version}`));
  const encrypted = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return {
    keyVersion: version,
    credentials: Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64'),
  };
};
export const decryptSecret = (record: {
  workspaceId: { toString(): string };
  _id: { toString(): string };
  keyVersion: string;
  credentials: string;
}) => {
  const { keys } = encryptionConfig();
  if (!keys[record.keyVersion]) throw new Error('Automation encryption key unavailable');
  const data = Buffer.from(record.credentials, 'base64');
  const decipher = createDecipheriv(
    'aes-256-gcm',
    Buffer.from(keys[record.keyVersion]!, 'hex'),
    data.subarray(0, 12),
  );
  decipher.setAAD(Buffer.from(`${record.workspaceId}:${record._id}:${record.keyVersion}`));
  decipher.setAuthTag(data.subarray(12, 28));
  return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString('utf8');
};
export const signBody = (
  secret: string,
  timestamp: string,
  deliveryId: string,
  body: Buffer | string,
) => createHmac('sha256', secret).update(`${timestamp}.${deliveryId}.`).update(body).digest('hex');
export const verifySignature = (
  secret: string,
  timestamp: string,
  deliveryId: string,
  body: Buffer,
  signature: string,
  now = Date.now(),
) => {
  if (
    !/^\d{10}$/.test(timestamp) ||
    Math.abs(now / 1000 - Number(timestamp)) > 300 ||
    !/^[a-f\d]{64}$/i.test(signature)
  )
    return false;
  return timingSafeEqual(
    Buffer.from(signature, 'hex'),
    Buffer.from(signBody(secret, timestamp, deliveryId, body), 'hex'),
  );
};
export const publicAddress = (address: string): boolean => {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split('.').map(Number) as [number, number, number, number];
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 0 || b === 168 || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113)
    );
  }
  if (isIP(address) !== 6 || address.includes('%') || address.includes('.')) return false;
  const normalized = new URL(`https://[${address}]/`).hostname.slice(1, -1);
  const [first, second] = normalized.split(':').map((v) => parseInt(v || '0', 16));
  // Only allocated RIR blocks from IANA's 2025-10-10 registry are accepted.
  // Deny unallocated/reserved space and all 2001/2002 special/transition space.
  return (
    (first === 0x2003 && second! < 0x4000) ||
    (first! >= 0x2400 && first! <= 0x241f) ||
    (first! >= 0x2600 && first! <= 0x260f) ||
    ((first === 0x2610 || first === 0x2620) && second! < 0x0200) ||
    (first! >= 0x2630 && first! <= 0x263f) ||
    (first! >= 0x2800 && first! <= 0x280f) ||
    (first! >= 0x2a00 && first! <= 0x2a1f) ||
    (first! >= 0x2c00 && first! <= 0x2c0f)
  );
};
export const endpointUrl = (raw: string) => {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new WebhookError('DESTINATION_DENIED');
  }
  if (
    url.protocol !== 'https:' ||
    (url.port && url.port !== '443') ||
    url.username ||
    url.password ||
    url.hash ||
    url.search ||
    !url.hostname ||
    url.hostname.endsWith('.') ||
    (!url.hostname.includes('.') && !url.hostname.includes(':'))
  )
    throw new WebhookError('DESTINATION_DENIED');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host) && !publicAddress(host)) throw new WebhookError('DESTINATION_DENIED');
  if (/(^|\.)(localhost|local|internal|test|invalid|example|onion)$/.test(host.toLowerCase()))
    throw new WebhookError('DESTINATION_DENIED');
  return url;
};
export type NetworkAdapters = {
  resolve: (hostname: string) => Promise<Array<{ address: string; family: number }>>;
  send: (
    url: URL,
    address: { address: string; family: number },
    headers: Record<string, string>,
    body: string,
    signal: AbortSignal,
  ) => Promise<number>;
};
export const networkAdapters: NetworkAdapters = {
  resolve: (hostname) => lookup(hostname, { all: true, verbatim: true }),
  send: (url, address, headers, body, signal) =>
    new Promise((resolve, reject) => {
      const request = httpsRequest(
        url,
        {
          method: 'POST',
          agent: false,
          signal,
          headers,
          maxHeaderSize: 8192,
          lookup: (_hostname, options, callback) =>
            options.all
              ? callback(null, [address])
              : callback(null, address.address, address.family),
        },
        (response) => {
          let bytes = 0;
          response.on('data', (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > 8192) {
              response.destroy();
              request.destroy(new WebhookError('RESPONSE_LIMIT'));
            }
          });
          response.on('error', reject);
          response.on('end', () => resolve(response.statusCode ?? 0));
          response.on('aborted', () => reject(new WebhookError('DELIVERY_FAILED', true)));
        },
      );
      const connectionTimeout = setTimeout(
        () => request.destroy(new WebhookError('TIMEOUT', true)),
        3000,
      );
      request.on('socket', (socket) =>
        socket.once('secureConnect', () => clearTimeout(connectionTimeout)),
      );
      request.on('close', () => clearTimeout(connectionTimeout));
      request.on('error', reject);
      request.end(body);
    }),
};
export const sendWebhook = async (
  input: { endpoint: string; secret: string; deliveryId: string; eventId: string; body: string },
  adapters = networkAdapters,
  now = Date.now(),
) => {
  const url = endpointUrl(input.endpoint);
  const controller = new AbortController();
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    deadline = setTimeout(() => {
      controller.abort();
      reject(new WebhookError('TIMEOUT', true));
    }, 10000);
  });
  try {
    return await Promise.race([
      (async () => {
        const host = url.hostname.replace(/^\[|\]$/g, '');
        const addresses = isIP(host)
          ? [{ address: host, family: isIP(host) }]
          : await adapters.resolve(host);
        if (
          !addresses.length ||
          addresses.length > 32 ||
          addresses.some((a) => !publicAddress(a.address) || isIP(a.address) !== a.family)
        )
          throw new WebhookError('DESTINATION_DENIED');
        if (controller.signal.aborted) throw new WebhookError('TIMEOUT', true);
        const timestamp = String(Math.floor(now / 1000));
        const status = await adapters.send(
          url,
          addresses[0]!,
          {
            'content-type': 'application/json',
            'content-length': String(Buffer.byteLength(input.body)),
            'x-flowryn-signature': signBody(input.secret, timestamp, input.deliveryId, input.body),
            'x-flowryn-timestamp': timestamp,
            'x-flowryn-event-id': input.eventId,
            'x-flowryn-delivery-id': input.deliveryId,
            'x-flowryn-schema-version': '1',
          },
          input.body,
          controller.signal,
        );
        // No redirects are followed, so credentials cannot cross destinations.
        if (status < 200 || status >= 300)
          throw new WebhookError('DELIVERY_FAILED', status === 429 || status >= 500, status);
        return status;
      })(),
      timeout,
    ]);
  } catch (error) {
    if (error instanceof WebhookError) throw error;
    throw new WebhookError('DELIVERY_FAILED', true);
  } finally {
    clearTimeout(deadline);
  }
};

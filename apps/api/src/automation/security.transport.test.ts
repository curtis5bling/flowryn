import { EventEmitter } from 'node:events';
import type { ClientRequest, IncomingMessage, RequestOptions } from 'node:http';
import { request } from 'node:https';

import { afterEach, expect, it, vi } from 'vitest';

import { networkAdapters } from './security.js';

vi.mock('node:https', () => ({ request: vi.fn() }));
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});
const mockRequest = (
  onEnd: (response: EventEmitter & { statusCode: number; destroy: () => void }) => void,
) => {
  const response = Object.assign(new EventEmitter(), { statusCode: 204, destroy: vi.fn() });
  const outgoing = Object.assign(new EventEmitter(), {
    end: () => onEnd(response),
    destroy: vi.fn((error?: Error) => {
      if (error) outgoing.emit('error', error);
      outgoing.emit('close');
      return outgoing;
    }),
  });
  vi.mocked(request).mockImplementation((...args: unknown[]) => {
    (args[2] as (response: IncomingMessage) => void)(response as unknown as IncomingMessage);
    return outgoing as unknown as ClientRequest;
  });
  return outgoing;
};
it('pins lookup for both Node single and all-address connection modes', async () => {
  mockRequest((response) => response.emit('end'));
  await networkAdapters.send(
    new URL('https://hooks.company.com'),
    { address: '8.8.8.8', family: 4 },
    {},
    '{}',
    new AbortController().signal,
  );
  const options = vi.mocked(request).mock.calls[0]![1] as RequestOptions;
  const callback = vi.fn();
  options.lookup!('hooks.company.com', { all: true }, callback);
  expect(callback).toHaveBeenLastCalledWith(null, [{ address: '8.8.8.8', family: 4 }]);
  options.lookup!('hooks.company.com', {}, callback);
  expect(callback).toHaveBeenLastCalledWith(null, '8.8.8.8', 4);
  expect(options.agent).toBe(false);
});
it('aborts an oversized response without persisting its body', async () => {
  const outgoing = mockRequest((response) => {
    response.emit('data', Buffer.alloc(8193));
  });
  await expect(
    networkAdapters.send(
      new URL('https://hooks.company.com'),
      { address: '8.8.8.8', family: 4 },
      {},
      '{}',
      new AbortController().signal,
    ),
  ).rejects.toThrow('RESPONSE_LIMIT');
  expect(outgoing.destroy).toHaveBeenCalled();
});
it('enforces the connection timeout without depending on remote response activity', async () => {
  vi.useFakeTimers();
  mockRequest(() => {});
  const sending = networkAdapters.send(
    new URL('https://hooks.company.com'),
    { address: '8.8.8.8', family: 4 },
    {},
    '{}',
    new AbortController().signal,
  );
  const failure = expect(sending).rejects.toThrow('TIMEOUT');
  await vi.advanceTimersByTimeAsync(3001);
  await failure;
});

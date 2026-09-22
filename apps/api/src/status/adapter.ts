import { sendWebhook } from '../automation/security.js';

import type { StatusDeliveryAdapter } from './worker.js';

class UnsupportedStatusChannelError extends Error {
  readonly retryable = false;
}

export const configuredStatusDeliveryAdapter = (): StatusDeliveryAdapter | undefined => {
  const secret = process.env.STATUS_WEBHOOK_SIGNING_SECRET;
  if (!secret || secret.length < 32) return undefined;
  return {
    async deliver(input) {
      if (input.channel !== 'webhook') throw new UnsupportedStatusChannelError('EMAIL_ADAPTER_UNAVAILABLE');
      await sendWebhook({
        endpoint: input.address,
        secret,
        deliveryId: input.deliveryId,
        eventId: input.eventId,
        body: JSON.stringify({
          schemaVersion: 1,
          eventType: input.eventType,
          statusPageSlug: input.statusPageSlug,
          verificationToken: input.verificationToken,
          unsubscribeToken: input.unsubscribeToken,
        }),
      });
    },
  };
};

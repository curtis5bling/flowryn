import { automationPayloadSchema, inboundAlertSchema, incidentIdSchema } from '@flowryn/shared';
import { Router, raw, type ErrorRequestHandler } from 'express';
import { z } from 'zod';

import { publishAutomationHint } from '../automation/hints.js';
import {
  AutomationRuleModel,
  InboundBucketModel,
  IntegrationModel,
  WebhookDeliveryModel,
} from '../automation/models.js';
import { emitDomainEvent } from '../automation/outbox.js';
import { automationActorId, automationPrincipal } from '../automation/principal.js';
import { decryptSecret, verifySignature } from '../automation/security.js';
import { IncidentModel } from '../models/Incident.js';
import { createAlert, transact } from '../oncall/service.js';

const router = Router();
const path = '/:workspaceId/:integrationId';
router.post(
  path,
  raw({ type: 'application/json', limit: '16kb', inflate: false }),
  async (request, response) => {
    const deny = () => response.status(401).json({ error: 'Webhook rejected' });
    const workspaceId = request.params.workspaceId as string;
    const integrationId = request.params.integrationId as string;
    if (
      !incidentIdSchema.safeParse(workspaceId).success ||
      !incidentIdSchema.safeParse(integrationId).success ||
      !Buffer.isBuffer(request.body)
    ) {
      deny();
      return;
    }
    const timestamp = request.get('x-flowryn-timestamp') ?? '';
    const deliveryId = request.get('x-flowryn-delivery-id') ?? '';
    const signature = request.get('x-flowryn-signature') ?? '';
    if (!z.string().uuid().safeParse(deliveryId).success) {
      deny();
      return;
    }
    try {
      const minute = Math.floor(Date.now() / 60000);
      const bucket = await InboundBucketModel.findOneAndUpdate(
        { _id: `${workspaceId}:${integrationId}:${minute}` },
        { $inc: { count: 1 }, $setOnInsert: { expiresAt: new Date((minute + 2) * 60000) } },
        { upsert: true, new: true },
      );
      if ((bucket.count ?? 0) > 60) {
        response.status(429).json({ error: 'Webhook rejected' });
        return;
      }
      const integration = await IntegrationModel.findOne({
        workspaceId,
        _id: integrationId,
        status: 'active',
        archivedAt: null,
        inboundEvents: 'alert.received',
      }).select('+credentials');
      if (
        !integration?.credentials ||
        !verifySignature(
          decryptSecret(integration as typeof integration & { credentials: string }),
          timestamp,
          deliveryId,
          request.body,
          signature,
        )
      ) {
        deny();
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(request.body.toString('utf8'));
      } catch {
        deny();
        return;
      }
      const alert = inboundAlertSchema.safeParse(parsed);
      if (!alert.success) {
        deny();
        return;
      }
      let openedAlert: { id: string; duplicate: boolean } | undefined;
      await transact(async (session) => {
        const active = await IntegrationModel.findOne({
          workspaceId,
          _id: integrationId,
          status: 'active',
          archivedAt: null,
          secretVersion: integration.secretVersion,
        }).session(session);
        if (!active) throw new Error('Rejected');
        // Fence concurrent archive/rotation against ingestion.
        await IntegrationModel.updateOne(
          { workspaceId, _id: integrationId },
          { $set: { lastDeliveryAt: new Date() } },
          { session },
        );
        const rules = await AutomationRuleModel.exists({
          workspaceId,
          triggerType: 'automation.manual',
          inboundIntegrationId: integrationId,
          enabled: true,
          archivedAt: null,
        }).session(session);
        if (alert.data.schemaVersion === 1 && !rules) throw new Error('Rejected');
        if (
          await WebhookDeliveryModel.exists({
            workspaceId,
            integrationId,
            direction: 'inbound',
            deliveryId,
          }).session(session)
        )
          throw new Error('Rejected');
        if (
          alert.data.incidentId &&
          !(await IncidentModel.exists({
            workspaceId,
            _id: alert.data.incidentId,
            archivedAt: null,
          }).session(session))
        )
          throw new Error('Rejected');
        if (alert.data.schemaVersion === 2) {
          const result = await createAlert({
            workspaceId,
            actorId: automationActorId,
            session,
            automation: {
              principal: automationPrincipal,
              configuredBy: String(active.createdBy),
              correlationId: deliveryId,
              causationId: deliveryId,
              chainDepth: 0,
              rulePath: [],
            },
            fields: {
              operationId: deliveryId,
              fingerprint: alert.data.fingerprint,
              title: alert.data.title,
              summary: alert.data.summary,
              severity: alert.data.severity,
              sourceIntegrationId: integrationId,
              ...(alert.data.incidentId ? { linkedIncidentId: alert.data.incidentId } : {}),
              ...(alert.data.externalEventId
                ? { externalEventId: alert.data.externalEventId }
                : {}),
              ...(alert.data.projectId ? { projectId: alert.data.projectId } : {}),
              ...(alert.data.serviceId ? { serviceId: alert.data.serviceId } : {}),
              labels: alert.data.labels,
            },
          });
          if (!result) throw new Error('Rejected');
          openedAlert = { id: result.alert.id, duplicate: result.duplicate };
          await WebhookDeliveryModel.create(
            [
              {
                workspaceId,
                integrationId,
                direction: 'inbound',
                deliveryId,
                eventId: deliveryId,
                eventType: 'alert.received',
                status: 'succeeded',
              },
            ],
            { session },
          );
          return;
        }
        const payload = automationPayloadSchema.parse({
          actorId: automationActorId,
          integrationId,
          severity: alert.data.severity,
          ...(alert.data.incidentId ? { incidentId: alert.data.incidentId } : {}),
          ...(alert.data.status ? { incidentStatus: alert.data.status } : {}),
        });
        await WebhookDeliveryModel.create(
          [
            {
              workspaceId,
              integrationId,
              direction: 'inbound',
              deliveryId,
              eventId: deliveryId,
              eventType: 'alert.received',
              status: 'succeeded',
            },
          ],
          { session },
        );
        await emitDomainEvent(session, {
          workspaceId,
          eventType: 'automation.manual',
          aggregateType: 'integration',
          aggregateId: integrationId,
          eventId: deliveryId,
          payload,
        });
      });
      if (openedAlert)
        publishAutomationHint({
          workspaceId,
          actorId: automationActorId,
          entityId: openedAlert.id,
          type: openedAlert.duplicate ? 'alert.occurrenceAdded' : 'alert.opened',
        });
      response.status(202).json({ accepted: true });
    } catch {
      deny();
    }
  },
);
const errors: ErrorRequestHandler = (_error, _request, response, next) => {
  void next;
  response.status(400).json({ error: 'Webhook rejected' });
};
router.use(errors);
export default router;

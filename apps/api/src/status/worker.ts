/* eslint-disable @typescript-eslint/no-explicit-any */
import mongoose from 'mongoose';

import { automationActorId } from '../automation/principal.js';
import { decryptSecret } from '../automation/security.js';

import {
  MaintenanceModel,
  PublicIncidentModel,
  StatusComponentModel,
  StatusDeliveryModel,
  StatusEventModel,
  StatusPageModel,
  StatusSubscriberModel,
} from './models.js';
import { appendStatusHistory, enqueueStatusEvent } from './service.js';

export type StatusDeliveryAdapter = {
  deliver(input: {
    channel: 'email' | 'webhook';
    address: string;
    deliveryId: string;
    eventId: string;
    eventType: string;
    statusPageSlug: string;
    verificationToken?: string;
    unsubscribeToken?: string;
  }): Promise<void>;
};

export const processStatusWork = async (
  now = new Date(),
  owner = 'status-worker',
  adapter?: StatusDeliveryAdapter,
) => {
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const reminders = await MaintenanceModel.find({
        status: 'scheduled',
        nextReminderAt: { $lte: now },
      }).sort({ nextReminderAt: 1 }).limit(100).session(session);
      for (const candidate of reminders) {
        for (const minutes of candidate.reminderMinutes ?? []) {
          if (candidate.scheduledStartAt!.getTime() - minutes * 60_000 > now.getTime()) continue;
          const key = `${candidate.scheduledStartAt!.toISOString()}:${minutes}`;
          const claimed = await MaintenanceModel.updateOne(
            { _id: candidate._id, status: 'scheduled', reminderKeys: { $ne: key } },
            { $addToSet: { reminderKeys: key } },
            { session },
          );
          if (claimed.modifiedCount)
          {
            candidate.reminderKeys.push(key);
            await enqueueStatusEvent(
              String(candidate.workspaceId),
              String(candidate.statusPageId),
              'maintenance.reminder',
              { maintenanceId: candidate.id, minutesBeforeStart: minutes },
              session,
            );
          }
        }
        const sent = new Set(candidate.reminderKeys);
        const nextTimes = (candidate.reminderMinutes ?? [])
          .filter((minutes) => !sent.has(`${candidate.scheduledStartAt!.toISOString()}:${minutes}`))
          .map((minutes) => candidate.scheduledStartAt!.getTime() - minutes * 60_000)
          .filter((time) => time > now.getTime());
        await MaintenanceModel.updateOne(
          { _id: candidate._id, status: 'scheduled' },
          nextTimes.length
            ? { $set: { nextReminderAt: new Date(Math.min(...nextTimes)) } }
            : { $unset: { nextReminderAt: 1 } },
          { session },
        );
      }
      const maintenance = await MaintenanceModel.findOne({
        $or: [
          { status: 'scheduled', scheduledStartAt: { $lte: now } },
          { status: 'inProgress', scheduledEndAt: { $lte: now } },
        ],
      })
        .sort({ scheduledStartAt: 1 })
        .session(session);
      if (
        maintenance?.status === 'scheduled' &&
        maintenance.scheduledEndAt &&
        maintenance.scheduledEndAt <= now
      ) {
        maintenance.status = 'cancelled';
        maintenance.cancelledAt = now;
        await maintenance.save({ session });
        await StatusComponentModel.updateMany(
          {
            workspaceId: maintenance.workspaceId,
            statusPageId: maintenance.statusPageId,
            _id: { $in: maintenance.affectedComponentIds },
          },
          { $pull: { maintenanceReservations: { maintenanceId: maintenance._id } } },
          { session },
        );
      } else if (maintenance?.status === 'scheduled') {
        const components = await StatusComponentModel.find({
          workspaceId: maintenance.workspaceId,
          statusPageId: maintenance.statusPageId,
          _id: { $in: maintenance.affectedComponentIds },
          archivedAt: null,
        }).session(session);
        maintenance.set(
          'componentSnapshots',
          components.map((component) => ({
            componentId: component._id,
            status: component.status,
            revision: component.statusRevision,
          })),
        );
        for (const component of components) {
          const old = component.status;
          component.status = 'maintenance';
          component.statusRevision++;
          await component.save({ session });
          await appendStatusHistory(
            {
              workspaceId: String(maintenance.workspaceId),
              statusPageId: String(maintenance.statusPageId),
              componentId: component.id,
              fromStatus: old,
              toStatus: 'maintenance',
              source: 'maintenance',
              sourceId: maintenance.id,
              revision: component.statusRevision,
              createdBy: String(maintenance.createdBy),
            },
            session,
          );
        }
        maintenance.status = 'inProgress';
        maintenance.startedAt = now;
        await maintenance.save({ session });
        await enqueueStatusEvent(
          String(maintenance.workspaceId),
          String(maintenance.statusPageId),
          'maintenance.started',
          { maintenanceId: maintenance.id },
          session,
        );
      } else if (maintenance?.status === 'inProgress') {
        for (const snapshot of maintenance.componentSnapshots as any[]) {
          const component = await StatusComponentModel.findOne({
            workspaceId: maintenance.workspaceId,
            statusPageId: maintenance.statusPageId,
            _id: snapshot.componentId,
            status: 'maintenance',
            statusRevision: snapshot.revision + 1,
          }).session(session);
          if (!component) continue;
          component.status = snapshot.status;
          component.statusRevision++;
          await component.save({ session });
          await appendStatusHistory(
            {
              workspaceId: String(maintenance.workspaceId),
              statusPageId: String(maintenance.statusPageId),
              componentId: component.id,
              fromStatus: 'maintenance',
              toStatus: snapshot.status,
              source: 'maintenance',
              sourceId: maintenance.id,
              revision: component.statusRevision,
              createdBy: String(maintenance.createdBy),
            },
            session,
          );
        }
        maintenance.status = 'completed';
        maintenance.completedAt = now;
        await maintenance.save({ session });
        await StatusComponentModel.updateMany(
          {
            workspaceId: maintenance.workspaceId,
            statusPageId: maintenance.statusPageId,
            _id: { $in: maintenance.affectedComponentIds },
          },
          { $pull: { maintenanceReservations: { maintenanceId: maintenance._id } } },
          { session },
        );
        await enqueueStatusEvent(
          String(maintenance.workspaceId),
          String(maintenance.statusPageId),
          'maintenance.completed',
          { maintenanceId: maintenance.id },
          session,
        );
      }
    });
  } finally {
    await session.endSession();
  }
  const event = await StatusEventModel.findOneAndUpdate(
    {
      $or: [
        { status: 'pending', availableAt: { $lte: now } },
        { status: 'processing', leaseExpiresAt: { $lte: now } },
      ],
    },
    {
      $set: {
        status: 'processing',
        leaseOwner: owner,
        leaseExpiresAt: new Date(now.getTime() + 60_000),
      },
      $inc: { attemptCount: 1 },
    },
    { new: true },
  );
  if (event) try {
    const subscriberQuery = event.targetSubscriberId
      ? { workspaceId: event.workspaceId, statusPageId: event.statusPageId, _id: event.targetSubscriberId }
      : { workspaceId: event.workspaceId, statusPageId: event.statusPageId, verifiedAt: { $ne: null }, unsubscribedAt: null };
    const subscribers = await StatusSubscriberModel.find(subscriberQuery)
      .select('_id')
      .limit(10000);
    if (subscribers.length)
      await StatusDeliveryModel.bulkWrite(
        subscribers.map((subscriber) => ({
          updateOne: {
            filter: { idempotencyKey: `${event.eventId}:${subscriber.id}` },
            update: {
              $setOnInsert: {
                workspaceId: event.workspaceId,
                statusPageId: event.statusPageId,
                subscriberId: subscriber._id,
                eventId: event.eventId,
                status: adapter ? 'pending' : 'dead',
                attemptCount: adapter ? 0 : 1,
                availableAt: now,
                errorCode: adapter ? null : 'DELIVERY_ADAPTER_UNAVAILABLE',
              },
            },
            upsert: true,
          },
        })),
        { ordered: false },
      );
    event.status = 'completed';
    event.leaseOwner = undefined;
    event.leaseExpiresAt = undefined;
    await event.save();
  } catch {
    event.status = event.attemptCount >= 5 ? 'dead' : 'pending';
    event.availableAt = new Date(now.getTime() + Math.min(300000, 1000 * 2 ** event.attemptCount));
    event.error = 'PROCESSING_FAILED';
    event.leaseOwner = undefined;
    event.leaseExpiresAt = undefined;
    await event.save();
  }
  if (!adapter) {
    await StatusDeliveryModel.updateMany(
      { status: 'pending', availableAt: { $lte: now } },
      { $set: { status: 'dead', errorCode: 'DELIVERY_ADAPTER_UNAVAILABLE' } },
    );
    return;
  }
  await StatusDeliveryModel.updateMany(
    { status: 'failed', attemptCount: { $gte: 5 }, availableAt: { $lte: now } },
    { $set: { status: 'dead', errorCode: 'DELIVERY_FAILED' } },
  );
  const delivery = await StatusDeliveryModel.findOneAndUpdate(
    {
      $or: [
        { status: 'pending', attemptCount: { $lt: 5 } },
        { status: 'failed', attemptCount: { $lt: 5 } },
      ],
      availableAt: { $lte: now },
    },
    { $set: { status: 'failed', availableAt: new Date(now.getTime() + 60_000) }, $inc: { attemptCount: 1 } },
    { new: true, sort: { availableAt: 1, _id: 1 } },
  );
  if (!delivery) return;
  const [deliveryEvent, page, subscriber] = await Promise.all([
    StatusEventModel.findOne({ workspaceId: delivery.workspaceId, statusPageId: delivery.statusPageId, eventId: delivery.eventId }),
    StatusPageModel.findOne({
      workspaceId: delivery.workspaceId,
      _id: delivery.statusPageId,
      archivedAt: null,
      enabled: true,
      publishedAt: { $ne: null },
      visibility: { $in: ['public', 'unlisted'] },
    }).select('slug'),
    StatusSubscriberModel.findOne({ workspaceId: delivery.workspaceId, statusPageId: delivery.statusPageId, _id: delivery.subscriberId })
      .select('+addressCiphertext +keyVersion +verificationTokenCiphertext +verificationKeyVersion +verificationExpiresAt +unsubscribeTokenCiphertext +unsubscribeKeyVersion'),
  ]);
  const verification = deliveryEvent?.type === 'subscription.verify';
  const preferenceEligible = !deliveryEvent || verification ||
    (deliveryEvent.type?.startsWith('publicIncident.') ? subscriber?.incidents !== false :
      deliveryEvent.type?.startsWith('maintenance.') ? subscriber?.maintenance !== false : true);
  let componentEligible = true;
  if (deliveryEvent?.type === 'component.statusChanged') {
    const stableId = (deliveryEvent.publicPayload as { id?: unknown } | null)?.id;
    const publicComponent = typeof stableId === 'string' ? await StatusComponentModel.findOne({
      workspaceId: delivery.workspaceId,
      statusPageId: delivery.statusPageId,
      stableId,
      enabled: true,
      hidden: false,
      archivedAt: null,
    }).select('_id') : null;
    componentEligible = Boolean(
      publicComponent &&
      (!subscriber?.componentIds.length || subscriber.componentIds.some((selected) => selected.equals(publicComponent._id))),
    );
  }
  if (deliveryEvent && subscriber?.componentIds.length && deliveryEvent.type?.startsWith('publicIncident.')) {
    const incidentId = (deliveryEvent.publicPayload as { incidentId?: unknown; publicIncidentId?: unknown } | null)?.incidentId ??
      (deliveryEvent.publicPayload as { publicIncidentId?: unknown } | null)?.publicIncidentId;
    const incident = typeof incidentId === 'string' ? await PublicIncidentModel.findOne({
      workspaceId: delivery.workspaceId,
      statusPageId: delivery.statusPageId,
      _id: incidentId,
    }).select('affectedComponentIds') : null;
    componentEligible = Boolean(incident && (!incident.affectedComponentIds.length || incident.affectedComponentIds.some((id) => subscriber.componentIds.some((selected) => selected.equals(id)))));
  }
  if (deliveryEvent && subscriber?.componentIds.length && deliveryEvent.type?.startsWith('maintenance.')) {
    const maintenanceId = (deliveryEvent.publicPayload as { maintenanceId?: unknown } | null)?.maintenanceId;
    const maintenance = typeof maintenanceId === 'string' ? await MaintenanceModel.findOne({
      workspaceId: delivery.workspaceId,
      statusPageId: delivery.statusPageId,
      _id: maintenanceId,
    }).select('affectedComponentIds') : null;
    componentEligible = Boolean(maintenance && (!maintenance.affectedComponentIds.length || maintenance.affectedComponentIds.some((id) => subscriber.componentIds.some((selected) => selected.equals(id)))));
  }
  const eligible = Boolean(
    deliveryEvent && page && subscriber && !subscriber.unsubscribedAt && preferenceEligible && componentEligible &&
    (verification
      ? !subscriber.verifiedAt && subscriber.verificationExpiresAt && subscriber.verificationExpiresAt > now && subscriber.verificationTokenCiphertext
      : subscriber.verifiedAt),
  );
  if (!eligible) {
    await StatusDeliveryModel.updateOne({ _id: delivery._id, status: 'failed', attemptCount: delivery.attemptCount }, { $set: { status: 'cancelled', errorCode: 'SUBSCRIBER_INELIGIBLE' } });
    return;
  }
  const secret = (credentials: string, keyVersion: string) => decryptSecret({ workspaceId: subscriber!.workspaceId, _id: subscriber!._id, keyVersion, credentials });
  try {
    await adapter.deliver({
      channel: subscriber!.channel as 'email' | 'webhook',
      address: secret(subscriber!.addressCiphertext!, subscriber!.keyVersion),
      deliveryId: delivery.id,
      eventId: delivery.eventId!,
      eventType: deliveryEvent!.type!,
      statusPageSlug: page!.slug!,
      verificationToken: verification ? secret(subscriber!.verificationTokenCiphertext!, subscriber!.verificationKeyVersion ?? subscriber!.keyVersion) : undefined,
      unsubscribeToken: !verification && subscriber!.unsubscribeTokenCiphertext ? secret(subscriber!.unsubscribeTokenCiphertext, subscriber!.unsubscribeKeyVersion ?? subscriber!.keyVersion) : undefined,
    });
    await StatusDeliveryModel.updateOne(
      { _id: delivery._id, status: 'failed', attemptCount: delivery.attemptCount },
      { $set: { status: 'succeeded', deliveredAt: now, errorCode: null } },
    );
  } catch (error) {
    const retryable = (error as { retryable?: boolean }).retryable !== false;
    const dead = !retryable || delivery.attemptCount >= 5;
    const jitter = Number.parseInt(delivery.id.slice(-4), 16) % 1000;
    await StatusDeliveryModel.updateOne(
      { _id: delivery._id, status: 'failed', attemptCount: delivery.attemptCount },
      { $set: { status: dead ? 'dead' : 'failed', availableAt: new Date(now.getTime() + Math.min(300_000, 1000 * 2 ** delivery.attemptCount) + jitter), errorCode: 'DELIVERY_FAILED' } },
    );
  }
  void automationActorId;
};

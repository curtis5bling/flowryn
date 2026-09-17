/* eslint-disable @typescript-eslint/no-explicit-any */
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

import { statusSeverity, type StatusComponentState } from '@flowryn/shared';
import type { ClientSession } from 'mongoose';

import { encryptionConfig } from '../automation/security.js';
import { IncidentError } from '../incidents/service.js';
import { ActivityModel } from '../models/Activity.js';

import { StatusEventModel, StatusHistoryModel } from './models.js';

const reserved = new Set([
  'api',
  'app',
  'admin',
  'auth',
  'login',
  'logout',
  'status',
  'health',
  'ready',
  'www',
  'support',
  'help',
]);
export const normalizePublicSlug = (value: string) => {
  const normalized = value.normalize('NFKC').toLowerCase();
  if (
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(normalized) ||
    normalized !== value.toLowerCase() ||
    reserved.has(normalized)
  )
    throw new IncidentError(400, 'Invalid or reserved public slug');
  return normalized;
};
export const validTimezone = (value: string) => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
};
export const overallStatus = (statuses: StatusComponentState[]) =>
  statuses.reduce<StatusComponentState>(
    (worst, value) => (statusSeverity[value] > statusSeverity[worst] ? value : worst),
    'operational',
  );
export const token = () => randomBytes(32).toString('base64url');
export const tokenHash = (value: string) => createHash('sha256').update(value).digest('hex');
export const tokenMatches = (value: string, expected: string) => {
  const actual = Buffer.from(tokenHash(value), 'hex');
  const stored = Buffer.from(expected, 'hex');
  return actual.length === stored.length && timingSafeEqual(actual, stored);
};
export const subscriberLookupKey = () => {
  const configured = process.env.STATUS_SUBSCRIBER_LOOKUP_KEY;
  if (configured && /^[a-f0-9]{64}$/i.test(configured)) return configured;
  if (process.env.NODE_ENV === 'production')
    throw new Error('Configure STATUS_SUBSCRIBER_LOOKUP_KEY with a stable 32-byte hex key');
  const { keys } = encryptionConfig();
  return keys[Object.keys(keys).sort()[0]!]!;
};
export const addressHash = (
  pageId: string,
  value: string,
  channel: 'email' | 'webhook' = 'email',
) => {
  const normalized = channel === 'email'
    ? value.trim().toLowerCase()
    : (() => {
        const url = new URL(value.trim());
        url.hostname = url.hostname.toLowerCase();
        return url.toString();
      })();
  return createHmac('sha256', subscriberLookupKey())
    .update(`${pageId}:${channel}:${normalized}`)
    .digest('hex');
};
export const publicPage = (page: any, lastUpdatedAt: Date = page.updatedAt) => ({
  name: page.name,
  slug: page.slug,
  description: page.description ?? '',
  branding: {
    logoUrl: page.branding?.logoUrl ?? null,
    primaryColor: page.branding?.primaryColor ?? '#d7674d',
  },
  supportUrl: page.supportUrl ?? null,
  timezone: page.timezone,
  lastUpdatedAt: lastUpdatedAt.toISOString(),
});
export const publicComponent = (component: any, groupIds = new Map<string, string>()) => ({
  id: component.stableId,
  name: component.name,
  description: component.description ?? '',
  slug: component.slug,
  order: component.order,
  groupId: component.groupId ? (groupIds.get(String(component.groupId)) ?? null) : null,
  status: component.status,
});
export const publicIncident = (
  incident: any,
  updates: any[] = [],
  componentIds = new Map<string, string>(),
) => ({
  id: incident.id,
  title: incident.publicTitle,
  summary: incident.publicSummary,
  impact: incident.publicImpact,
  impactLevel: incident.impact,
  status: incident.status,
  affectedComponentIds: incident.affectedComponentIds
    .map(String)
    .map((id: string) => componentIds.get(id))
    .filter(Boolean),
  publishedAt: incident.publishedAt.toISOString(),
  resolvedAt: incident.resolvedAt?.toISOString() ?? null,
  updates: updates.map((update) => ({
    id: update.id,
    status: update.status,
    message: update.message,
    publishedAt: update.publishedAt.toISOString(),
    correctionOf: update.correctionOf ? String(update.correctionOf) : null,
  })),
});
export const recordStatusActivity = (
  workspaceId: string,
  actorId: string,
  entityId: string,
  action: string,
  session?: ClientSession,
) =>
  ActivityModel.create(
    [
      {
        workspaceId,
        actorId,
        entityId,
        entityType: 'status',
        action,
        metadata: { publicStatus: true },
      },
    ],
    session ? { session } : undefined,
  );
export const enqueueStatusEvent = (
  workspaceId: string,
  statusPageId: string,
  type: string,
  publicPayload: Record<string, unknown>,
  session?: ClientSession,
  targetSubscriberId?: string,
) =>
  StatusEventModel.create(
    [{ workspaceId, statusPageId, eventId: randomUUID(), type, publicPayload, targetSubscriberId }],
    session ? { session } : undefined,
  );
export const appendStatusHistory = (
  fields: {
    workspaceId: string;
    statusPageId: string;
    componentId: string;
    fromStatus: string;
    toStatus: string;
    source: string;
    sourceId?: string;
    revision: number;
    createdBy: string;
  },
  session?: ClientSession,
) =>
  StatusHistoryModel.create(
    [{ ...fields, changedAt: new Date() }],
    session ? { session } : undefined,
  );

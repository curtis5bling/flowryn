import { z } from 'zod';

import { incidentIdSchema, incidentSeveritySchema } from './incidents.js';

export const oncallLimits = {
  layers: 8,
  participants: 32,
  steps: 8,
  repeats: 3,
  forecastDays: 7,
  rules: 100,
  attempts: 5,
} as const;
const id = incidentIdSchema.transform((value) => value.toLowerCase());
const text = (max: number) => z.string().trim().min(1).max(max);
export const timezoneSchema = text(100).refine((value) => {
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return value === 'UTC' || value.includes('/');
  } catch {
    return false;
  }
}, 'Use an IANA timezone');
const instant = z
  .string()
  .datetime()
  .refine((value) => Date.parse(value) % 60000 === 0, 'Use minute-aligned UTC timestamps');
const uniqueIds = z
  .array(id)
  .min(1)
  .max(oncallLimits.participants)
  .refine((values) => new Set(values).size === values.length, 'Duplicate participants');
export const coverageSchema = z
  .object({
    days: z
      .array(z.number().int().min(0).max(6))
      .min(1)
      .max(7)
      .refine((v) => new Set(v).size === v.length),
    startsMinute: z.number().int().min(0).max(1439),
    endsMinute: z.number().int().min(1).max(1440),
  })
  .strict()
  .refine(
    (v) => v.startsMinute < v.endsMinute,
    'Coverage must end after start; split overnight windows into layers',
  );
export const scheduleLayerSchema = z
  .object({
    id: z.string().uuid(),
    name: text(100),
    participants: uniqueIds,
    startsAt: instant,
    shiftMinutes: z.number().int().min(15).max(10080),
    handoff: z.literal('elapsedUTC'),
    coverage: coverageSchema.optional(),
  })
  .strict();
export const scheduleSchema = z
  .object({
    name: text(200),
    description: z.string().trim().max(2000).default(''),
    timezone: timezoneSchema,
    enabled: z.boolean(),
    allowSelfOverrides: z.boolean().default(false),
    layers: z.array(scheduleLayerSchema).min(1).max(oncallLimits.layers),
  })
  .strict()
  .refine(
    (v) => new Set(v.layers.map((l) => l.id)).size === v.layers.length,
    'Duplicate layer IDs',
  );
export type ScheduleInput = z.infer<typeof scheduleSchema>;
export type Schedule = ScheduleInput & { id: string; version: number; archivedAt: string | null };
export const overrideSchema = z
  .object({
    layerId: z.string().uuid(),
    startsAt: instant,
    endsAt: instant,
    originalUserId: id.optional(),
    replacementUserId: id,
    reason: text(500),
  })
  .strict()
  .refine(
    (v) =>
      Date.parse(v.endsAt) > Date.parse(v.startsAt) &&
      Date.parse(v.endsAt) - Date.parse(v.startsAt) <= 7 * 86400000,
    'Override range must be within seven days',
  );
export type OverrideInput = z.infer<typeof overrideSchema>;
export type ScheduleOverride = OverrideInput & {
  id: string;
  scheduleId: string;
  cancelledAt?: string | null;
  createdBy: string;
};
const targetSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('schedule'), scheduleId: id }).strict(),
  z.object({ type: z.literal('users'), userIds: uniqueIds }).strict(),
  z.object({ type: z.literal('commander') }).strict(),
  z.object({ type: z.literal('responders') }).strict(),
]);
export const policySchema = z
  .object({
    name: text(200),
    description: z.string().trim().max(2000).default(''),
    enabled: z.boolean(),
    steps: z
      .array(
        z
          .object({
            id: z.string().uuid(),
            delayMinutes: z.number().int().min(0).max(1440),
            target: targetSchema,
            webhookIntegrationIds: z
              .array(id)
              .max(4)
              .default([])
              .refine((v) => new Set(v).size === v.length),
          })
          .strict(),
      )
      .min(1)
      .max(oncallLimits.steps),
    repeatCount: z.number().int().min(0).max(oncallLimits.repeats).default(0),
    repeatDelayMinutes: z.number().int().min(1).max(1440).default(30),
  })
  .strict()
  .refine(
    (v) =>
      new Set(v.steps.map((s) => s.id)).size === v.steps.length &&
      v.steps.slice(1).every((s) => s.delayMinutes > 0),
    'Use unique step IDs and positive subsequent delays',
  );
export type PolicyInput = z.infer<typeof policySchema>;
export type EscalationPolicy = PolicyInput & {
  id: string;
  version: number;
  archivedAt: string | null;
};
export const safeLabelsSchema = z
  .record(z.string().regex(/^[a-zA-Z0-9_.-]{1,40}$/), z.string().trim().max(120))
  .refine(
    (v) =>
      Object.keys(v).length <= 16 &&
      !Object.keys(v).some((key) => ['__proto__', 'constructor', 'prototype'].includes(key)),
    'Too many or unsafe labels',
  );
export const alertInputSchema = z
  .object({
    operationId: z.string().uuid(),
    fingerprint: z.string().regex(/^[a-zA-Z0-9_.:/-]{1,160}$/),
    title: text(200),
    summary: z.string().trim().max(4000).default(''),
    severity: incidentSeveritySchema,
    sourceIntegrationId: id.optional(),
    externalEventId: text(160).optional(),
    escalationPolicyId: id.optional(),
    linkedIncidentId: id.optional(),
    projectId: id.optional(),
    serviceId: z
      .string()
      .regex(/^[a-zA-Z0-9_.-]{1,100}$/)
      .optional(),
    labels: safeLabelsSchema.default({}),
  })
  .strict();
export type AlertInput = z.infer<typeof alertInputSchema>;
export const alertStatusSchema = z.enum(['open', 'acknowledged', 'resolved', 'suppressed']);
export type Alert = Omit<AlertInput, 'operationId' | 'escalationPolicyId'> & {
  id: string;
  status: z.infer<typeof alertStatusSchema>;
  occurrenceCount: number;
  firstReceivedAt: string;
  lastReceivedAt: string;
  acknowledgedAt?: string;
  resolvedAt?: string;
  suppressionEndsAt?: string;
  escalationPolicyId?: string;
  escalationPolicyVersion?: number;
  cycle: number;
  correlationId: string;
};
export const routingConditionSchema = z.discriminatedUnion('field', [
  z.object({ field: z.literal('sourceIntegrationId'), value: id }).strict(),
  z.object({ field: z.literal('severity'), value: incidentSeveritySchema }).strict(),
  z
    .object({
      field: z.literal('label'),
      key: z.string().regex(/^[a-zA-Z0-9_.-]{1,40}$/),
      value: z.string().max(120),
    })
    .strict(),
  z.object({ field: z.literal('projectId'), value: id }).strict(),
  z.object({ field: z.literal('serviceId'), value: text(100) }).strict(),
  z.object({ field: z.literal('hasIncident'), value: z.boolean() }).strict(),
  z
    .object({ field: z.literal('timeWindow'), timezone: timezoneSchema, coverage: coverageSchema })
    .strict(),
]);
export const routingSchema = z
  .object({
    name: text(200),
    enabled: z.boolean(),
    priority: z.number().int().min(0).max(10000),
    policyId: id,
    conditions: z.array(routingConditionSchema).max(16),
  })
  .strict();
export type RoutingInput = z.infer<typeof routingSchema>;
export type RoutingRule = RoutingInput & { id: string; version: number; archivedAt: string | null };
export const oncallQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).max(10000).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    archived: z.enum(['true', 'false']).optional(),
    status: alertStatusSchema.optional(),
    severity: incidentSeveritySchema.optional(),
    policyId: id.optional(),
    integrationId: id.optional(),
    incidentId: id.optional(),
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),
    search: z.string().trim().max(100).optional(),
  })
  .strict()
  .refine((v) => !v.from || !v.to || Date.parse(v.from) <= Date.parse(v.to), 'Invalid date range');
export const forecastSchema = z
  .object({ from: instant, to: instant })
  .strict()
  .refine(
    (v) =>
      Date.parse(v.to) > Date.parse(v.from) &&
      Date.parse(v.to) - Date.parse(v.from) <= oncallLimits.forecastDays * 86400000,
    'Forecast must be within seven days',
  );
export type CoverageSegment = {
  startsAt: string;
  endsAt: string;
  layerRecipients: Array<{ layerId: string; userId: string | null; overrideId?: string }>;
  gap: boolean;
};
export type EscalationDelivery = {
  id: string;
  step: number;
  cycle: number;
  channel: 'notification' | 'webhook' | 'gap';
  recipients: string[];
  status: string;
  attemptCount: number;
  error?: string;
  integrationId?: string;
  deliveryKey: string;
};
export type EscalationExecution = {
  id: string;
  status: string;
  currentStep: number;
  repeatIndex: number;
  policyId: string;
  policyVersion: number;
  nextEscalationAt?: string;
  attemptCount: number;
};
export const oncallEventNames = [
  'oncall.scheduleUpdated',
  'oncall.overrideCreated',
  'oncall.overrideCancelled',
  'alert.opened',
  'alert.occurrenceAdded',
  'alert.acknowledged',
  'alert.resolved',
  'alert.reopened',
  'alert.suppressed',
  'escalation.advanced',
  'escalation.deliveryFailed',
  'alert.incidentLinked',
] as const;

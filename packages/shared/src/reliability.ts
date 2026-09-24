import { z } from 'zod';

const id = z.string().regex(/^[a-f\d]{24}$/i);
const text = (max: number) => z.string().trim().max(max);
const safeUrl = z.string().url().max(500).refine((value) => ['https:', 'http:'].includes(new URL(value).protocol));
export const serviceLifecycleSchema = z.enum(['active', 'deprecated', 'retired']);
export const serviceCriticalitySchema = z.enum(['tier1', 'tier2', 'tier3', 'tier4']);
export const serviceInputSchema = z.object({
  name: text(120).min(1), slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(80), description: text(4000).default(''),
  lifecycle: serviceLifecycleSchema.default('active'), criticality: serviceCriticalitySchema, ownerIds: z.array(id).min(1).max(20), projectIds: z.array(id).max(50).default([]),
  labels: z.record(z.string().regex(/^[a-zA-Z0-9_.-]{1,40}$/), text(100)).refine((x) => Object.keys(x).length <= 20),
  links: z.array(z.object({ label: text(80).min(1), url: safeUrl })).max(20),
});
export const dependencyInputSchema = z.object({
  upstreamServiceId: id, downstreamServiceId: id, type: z.enum(['runtime', 'data', 'control', 'external']), criticality: z.enum(['required', 'degraded', 'optional']),
  description: text(1000).default(''), enabled: z.boolean().default(true),
}).refine((x) => x.upstreamServiceId !== x.downstreamServiceId, { message: 'Self dependency is not allowed' });
export const relationshipInputSchema = z.object({ serviceId: id, targetType: z.enum(['statusComponent', 'incident', 'alert', 'escalationPolicy', 'project']), targetId: id });
export const sloInputSchema = z.object({
  serviceId: id, name: text(120).min(1), description: text(2000).default(''), enabled: z.boolean().default(true), indicatorType: z.enum(['availability', 'errorRate', 'latency']),
  objectiveTarget: z.number().gt(0).lt(100), rollingWindowDays: z.union([z.literal(7), z.literal(28), z.literal(30), z.literal(90)]),
  latencyThresholdMs: z.number().int().positive().max(300000).optional(), percentile: z.union([z.literal(50), z.literal(90), z.literal(95), z.literal(99)]).optional(),
  dataSource: z.object({ type: z.enum(['api', 'webhook', 'synthetic', 'automation']), sourceId: id.transform((value) => value.toLowerCase()).optional() }), missingDataPolicy: z.enum(['unknown', 'bad', 'skip']),
  burnRateAlerts: z.array(z.object({ shortWindowMinutes: z.number().int().min(5).max(1440), longWindowMinutes: z.number().int().min(60).max(10080), threshold: z.number().positive().max(100), recoveryThreshold: z.number().nonnegative().max(100).optional(), escalationPolicyId: id.optional() }).refine((v) => v.shortWindowMinutes < v.longWindowMinutes, 'Short window must be shorter than long window')).max(5),
}).superRefine((value, context) => {
  if (value.dataSource.type === 'api' && value.dataSource.sourceId) context.addIssue({ code: 'custom', message: 'API objectives do not accept a source ID' });
  if (value.dataSource.type !== 'api' && !value.dataSource.sourceId) context.addIssue({ code: 'custom', message: 'External sources require a source ID' });
  if (value.indicatorType === 'latency' && (!value.latencyThresholdMs || !value.percentile)) context.addIssue({ code: 'custom', message: 'Latency threshold and percentile required' });
  if (value.indicatorType !== 'latency' && (value.latencyThresholdMs || value.percentile)) context.addIssue({ code: 'custom', message: 'Latency fields apply only to latency objectives' });
});
export const sliSampleSchema = z.object({
  serviceId: id, sloId: id, timestamp: z.string().datetime(), good: z.number().int().min(0).max(1_000_000_000).optional(), total: z.number().int().min(0).max(1_000_000_000).optional(),
  latencyMs: z.array(z.number().min(0).max(300000)).max(1000).optional(), idempotencyKey: z.string().regex(/^[a-zA-Z0-9_.:-]{8,128}$/),
  metadata: z.record(z.string().regex(/^[a-zA-Z0-9_.-]{1,40}$/), text(100)).refine((x) => Object.keys(x).length <= 20),
}).superRefine((x, context) => { if ((x.good === undefined) !== (x.total === undefined)) context.addIssue({ code: 'custom', message: 'Good and total counts must be supplied together' }); if (x.good !== undefined && x.total !== undefined && x.good > x.total) context.addIssue({ code: 'custom', message: 'Good events cannot exceed total events' }); if (x.good === undefined && !x.latencyMs?.length) context.addIssue({ code: 'custom', message: 'Counts or latency observations required' }); });
export const sliBatchSchema = z.object({ samples: z.array(sliSampleSchema).min(1).max(100) });
export const signedSliBatchSchema = sliBatchSchema.extend({ schemaVersion: z.literal(1), eventType: z.literal('sli.received') });
export const reliabilityMetricsQuerySchema = z.object({ from: z.string().datetime().optional(), to: z.string().datetime().optional() }).refine((q) => !q.from || !q.to || (q.from <= q.to && Date.parse(q.to) - Date.parse(q.from) <= 90 * 86400_000), 'Metrics range must be at most 90 days');
export const monitorInputSchema = z.object({
  serviceId: id, sloId: id.optional().nullable(), name: text(120).min(1), enabled: z.boolean().default(false), url: z.string().url().max(500), method: z.enum(['GET', 'HEAD']),
  intervalSeconds: z.number().int().min(60).max(86400), timeoutMs: z.number().int().min(500).max(10000), maxRedirects: z.number().int().min(0).max(3),
  expectedStatusMin: z.number().int().min(100).max(599), expectedStatusMax: z.number().int().min(100).max(599), textAssertion: text(200).optional(),
  secretHeaders: z.record(z.string().regex(/^(authorization|x-[a-z0-9-]+)$/i), text(500)).refine((x) => Object.keys(x).length <= 10).optional(),
}).refine((x) => x.expectedStatusMin <= x.expectedStatusMax, { message: 'Invalid expected status range' });
export const reliabilityQuerySchema = z.object({ page: z.coerce.number().int().min(1).max(10000).default(1), limit: z.coerce.number().int().min(1).max(100).default(20) });
export type ServiceInput = z.infer<typeof serviceInputSchema>;
export type SloInput = z.infer<typeof sloInputSchema>;

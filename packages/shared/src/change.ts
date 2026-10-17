import { z } from 'zod';

const id = z.string().regex(/^[a-f\d]{24}$/i);
const boundedText = (maximum: number) => z.string().trim().max(maximum);
export const environmentTierSchema = z.enum(['development', 'staging', 'production']);
export const releaseStateSchema = z.enum(['planned', 'ready', 'deploying', 'completed', 'failed', 'cancelled', 'rolled_back']);
export const approvalStateSchema = z.enum(['pending', 'approved', 'rejected', 'expired', 'cancelled', 'superseded']);
export const changeHealthSchema = z.enum(['healthy', 'degraded', 'failed', 'unknown']);
export const correlationStateSchema = z.enum(['candidate', 'confirmed', 'rejected', 'expired', 'stale']);

export const environmentInputSchema = z.object({
  name: boundedText(100).min(2), slug: z.string().trim().toLowerCase().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(80),
  tier: environmentTierSchema, description: boundedText(500).default(''), serviceIds: z.array(id).max(100).default([]),
});
export const environmentUpdateSchema = environmentInputSchema.partial().refine((value) => Object.keys(value).length > 0, 'At least one field is required');
export const releaseInputSchema = z.object({
  projectId: id.optional(), serviceIds: z.array(id).min(1).max(100), environmentId: id,
  version: boundedText(100).min(1), source: z.enum(['manual', 'api', 'signed']), sourceRevision: boundedText(160).min(1),
  externalId: boundedText(160).min(1), idempotencyKey: boundedText(160).min(8), title: boundedText(200).min(1),
  metadata: z.record(z.string().max(50), z.union([z.string().max(500), z.number().finite(), z.boolean(), z.null()])).refine((value) => Object.keys(value).length <= 30),
  emergency: z.boolean().default(false), rollbackPlanRef: boundedText(300).optional(), plannedAt: z.string().datetime().optional(),
});
export const deploymentEventSchema = z.object({
  workspaceId: id, eventId: z.string().uuid(), releaseExternalId: boundedText(160).min(1), sequence: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  state: releaseStateSchema, occurredAt: z.string().datetime(), sourceRevision: boundedText(160).min(1),
});
export const deploymentTransitionSchema = z.object({ operationId: z.string().uuid(), sequence: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER), state: releaseStateSchema, occurredAt: z.string().datetime(), sourceRevision: boundedText(160).min(1) });
const timezoneSchema = boundedText(80).min(1).refine((timezone) => { try { new Intl.DateTimeFormat('en-US', { timeZone: timezone }); return true; } catch { return false; } }, 'Invalid IANA timezone');
export const changePolicyInputSchema = z.object({
  name: boundedText(100).min(2), timezone: timezoneSchema, requiredApprovals: z.number().int().min(0).max(10),
  eligibleRoles: z.array(z.enum(['owner', 'admin', 'member'])).min(1).max(3), separationOfDuty: z.boolean(), riskApprovalThreshold: z.number().int().min(0).max(100),
  emergencyAllowed: z.boolean(), requireRollbackPlan: z.boolean(), preHealthRequired: z.boolean(), postHealthRequired: z.boolean(),
  notificationThreshold: z.number().int().min(0).max(100), retentionDays: z.number().int().min(30).max(730), queueLimit: z.number().int().min(10).max(1000),
  windows: z.array(z.object({ weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7), startsMinute: z.number().int().min(0).max(1439), endsMinute: z.number().int().min(0).max(1439), freeze: z.boolean() })).max(20),
});
export const changePolicyCreateSchema = changePolicyInputSchema.extend({ expectedActiveVersion: z.number().int().min(0) });
export const changePolicyActivationSchema = z.object({ expectedActiveVersion: z.number().int().min(0), operationId: z.string().uuid() });
export const approvalDecisionSchema = z.object({ operationId: z.string().uuid(), decision: z.enum(['approved', 'rejected']), reason: boundedText(500).optional() });
export const changeOperationSchema = z.object({ operationId: z.string().uuid() });
export const correlationDecisionSchema = z.object({ operationId: z.string().uuid(), state: z.enum(['confirmed', 'rejected']) });
export const changeListQuerySchema = z.object({ limit: z.coerce.number().int().min(1).max(100).default(25), cursor: id.optional(), state: releaseStateSchema.optional(), environmentId: id.optional(), serviceId: id.optional() });
export const changeMetricsQuerySchema = z.object({ from: z.string().datetime(), to: z.string().datetime() }).refine((v) => new Date(v.to) > new Date(v.from) && new Date(v.to).getTime() - new Date(v.from).getTime() <= 366 * 86400_000, 'Range must be between one millisecond and 366 days');
export const changeRealtimeEvents = ['change.releaseCreated', 'change.deploymentUpdated', 'change.riskEvaluated', 'change.approvalRequested', 'change.approvalUpdated', 'change.healthUpdated', 'change.correlationUpdated', 'change.policyActivated', 'change.queueChanged'] as const;

export type ChangePolicyInput = z.infer<typeof changePolicyInputSchema>;
export type DeploymentEvent = z.infer<typeof deploymentEventSchema>;

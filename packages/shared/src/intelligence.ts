import { z } from 'zod';

export const intelligenceSignalTypes = ['task.overdue', 'task.blocked', 'incident.highSeverity', 'alert.unacknowledged', 'alert.escalating', 'slo.breached', 'slo.budgetDepleted', 'monitor.repeatedFailure', 'automation.deadLetter', 'monitor.deadLetter', 'oncall.coverageGap', 'maintenance.upcoming', 'maintenance.overdue', 'service.ownerlessCritical'] as const;
export const intelligenceSignalTypeSchema = z.enum(intelligenceSignalTypes);
export const intelligenceStateSchema = z.enum(['active', 'resolved', 'stale']);
export const intelligenceBandSchema = z.enum(['low', 'medium', 'high', 'critical', 'unknown']);
export const recommendationStateSchema = z.enum(['open', 'accepted', 'dismissed', 'snoozed', 'completed', 'stale']);
export const recommendationTypeSchema = z.enum(['reviewAlert', 'joinIncident', 'assignIncidentCommander', 'reviewSlo', 'investigateMonitor', 'retryDeadLetter', 'assignServiceOwner', 'reviewTask', 'linkService', 'reviewCoverageGap', 'reviewMaintenance']);
const mongoId = z.string().regex(/^[a-f\d]{24}$/i);
export const factorWeightsSchema = z.object({ severity: z.number().int().min(0).max(30), urgency: z.number().int().min(0).max(25), criticality: z.number().int().min(0).max(20), impact: z.number().int().min(0).max(15), confidence: z.number().int().min(0).max(10) }).refine((v) => Object.values(v).reduce((s, n) => s + n, 0) === 100, 'Weights must total 100');
export const intelligencePolicyInputSchema = z.object({
  name: z.string().trim().min(2).max(100), weights: factorWeightsSchema,
  thresholds: z.object({ now: z.number().int().min(1).max(100), soon: z.number().int().min(0).max(99) }).refine((v) => v.now > v.soon, 'Now must exceed soon'),
  includedSignalTypes: z.array(intelligenceSignalTypeSchema).min(1).max(intelligenceSignalTypes.length),
  criticality: z.object({ tier1: z.number().min(0).max(1), tier2: z.number().min(0).max(1), tier3: z.number().min(0).max(1), tier4: z.number().min(0).max(1) }),
  ageBandsHours: z.array(z.number().int().min(1).max(8760)).min(1).max(8), notificationThreshold: z.number().int().min(0).max(100),
  digest: z.enum(['immediate', 'hourly', 'daily', 'off']), quietHours: z.object({ startsMinute: z.number().int().min(0).max(1439), endsMinute: z.number().int().min(0).max(1439), timezone: z.string().min(1).max(80) }).nullable(), maximumActiveRecommendations: z.number().int().min(1).max(500),
});
export const policyCreateSchema = intelligencePolicyInputSchema.extend({ expectedActiveVersion: z.number().int().min(0) });
export const policyActivationSchema = z.object({ expectedActiveVersion: z.number().int().min(0), operationId: z.string().uuid() });
export const intelligenceQueueQuerySchema = z.object({ page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(100).default(20), group: z.enum(['now', 'soon', 'watch']).optional(), type: intelligenceSignalTypeSchema.optional(), serviceId: mongoId.optional(), projectId: mongoId.optional(), search: z.string().trim().max(80).optional() });
export const intelligenceMetricsQuerySchema = z.object({ from: z.string().datetime().optional(), to: z.string().datetime().optional() });
export const recommendationFeedbackSchema = z.object({ operationId: z.string().uuid(), reason: z.string().trim().max(300).optional(), snoozeUntil: z.string().datetime().optional() });
export const intelligenceRetrySchema = z.object({ operationId: z.string().uuid() });
export type IntelligencePolicyInput = z.infer<typeof intelligencePolicyInputSchema>;
export type IntelligenceSignalType = z.infer<typeof intelligenceSignalTypeSchema>;

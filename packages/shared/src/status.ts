import { z } from 'zod';

export const statusComponentStateSchema = z.enum([
  'operational',
  'degradedPerformance',
  'partialOutage',
  'majorOutage',
  'maintenance',
]);
export const publicIncidentStateSchema = z.enum([
  'investigating',
  'identified',
  'monitoring',
  'resolved',
]);
export const statusVisibilitySchema = z.enum(['public', 'unlisted', 'private-preview']);
export const statusIdSchema = z.string().regex(/^[a-f\d]{24}$/i);
export const publicSlugSchema = z
  .string()
  .trim()
  .min(3)
  .max(63)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const text = (maximum: number) => z.string().trim().max(maximum);
const safeHttpUrl = z
  .string()
  .url()
  .max(500)
  .refine((value) => ['http:', 'https:'].includes(new URL(value).protocol), 'HTTP(S) URL required');
export const brandingSchema = z.object({
  logoUrl: safeHttpUrl.optional().nullable(),
  primaryColor: z
    .string()
    .regex(/^#[0-9a-f]{6}$/i)
    .default('#d7674d'),
});
export const statusPageInputSchema = z.object({
  name: text(100).min(2),
  slug: publicSlugSchema,
  description: text(2000).default(''),
  visibility: statusVisibilitySchema.default('public'),
  enabled: z.boolean().default(true),
  timezone: text(100).default('UTC'),
  branding: brandingSchema.default({ primaryColor: '#d7674d' }),
  supportUrl: safeHttpUrl.optional().nullable(),
});
export const statusGroupInputSchema = z.object({
  name: text(100).min(1),
  description: text(500).default(''),
  slug: publicSlugSchema,
  order: z.number().int().min(0).max(10000),
  enabled: z.boolean().default(true),
});
export const statusComponentInputSchema = z.object({
  name: text(100).min(1),
  description: text(500).default(''),
  slug: publicSlugSchema,
  order: z.number().int().min(0).max(10000),
  groupId: statusIdSchema.optional().nullable(),
  status: statusComponentStateSchema.default('operational'),
  enabled: z.boolean().default(true),
  hidden: z.boolean().default(false),
});
export const publicIncidentInputSchema = z.object({
  internalIncidentId: statusIdSchema.optional().nullable(),
  publicTitle: text(200).min(1),
  publicSummary: text(4000).min(1),
  publicImpact: text(2000).min(1),
  impact: z.enum(['minor', 'major', 'critical']),
  status: publicIncidentStateSchema.default('investigating'),
  affectedComponentIds: z.array(statusIdSchema).max(100).default([]),
  message: text(4000).min(1),
});
export const publicUpdateInputSchema = z.object({
  status: publicIncidentStateSchema,
  message: text(4000).min(1),
});
export const publicCorrectionInputSchema = publicUpdateInputSchema.extend({
  correctionOf: statusIdSchema,
});
export const maintenanceInputSchema = z
  .object({
    title: text(200).min(1),
    description: text(4000).min(1),
    affectedComponentIds: z.array(statusIdSchema).min(1).max(100),
    scheduledStartAt: z.string().datetime(),
    scheduledEndAt: z.string().datetime(),
    reminderMinutes: z.array(z.number().int().min(0).max(10080)).max(10).default([]),
  })
  .refine((value) => Date.parse(value.scheduledEndAt) > Date.parse(value.scheduledStartAt), {
    message: 'Maintenance end must follow start',
  });
export const maintenanceUpdateSchema = z.object({
  title: text(200).min(1).optional(),
  description: text(4000).min(1).optional(),
  affectedComponentIds: z.array(statusIdSchema).min(1).max(100).optional(),
  scheduledStartAt: z.string().datetime().optional(),
  scheduledEndAt: z.string().datetime().optional(),
  reminderMinutes: z.array(z.number().int().min(0).max(10080)).max(10).optional(),
});
export const subscriptionInputSchema = z.object({
  channel: z.enum(['email', 'webhook']),
  address: z.string().trim().min(3).max(500),
  componentIds: z.array(z.string().uuid()).max(100).default([]),
  incidents: z.boolean().default(true),
  maintenance: z.boolean().default(true),
  locale: text(20).optional(),
  timezone: text(100).optional(),
}).superRefine((value, context) => {
  const valid = value.channel === 'email'
    ? z.string().email().safeParse(value.address).success
    : safeHttpUrl.safeParse(value.address).success;
  if (!valid) context.addIssue({ code: 'custom', path: ['address'], message: 'Invalid channel address' });
});
export const statusHistoryQuerySchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type StatusComponentState = z.infer<typeof statusComponentStateSchema>;
export type StatusPageInput = z.infer<typeof statusPageInputSchema>;
export const statusSeverity: Record<StatusComponentState, number> = {
  operational: 0,
  maintenance: 1,
  degradedPerformance: 2,
  partialOutage: 3,
  majorOutage: 4,
};

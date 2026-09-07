import { z } from 'zod';

export const appName = 'Flowryn';
export const appDescription = 'Intelligent Work Orchestration';

export const healthResponseSchema = z.object({
  status: z.literal('ok'),
  service: z.literal('flowryn-api'),
  timestamp: z.string().datetime(),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;
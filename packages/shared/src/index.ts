import { z } from 'zod';

export const appName = 'Flowryn';
export const appDescription = 'Intelligent Work Orchestration';

export const healthResponseSchema = z.object({
  status: z.literal('ok'),
  service: z.literal('flowryn-api'),
  timestamp: z.string().datetime(),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;

export const userStatusSchema = z.enum(['active', 'suspended']);
export const workspaceRoleSchema = z.enum(['owner', 'admin', 'member']);

export const userSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string().email(),
  status: userStatusSchema,
});

export const authResponseSchema = z.object({ user: userSchema });

export const registerRequestSchema = z.object({
  name: z.string().trim().min(2).max(80),
  email: z.string().trim().email().transform((value) => value.toLowerCase()),
  password: z.string().min(8).max(128),
});

export const loginRequestSchema = z.object({
  email: z.string().trim().email().transform((value) => value.toLowerCase()),
  password: z.string().min(1).max(128),
});

export const createWorkspaceRequestSchema = z.object({
  name: z.string().trim().min(2).max(80),
});

export const addWorkspaceMemberRequestSchema = z.object({
  email: z.string().trim().email().transform((value) => value.toLowerCase()),
  role: workspaceRoleSchema.exclude(['owner']),
});

export type User = z.infer<typeof userSchema>;
export type AuthResponse = z.infer<typeof authResponseSchema>;
export type RegisterRequest = z.infer<typeof registerRequestSchema>;
export type LoginRequest = z.infer<typeof loginRequestSchema>;
export type WorkspaceRole = z.infer<typeof workspaceRoleSchema>;
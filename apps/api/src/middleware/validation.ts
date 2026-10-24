import type { RequestHandler } from 'express';
import type { ZodType } from 'zod/v3';

export const validateBody = <T>(schema: ZodType<T>): RequestHandler => (request, response, next) => {
  const result = schema.safeParse(request.body);
  if (!result.success) {
    response.status(400).json({ error: 'Validation failed', details: result.error.flatten() });
    return;
  }
  request.body = result.data;
  next();
};

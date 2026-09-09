import { z } from 'zod';

const id = z.string().regex(/^[a-f\d]{24}$/i);
export const authorizationChangeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('user'), userId: id }).strict(),
  z.object({ kind: z.literal('membership'), userId: id, workspaceId: id }).strict(),
  z.object({ kind: z.literal('session'), userId: id, tokenId: z.string().uuid() }).strict(),
]);
export type Change = z.infer<typeof authorizationChangeSchema>;
const listeners = new Set<(change: Change) => Promise<void>>();

export const onAuthorizationChange = (listener: (change: Change) => Promise<void>) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

export const authorizationChanged = async (change: Change) => {
  const validated = authorizationChangeSchema.parse(change);
  await Promise.all([...listeners].map((listener) => listener(validated)));
};

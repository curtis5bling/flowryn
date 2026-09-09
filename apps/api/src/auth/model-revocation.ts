import type { Schema } from 'mongoose';

import { authorizationChanged } from './revocation.js';

// Capture affected identities before query mutations, including deletions. Await
// revocation before returning the mutation to its caller.
export const installRevocationHooks = (schema: Schema, kind: 'user' | 'membership') => {
  type Identity = { _id: unknown; userId?: unknown; workspaceId?: unknown };
  const notify = async (document: Identity) => authorizationChanged({
    kind, userId: String(kind === 'user' ? document._id : document.userId),
    workspaceId: kind === 'membership' ? String(document.workspaceId) : undefined,
  });
  const affected = new WeakMap<object, Identity[]>();
  const operations = ['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne', 'findOneAndReplace', 'deleteOne', 'deleteMany', 'findOneAndDelete'] as const;
  for (const operation of operations) {
    schema.pre(operation, { query: true, document: false }, async function () {
      affected.set(this, await this.model.find(this.getFilter()).select('_id userId workspaceId').lean() as Identity[]);
    });
    schema.post(operation, { query: true, document: false }, async function () {
      await Promise.all((affected.get(this) ?? []).map(notify));
      affected.delete(this);
    });
  }
  schema.post('save', async function (document) { await notify(document as Identity); });
  schema.post('deleteOne', { document: true, query: false }, async function () { await notify(this as Identity); });
};

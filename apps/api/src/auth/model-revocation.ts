import type { Schema } from 'mongoose';

import { authorizationChanged } from './revocation.js';

// Capture affected identities before query mutations, including deletions. Await
// revocation before returning the mutation to its caller.
export const installRevocationHooks = (schema: Schema, kind: 'user' | 'membership') => {
  type Identity = { _id: unknown; userId?: unknown; workspaceId?: unknown };
  const notify = async (document: Identity) => {
    // Only the origin resolves whether a mutation revokes access. Receivers must
    // enforce this trusted decision synchronously, without another DB lookup.
    const { model } = await import('mongoose');
    const active = kind === 'user'
      ? await model('User').exists({ _id: document._id, status: 'active' })
      : await model('WorkspaceMember').exists({ userId: document.userId, workspaceId: document.workspaceId, disabled: { $ne: true } });
    if (!active) await authorizationChanged(kind === 'user'
      ? { kind, userId: String(document._id) }
      : { kind, userId: String(document.userId), workspaceId: String(document.workspaceId) });
  };
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

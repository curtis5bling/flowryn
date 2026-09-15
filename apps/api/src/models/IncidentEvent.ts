import { Schema, model } from 'mongoose';

const schema = new Schema(
  {
    workspaceId: { type: Schema.Types.ObjectId, required: true },
    incidentId: { type: Schema.Types.ObjectId, required: true },
    actorId: { type: String, required: true },
    eventType: { type: String, required: true },
    message: { type: String, required: true, maxlength: 4000 },
    previousValue: { type: String, default: null },
    nextValue: { type: String, default: null },
    metadata: { type: Map, of: String, default: {} },
    operationId: { type: String, required: true },
    requestHash: { type: String, required: true, select: false },
    createdAt: { type: Date, default: Date.now, immutable: true },
  },
  { versionKey: false },
);
schema.index({ workspaceId: 1, incidentId: 1, createdAt: 1, _id: 1 });
schema.index({ workspaceId: 1, operationId: 1 }, { unique: true });
for (const operation of [
  'updateOne',
  'updateMany',
  'findOneAndUpdate',
  'replaceOne',
  'findOneAndReplace',
  'deleteOne',
  'deleteMany',
  'findOneAndDelete',
] as const)
  schema.pre(operation, function () {
    throw new Error('Incident timeline is append-only');
  });
schema.pre('deleteOne', { document: true, query: false }, function () {
  throw new Error('Incident timeline is append-only');
});
schema.pre('save', function () {
  if (!this.isNew) throw new Error('Incident timeline is append-only');
});
export const IncidentEventModel = model('IncidentEvent', schema);

import { Schema, model } from 'mongoose';

const step = new Schema(
  {
    id: { type: String, required: true },
    title: { type: String, required: true, maxlength: 200 },
    instructions: { type: String, default: '', maxlength: 4000 },
    position: { type: Number, required: true },
  },
  { _id: false },
);
const schema = new Schema(
  {
    workspaceId: { type: Schema.Types.ObjectId, required: true },
    name: { type: String, required: true, maxlength: 200 },
    description: { type: String, default: '', maxlength: 4000 },
    steps: { type: [step], default: [] },
    ownerId: { type: String, required: true },
    status: { type: String, enum: ['draft', 'active', 'archived'], default: 'draft' },
  },
  { timestamps: true },
);
schema.index({ workspaceId: 1, status: 1, updatedAt: -1 });
export const RunbookModel = model('Runbook', schema);

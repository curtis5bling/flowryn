import { Schema, model } from 'mongoose';

const progressStep = new Schema(
  {
    id: { type: String, required: true },
    title: { type: String, required: true },
    instructions: { type: String, default: '' },
    position: { type: Number, required: true },
    completedAt: { type: Date, default: null },
    completedBy: { type: String, default: null },
  },
  { _id: false },
);
const attachedRunbook = new Schema(
  {
    runbookId: { type: String, required: true },
    name: { type: String, required: true },
    steps: [progressStep],
  },
  { _id: false },
);
const schema = new Schema(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: 'Workspace', required: true },
    incidentNumber: { type: String, required: true },
    title: { type: String, required: true, maxlength: 200 },
    summary: { type: String, default: '', maxlength: 4000 },
    impact: { type: String, default: '', maxlength: 4000 },
    severity: { type: String, enum: ['sev1', 'sev2', 'sev3', 'sev4'], required: true },
    status: {
      type: String,
      enum: ['declared', 'investigating', 'identified', 'monitoring', 'resolved'],
      default: 'declared',
      required: true,
    },
    commanderId: { type: String, default: null },
    responderIds: { type: [String], default: [] },
    linkedProjectIds: { type: [String], default: [] },
    linkedTaskIds: { type: [String], default: [] },
    declaredBy: { type: String, required: true },
    declaredAt: { type: Date, required: true },
    acknowledgedAt: { type: Date, default: null },
    resolvedAt: { type: Date, default: null },
    resolutionSummary: { type: String, default: null, maxlength: 4000 },
    archivedAt: { type: Date, default: null },
    runbooks: { type: [attachedRunbook], default: [] },
  },
  { timestamps: true },
);
schema.index({ workspaceId: 1, incidentNumber: 1 }, { unique: true });
schema.index({ workspaceId: 1, archivedAt: 1, status: 1, severity: 1, declaredAt: -1 });
schema.index({ workspaceId: 1, commanderId: 1, declaredAt: -1 });
schema.index({ workspaceId: 1, responderIds: 1, declaredAt: -1 });
export const IncidentModel = model('Incident', schema);
export const IncidentCounterModel = model(
  'IncidentCounter',
  new Schema({ _id: Schema.Types.ObjectId, value: { type: Number, default: 0 } }),
);

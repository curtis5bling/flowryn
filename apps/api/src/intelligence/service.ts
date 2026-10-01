import { createHash, randomUUID } from 'node:crypto';

import type { IntelligencePolicyInput, IntelligenceSignalType } from '@flowryn/shared';
import mongoose from 'mongoose';

import { AutomationRunModel, OutboxEventModel } from '../automation/models.js';
import { automationActorId } from '../automation/principal.js';
import { IncidentModel } from '../models/Incident.js';
import { TaskModel } from '../models/Task.js';
import { WorkspaceMemberModel } from '../models/WorkspaceMember.js';
import { AlertModel, ScheduleModel } from '../oncall/models.js';
import { publishRealtimeEvent } from '../realtime/gateway.js';
import { ServiceLevelObjectiveModel, ServiceModel, SloEvaluationModel, SyntheticMonitorModel, SyntheticMonitorRunModel } from '../reliability/models.js';
import { MaintenanceModel } from '../status/models.js';

import { IntelligenceCheckpointModel, IntelligenceEvaluationModel, IntelligencePolicyModel, IntelligenceRecommendationModel, IntelligenceScoreSnapshotModel, OperationalSignalModel } from './models.js';

export const defaultPolicy: IntelligencePolicyInput = { name: 'Secure default', weights: { severity: 30, urgency: 25, criticality: 20, impact: 15, confidence: 10 }, thresholds: { now: 70, soon: 40 }, includedSignalTypes: ['task.overdue', 'task.blocked', 'incident.highSeverity', 'alert.unacknowledged', 'alert.escalating', 'slo.breached', 'slo.budgetDepleted', 'monitor.repeatedFailure', 'automation.deadLetter', 'monitor.deadLetter', 'oncall.coverageGap', 'maintenance.upcoming', 'maintenance.overdue', 'service.ownerlessCritical'], criticality: { tier1: 1, tier2: .75, tier3: .45, tier4: .2 }, ageBandsHours: [1, 4, 24, 72], notificationThreshold: 80, digest: 'hourly', quietHours: null, maximumActiveRecommendations: 100 };
export const ensureActivePolicy = async (workspaceId: string, actorId?: string) => {
  const current = await IntelligencePolicyModel.findOne({ workspaceId, active: true }); if (current) return current;
  try { return await IntelligencePolicyModel.create({ workspaceId, version: 1, name: defaultPolicy.name, configuration: defaultPolicy, createdBy: actorId ?? automationActorId, activatedBy: actorId ?? automationActorId, active: true, activatedAt: new Date() }); }
  catch { return IntelligencePolicyModel.findOne({ workspaceId, active: true }).orFail(); }
};
type Classification = 'low' | 'medium' | 'high' | 'critical' | 'unknown';
const levels: Record<Classification, number> = { unknown: .5, low: .2, medium: .5, high: .75, critical: 1 };
export const calculateScore = (input: { severity: Classification; urgency: Classification; criticality?: keyof IntelligencePolicyInput['criticality']; impact: Classification; confidence: Classification }, policy: IntelligencePolicyInput) => {
  const values = { severity: levels[input.severity], urgency: levels[input.urgency], criticality: input.criticality ? policy.criticality[input.criticality] : .5, impact: levels[input.impact], confidence: levels[input.confidence] };
  const factors = (Object.keys(values) as Array<keyof typeof values>).map((key) => ({ key, value: values[key], weight: policy.weights[key], contribution: Math.round(values[key] * policy.weights[key] * 100) / 100, explanation: `${key} contributes ${Math.round(values[key] * policy.weights[key] * 100) / 100} points`, unknown: key === 'criticality' && !input.criticality }));
  const score = Math.max(0, Math.min(100, Math.round(factors.reduce((sum, factor) => sum + factor.contribution, 0))));
  return { score, factors, group: score >= policy.thresholds.now ? 'now' : score >= policy.thresholds.soon ? 'soon' : 'watch', explanation: factors.map((f) => f.explanation).join('; ') } as const;
};

type Candidate = { type: IntelligenceSignalType; id: string; revision: string; severity: Classification; urgency: Classification; impact: Classification; confidence: Classification; criticality?: keyof IntelligencePolicyInput['criticality']; refs?: Record<string, unknown>; assigneeIds?: unknown[]; facts: Record<string, string | number | boolean | null>; recommendation: string; link: string };
const safeDate = (value: unknown) => value instanceof Date ? value.toISOString() : String(value ?? '');
const candidatesFor = async (workspaceId: string, now: Date): Promise<Candidate[]> => {
  const [tasks, incidents, alerts, evaluations, monitors, monitorDead, automationDead, schedules, maintenance, services, activeMembers, activeSlos, activeMonitorIds] = await Promise.all([
    TaskModel.find({ workspaceId, status: { $ne: 'done' }, $or: [{ dueDate: { $lt: now } }, { blocked: true }] }).select('_id projectId assigneeId priority blocked dueDate updatedAt').limit(500).lean(),
    IncidentModel.find({ workspaceId, archivedAt: null, status: { $ne: 'resolved' }, severity: { $in: ['sev1', 'sev2'] } }).select('_id severity commanderId responderIds linkedProjectIds declaredAt acknowledgedAt updatedAt').limit(500).lean(),
    AlertModel.find({ workspaceId, status: 'open' }).select('_id severity serviceId projectId escalationPolicyId createdAt updatedAt').limit(500).lean(),
    SloEvaluationModel.find({ workspaceId, $or: [{ breaching: true }, { remainingBudget: { $lte: 0 } }] }).sort({ windowEnd: -1 }).limit(500).lean(),
    SyntheticMonitorModel.find({ workspaceId, archivedAt: null, enabled: true, failureCount: { $gte: 3 } }).select('_id serviceId failureCount configVersion updatedAt').limit(500).lean(),
    SyntheticMonitorRunModel.find({ workspaceId, status: 'deadLetter' }).select('_id monitorId serviceId configVersion updatedAt').limit(500).lean(),
    Promise.all([OutboxEventModel.find({ workspaceId, status: 'dead' }).select('_id eventType updatedAt').limit(200).lean(), AutomationRunModel.find({ workspaceId, status: { $in: ['failed', 'partiallyFailed'] } }).select('_id updatedAt').limit(200).lean(), IntelligenceEvaluationModel.find({ workspaceId, status: 'dead' }).select('_id sourceType updatedAt').limit(100).lean()]).then(([a,b,c]) => [...a, ...b, ...c]),
    ScheduleModel.find({ workspaceId, archivedAt: null, enabled: true }).select('_id layers version updatedAt').limit(200).lean(),
    MaintenanceModel.find({ workspaceId, status: { $in: ['scheduled', 'inProgress'] }, scheduledStartAt: { $lte: new Date(now.getTime() + 24 * 3600_000) } }).select('_id status scheduledStartAt scheduledEndAt updatedAt').limit(500).lean(),
    ServiceModel.find({ workspaceId, archivedAt: null, criticality: { $in: ['tier1', 'tier2'] } }).select('_id ownerIds projectIds criticality version updatedAt').limit(500).lean(),
    WorkspaceMemberModel.find({ workspaceId, disabled: { $ne: true } }).distinct('userId'),
    ServiceLevelObjectiveModel.find({ workspaceId, archivedAt: null, enabled: true }).select('_id').limit(500).lean(),
    SyntheticMonitorModel.find({ workspaceId, archivedAt: null, enabled: true }).distinct('_id'),
  ]);
  const memberSet = new Set(activeMembers.map(String)); const activeSloSet = new Set(activeSlos.map((item) => String(item._id))); const activeMonitorSet = new Set(activeMonitorIds.map(String)); const result: Candidate[] = [];
  for (const x of tasks) { if (x.dueDate && x.dueDate < now) result.push({ type: 'task.overdue', id: String(x._id), revision: safeDate(x.updatedAt), severity: x.priority === 'urgent' ? 'critical' : x.priority === 'high' ? 'high' : 'medium', urgency: now.getTime() - x.dueDate.getTime() > 86400_000 ? 'high' : 'medium', impact: 'medium', confidence: 'high', refs: { taskId: x._id, projectId: x.projectId }, assigneeIds: x.assigneeId ? [x.assigneeId] : [], facts: { dueAt: safeDate(x.dueDate), priority: x.priority }, recommendation: 'reviewTask', link: `/projects/${x.projectId}?task=${x._id}` }); if (x.blocked) result.push({ type: 'task.blocked', id: String(x._id), revision: safeDate(x.updatedAt), severity: x.priority === 'urgent' ? 'critical' : 'high', urgency: 'high', impact: 'high', confidence: 'high', refs: { taskId: x._id, projectId: x.projectId }, assigneeIds: x.assigneeId ? [x.assigneeId] : [], facts: { priority: x.priority, blocked: true }, recommendation: 'reviewTask', link: `/projects/${x.projectId}?task=${x._id}` }); }
  for (const x of incidents) result.push({ type: 'incident.highSeverity', id: String(x._id), revision: safeDate(x.updatedAt), severity: x.severity === 'sev1' ? 'critical' : 'high', urgency: x.acknowledgedAt ? 'high' : 'critical', impact: 'critical', confidence: 'high', refs: { incidentId: x._id, projectId: x.linkedProjectIds?.[0] }, assigneeIds: [x.commanderId, ...(x.responderIds ?? [])].filter(Boolean), facts: { severity: x.severity, acknowledged: !!x.acknowledgedAt, declaredAt: safeDate(x.declaredAt) }, recommendation: x.commanderId ? 'joinIncident' : 'assignIncidentCommander', link: `/incidents/${x._id}` });
  for (const x of alerts) result.push({ type: x.escalationPolicyId ? 'alert.escalating' : 'alert.unacknowledged', id: String(x._id), revision: safeDate(x.updatedAt), severity: x.severity === 'sev1' ? 'critical' : x.severity === 'sev2' ? 'high' : 'medium', urgency: 'high', impact: 'high', confidence: 'high', refs: { alertId: x._id, ...(mongoose.isValidObjectId(x.serviceId) ? { serviceId: x.serviceId } : {}), projectId: x.projectId }, facts: { severity: x.severity, escalating: !!x.escalationPolicyId }, recommendation: 'reviewAlert', link: `/oncall?alert=${x._id}` });
  const seenSlo = new Set<string>(); for (const x of evaluations) { const key = String(x.sloId); if (!activeSloSet.has(key) || seenSlo.has(key)) continue; seenSlo.add(key); result.push({ type: (x.remainingBudget ?? 1) <= 0 ? 'slo.budgetDepleted' : 'slo.breached', id: key, revision: `${x.sloVersion}:${safeDate(x.windowEnd)}`, severity: (x.remainingBudget ?? 1) <= 0 ? 'critical' : 'high', urgency: 'high', impact: 'high', confidence: (x.total ?? 0) > 0 ? 'high' : 'unknown', refs: { sloId: x.sloId, serviceId: x.serviceId }, facts: { sloVersion: x.sloVersion ?? 0, windowEnd: safeDate(x.windowEnd), remainingBudget: x.remainingBudget ?? null, shortBurnRate: x.shortBurnRate ?? null, longBurnRate: x.longBurnRate ?? null }, recommendation: 'reviewSlo', link: `/reliability?slo=${x.sloId}` }); }
  for (const x of monitors) result.push({ type: 'monitor.repeatedFailure', id: String(x._id), revision: `${x.configVersion}:${safeDate(x.updatedAt)}`, severity: x.failureCount >= 5 ? 'critical' : 'high', urgency: 'high', impact: 'high', confidence: 'high', refs: { serviceId: x.serviceId }, facts: { failureCount: x.failureCount, configVersion: x.configVersion }, recommendation: 'investigateMonitor', link: `/reliability?monitor=${x._id}` });
  for (const x of monitorDead) if (activeMonitorSet.has(String(x.monitorId))) result.push({ type: 'monitor.deadLetter', id: String(x._id), revision: safeDate(x.updatedAt), severity: 'high', urgency: 'high', impact: 'medium', confidence: 'high', refs: { serviceId: x.serviceId }, facts: { configVersion: x.configVersion ?? 0 }, recommendation: 'retryDeadLetter', link: `/reliability?run=${x._id}` });
  for (const x of automationDead) result.push({ type: 'automation.deadLetter', id: String(x._id), revision: safeDate(x.updatedAt), severity: 'high', urgency: 'medium', impact: 'medium', confidence: 'high', facts: {}, recommendation: 'retryDeadLetter', link: `/automation?dead=${x._id}` });
  for (const x of schedules) if (!(x.layers ?? []).length) result.push({ type: 'oncall.coverageGap', id: String(x._id), revision: `${x.version}:${safeDate(x.updatedAt)}`, severity: 'high', urgency: 'high', impact: 'high', confidence: 'high', facts: { configuredLayers: 0 }, recommendation: 'reviewCoverageGap', link: `/oncall?schedule=${x._id}` });
  for (const x of maintenance) { const overdue = x.scheduledEndAt && x.scheduledEndAt < now && x.status !== 'completed'; result.push({ type: overdue ? 'maintenance.overdue' : 'maintenance.upcoming', id: String(x._id), revision: safeDate(x.updatedAt), severity: overdue ? 'high' : 'medium', urgency: overdue ? 'critical' : 'medium', impact: 'medium', confidence: 'high', facts: { status: x.status, scheduledStartAt: safeDate(x.scheduledStartAt), scheduledEndAt: safeDate(x.scheduledEndAt) }, recommendation: 'reviewMaintenance', link: `/status?maintenance=${x._id}` }); }
  for (const x of services) if (!(x.ownerIds ?? []).some((id) => memberSet.has(String(id)))) result.push({ type: 'service.ownerlessCritical', id: String(x._id), revision: `${x.version}:${safeDate(x.updatedAt)}`, severity: x.criticality === 'tier1' ? 'critical' : 'high', urgency: 'high', criticality: x.criticality as 'tier1'|'tier2', impact: 'critical', confidence: 'high', refs: { serviceId: x._id, projectId: x.projectIds?.[0] }, facts: { criticality: x.criticality ?? 'unknown' }, recommendation: 'assignServiceOwner', link: `/reliability?service=${x._id}` });
  return result.slice(0, 2000);
};

const recommendationPermission: Record<string, string> = { assignIncidentCommander: 'incident.command', retryDeadLetter: 'admin', assignServiceOwner: 'admin' };
const reconcileWorkspaceUnlocked = async (workspaceId: string, now = new Date()) => {
  const policyDoc = await ensureActivePolicy(workspaceId); const policy = policyDoc.configuration as IntelligencePolicyInput;
  const candidates = (await candidatesFor(workspaceId, now)).filter((x) => policy.includedSignalTypes.includes(x.type)); const observed = new Set<string>();
  let changed = 0;
  for (const item of candidates) {
    const key = `${item.type}:${item.id}`; observed.add(key); const scored = calculateScore(item, policy); const previous = await OperationalSignalModel.findOne({ workspaceId, deduplicationKey: key }).select('score state sourceRevision policyVersion');
    if (previous?.sourceRevision === item.revision && previous.state === 'active' && previous.policyVersion === policyDoc.version) { await OperationalSignalModel.updateOne({ _id: previous._id }, { $set: { lastObservedAt: now } }); continue; }
    const signal = await OperationalSignalModel.findOneAndUpdate({ workspaceId, deduplicationKey: key }, { $set: { sourceType: item.type, sourceId: item.id, ...item.refs, assigneeIds: item.assigneeIds ?? [], state: 'active', severity: item.severity, urgency: item.urgency, impact: item.impact, confidence: item.confidence, lastObservedAt: now, resolvedAt: null, sourceRevision: item.revision, facts: item.facts, score: scored.score, scoreGroup: scored.group, factors: scored.factors, explanation: scored.explanation, policyVersion: policyDoc.version, expiresAt: new Date(now.getTime() + 400 * 86400_000) }, $setOnInsert: { detectedAt: now }, $inc: { observationVersion: 1 } }, { upsert: true, new: true });
    changed++;
    await IntelligenceScoreSnapshotModel.updateOne({ workspaceId, signalId: signal._id, sourceRevision: item.revision, policyVersion: policyDoc.version }, { $setOnInsert: { score: scored.score, scoreGroup: scored.group, factors: scored.factors, explanation: scored.explanation, evaluatedAt: now, expiresAt: new Date(now.getTime() + 400 * 86400_000) } }, { upsert: true });
    const recommendationKey = `${key}:${item.recommendation}`; const existingRecommendation = await IntelligenceRecommendationModel.findOne({ workspaceId, deduplicationKey: recommendationKey }).select('sourceVersion policyVersion');
    if (!existingRecommendation || existingRecommendation.sourceVersion !== item.revision || existingRecommendation.policyVersion !== policyDoc.version) await IntelligenceRecommendationModel.findOneAndUpdate({ workspaceId, deduplicationKey: recommendationKey }, { $set: { signalId: signal._id, type: item.recommendation, explanation: `Review ${item.type.replaceAll('.', ' ')}`, facts: item.facts, requiredPermission: recommendationPermission[item.recommendation] ?? 'member', preconditions: ['source remains active', 'membership remains active'], deepLink: item.link, state: 'open', policyVersion: policyDoc.version, sourceVersion: item.revision, expiresAt: new Date(now.getTime() + 90 * 86400_000) }, $unset: { acceptedAt: 1, dismissedAt: 1, snoozedUntil: 1, completedAt: 1, staleAt: 1 } }, { upsert: true });
    publishRealtimeEvent({ workspaceId, actorId: automationActorId, entityId: signal.id, type: previous ? previous.score === signal.score ? 'intelligence.signalUpdated' : 'intelligence.priorityChanged' : 'intelligence.signalCreated', payload: {} });
  }
  const active = await OperationalSignalModel.find({ workspaceId, state: 'active' }).select('_id deduplicationKey').limit(2500);
  await IntelligenceRecommendationModel.updateMany({ workspaceId, state: { $in: ['open', 'accepted', 'snoozed'] }, expiresAt: { $lte: now } }, { $set: { state: 'stale', staleAt: now } });
  const resolvedIds = active.filter((x) => !observed.has(x.deduplicationKey)).map((x) => x._id);
  if (resolvedIds.length) { await OperationalSignalModel.updateMany({ _id: { $in: resolvedIds }, state: 'active' }, { $set: { state: 'resolved', resolvedAt: now } }); await IntelligenceRecommendationModel.updateMany({ workspaceId, signalId: { $in: resolvedIds }, state: { $in: ['open', 'accepted', 'snoozed'] } }, { $set: { state: 'stale', staleAt: now } }); for (const id of resolvedIds) publishRealtimeEvent({ workspaceId, actorId: automationActorId, entityId: String(id), type: 'intelligence.signalResolved', payload: {} }); }
  const recommendationOverflow = await IntelligenceRecommendationModel.find({ workspaceId, state: 'open' }).sort({ updatedAt: -1, _id: 1 }).skip(policy.maximumActiveRecommendations).select('_id');
  if (recommendationOverflow.length) await IntelligenceRecommendationModel.updateMany({ _id: { $in: recommendationOverflow.map((item) => item._id) } }, { $set: { state: 'stale', staleAt: now } });
  const overflow = await OperationalSignalModel.find({ workspaceId, state: 'active' }).sort({ score: -1, detectedAt: 1, _id: 1 }).skip(2000).select('_id'); if (overflow.length) await OperationalSignalModel.updateMany({ _id: { $in: overflow.map((x) => x._id) } }, { $set: { state: 'stale', resolvedAt: now } });
  await IntelligenceCheckpointModel.findByIdAndUpdate(`workspace:${workspaceId}`, { $set: { lastRunAt: now } }, { upsert: true });
  if (changed || resolvedIds.length) publishRealtimeEvent({ workspaceId, actorId: automationActorId, type: 'intelligence.queueChanged', payload: {} });
  return { observed: candidates.length, resolved: resolvedIds.length };
};

export const reconcileWorkspace = async (workspaceId: string, now = new Date()) => {
  const key = `workspace:${workspaceId}`; const owner = randomUUID();
  await IntelligenceCheckpointModel.updateOne({ _id: key }, { $setOnInsert: { lastRunAt: new Date(0) } }, { upsert: true });
  const lock = await IntelligenceCheckpointModel.findOneAndUpdate({ _id: key, $or: [{ leaseExpiresAt: null }, { leaseExpiresAt: { $lte: now } }] }, { $set: { leaseOwner: owner, leaseExpiresAt: new Date(now.getTime() + 120_000) } }, { new: true });
  if (!lock) return { observed: 0, resolved: 0, skipped: true };
  try { return await reconcileWorkspaceUnlocked(workspaceId, now); }
  finally { await IntelligenceCheckpointModel.updateOne({ _id: key, leaseOwner: owner }, { $unset: { leaseOwner: 1, leaseExpiresAt: 1 } }); }
};

export const queueEvaluation = async (workspaceId: string, sourceType: string, sourceId: string, sourceRevision: string) => {
  const hash = createHash('sha256').update(`${sourceType}:${sourceId}:${sourceRevision}`).digest('hex');
  return IntelligenceEvaluationModel.findOneAndUpdate({ workspaceId, workKey: hash }, { $setOnInsert: { sourceType, sourceId, sourceRevision, status: 'pending', availableAt: new Date() } }, { upsert: true, new: true });
};
export const processIntelligenceWork = async (now = new Date(), owner = 'intelligence-worker') => {
  const leaseOwner = `${owner}:${randomUUID()}`; const leaseExpiresAt = new Date(now.getTime() + 60_000);
  const job = await IntelligenceEvaluationModel.findOneAndUpdate({ status: { $in: ['pending', 'processing'] }, availableAt: { $lte: now }, $or: [{ leaseExpiresAt: null }, { leaseExpiresAt: { $lte: now } }] }, { $set: { status: 'processing', leaseOwner, leaseExpiresAt }, $inc: { attemptCount: 1 } }, { sort: { availableAt: 1, _id: 1 }, new: true });
  if (!job) { const workspaceIds = (await WorkspaceMemberModel.distinct('workspaceId')).slice(0, 500); if (!workspaceIds.length) return false; const checkpoints = await IntelligenceCheckpointModel.find({ _id: { $in: workspaceIds.map((id) => `workspace:${id}`) } }).select('_id lastRunAt').lean(); const byId = new Map(checkpoints.map((item) => [item._id, item.lastRunAt])); const workspaceId = workspaceIds.map(String).sort().find((id) => !byId.get(`workspace:${id}`) || now.getTime() - byId.get(`workspace:${id}`)!.getTime() >= 300_000); if (!workspaceId) return false; await queueEvaluation(workspaceId, 'reconciliation', workspaceId, now.toISOString().slice(0, 16)); return true; }
  try { await reconcileWorkspace(String(job.workspaceId), now); await IntelligenceEvaluationModel.updateOne({ _id: job._id, leaseOwner }, { $set: { status: 'completed', completedAt: now }, $unset: { leaseOwner: 1, leaseExpiresAt: 1, error: 1 } }); }
  catch { const dead = job.attemptCount >= 5; await IntelligenceEvaluationModel.updateOne({ _id: job._id, leaseOwner }, { $set: { status: dead ? 'dead' : 'pending', availableAt: new Date(now.getTime() + Math.min(300_000, 1000 * 2 ** job.attemptCount)), error: 'EVALUATION_FAILED' }, $unset: { leaseOwner: 1, leaseExpiresAt: 1 } }); }
  return true;
};

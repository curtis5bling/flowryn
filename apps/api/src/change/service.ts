import { createHash, randomUUID } from 'node:crypto';

import type { ChangePolicyInput } from '@flowryn/shared';
import mongoose from 'mongoose';

import { publishAutomationHint } from '../automation/hints.js';
import { automationActorId } from '../automation/principal.js';
import { OperationalSignalModel } from '../intelligence/models.js';
import { IncidentModel } from '../models/Incident.js';
import { ProjectModel } from '../models/Project.js';
import { UserModel } from '../models/User.js';
import { WorkspaceMemberModel } from '../models/WorkspaceMember.js';
import { AlertModel } from '../oncall/models.js';
import { ServiceDependencyModel, ServiceLevelObjectiveModel, ServiceModel, ServiceRelationshipModel, SloEvaluationModel, SyntheticMonitorModel, SyntheticMonitorRunModel } from '../reliability/models.js';

import { ChangeApprovalModel, ChangeCheckpointModel, ChangeCorrelationModel, ChangeDeploymentHistoryModel, ChangeHealthModel, ChangePolicyModel, ChangeReleaseModel, ChangeRiskModel, ChangeWorkModel, DeploymentEnvironmentModel } from './models.js';

export const defaultChangePolicy: ChangePolicyInput = { name: 'Secure defaults', timezone: 'UTC', requiredApprovals: 1, eligibleRoles: ['owner', 'admin'], separationOfDuty: true, riskApprovalThreshold: 30, emergencyAllowed: false, requireRollbackPlan: true, preHealthRequired: true, postHealthRequired: true, notificationThreshold: 70, retentionDays: 365, queueLimit: 500, windows: [] };
export const ensureChangePolicy = async (workspaceId: string, actorId: string) => { try { return await ChangePolicyModel.findOneAndUpdate({ workspaceId, active: true }, { $setOnInsert: { version: 1, name: defaultChangePolicy.name, configuration: defaultChangePolicy, createdBy: actorId, activatedBy: actorId, activatedAt: new Date(), active: true } }, { upsert: true, new: true }); } catch (error) { if ((error as { code?: number }).code !== 11000) throw error; const existing = await ChangePolicyModel.findOne({ workspaceId, active: true }); if (!existing) throw error; return existing; } };
export const activePolicyRequiresPostHealth = async (workspaceId: string, session?: mongoose.ClientSession): Promise<boolean> => { const query = ChangePolicyModel.findOne({ workspaceId, active: true }).select('configuration.postHealthRequired'); if (session) query.session(session); const policy = await query.lean(); return policy?.configuration?.postHealthRequired !== false; };
const bounded = (value: number) => Math.max(0, Math.min(100, Math.round(value)));
const factor = (key: string, value: number, weight: number, unknown: boolean, explanation: string) => { const boundedValue = bounded(value); return { key, value: boundedValue, bound: 100, weight, contribution: bounded(boundedValue * weight / 100), unknown, explanation }; };
const localWindow = (date: Date, timezone: string, windows: ChangePolicyInput['windows']) => { const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date); const weekday = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].indexOf(parts.find((part) => part.type === 'weekday')?.value ?? ''); const minute = Number(parts.find((part) => part.type === 'hour')?.value ?? 0) * 60 + Number(parts.find((part) => part.type === 'minute')?.value ?? 0); return windows.some((window) => { if (!window.freeze) return false; if (window.startsMinute <= window.endsMinute) return window.weekdays.includes(weekday) && minute >= window.startsMinute && minute < window.endsMinute; return (window.weekdays.includes(weekday) && minute >= window.startsMinute) || (window.weekdays.includes((weekday + 6) % 7) && minute < window.endsMinute); }); };

export const changeGovernanceAllows = async (workspaceId: string, release: { _id: unknown; revision: number; rollbackPlanRef?: string | null; emergency?: boolean | null; plannedAt?: Date | null }, targetState: string, _occurredAt: Date, session: mongoose.ClientSession) => {
  if (['cancelled', 'failed', 'rolled_back'].includes(targetState)) return true;
  const policy = await ChangePolicyModel.findOneAndUpdate({ workspaceId, active: true }, { $inc: { __v: 1 } }, { new: true, session }); if (!policy) return false; const configuration = policy.configuration as ChangePolicyInput;
  if ((configuration.requireRollbackPlan && !release.rollbackPlanRef) || (release.emergency && !configuration.emergencyAllowed) || localWindow(new Date(), configuration.timezone, configuration.windows)) return false;
  const risk = await ChangeRiskModel.findOne({ workspaceId, releaseId: release._id, releaseRevision: release.revision, policyVersion: policy.version }).sort({ lastRefreshedAt: -1, evaluatedAt: -1, _id: -1 }).session(session); const riskFreshness = risk?.lastRefreshedAt ?? risk?.evaluatedAt; if (!risk || !riskFreshness || riskFreshness < new Date(Date.now() - 24 * 3600_000)) return false;
  const requiredApprovals = Math.max(configuration.requiredApprovals, (risk.score ?? 0) >= configuration.riskApprovalThreshold ? 1 : 0);
  if (requiredApprovals > 0) { const approval = await ChangeApprovalModel.findOne({ workspaceId, releaseId: release._id, releaseRevision: release.revision, policyVersion: policy.version, riskId: risk._id, state: 'approved', expiresAt: { $gt: new Date() } }).sort({ attempt: -1 }).session(session); if (!approval || (approval.requiredCount ?? 0) < requiredApprovals) return false; const approvedIds=approval.decisions.filter((decision)=>decision.decision==='approved').map((decision)=>decision.actorId); const activeUsers=await UserModel.find({_id:{$in:approvedIds},status:'active'}).select('_id').session(session).lean(); const eligible=await WorkspaceMemberModel.countDocuments({workspaceId,userId:{$in:activeUsers.map((user)=>user._id)},disabled:{$ne:true},role:{$in:configuration.eligibleRoles}}).session(session); if(eligible < requiredApprovals) return false; }
  if (configuration.preHealthRequired && ['deploying', 'completed'].includes(targetState)) { const health = await ChangeHealthModel.findOne({ workspaceId, releaseId: release._id, releaseRevision: release.revision, phase: 'pre' }).sort({ lastRefreshedAt: -1, evaluatedAt: -1 }).session(session); const freshness = health?.lastRefreshedAt ?? health?.evaluatedAt; if (!health || !['healthy', 'degraded'].includes(health.classification ?? '') || !freshness || freshness < new Date(Date.now() - 24 * 3600_000)) return false; }
  return true;
};

export const evaluateChangeRisk = async (workspaceId: string, releaseId: string, now = new Date(), beforePersist?: () => Promise<void>) => {
  const release = await ChangeReleaseModel.findOne({ workspaceId, _id: releaseId }); if (!release) return null;
  const policy = await ensureChangePolicy(workspaceId, String(release.createdBy));
  const services = await ServiceModel.find({ workspaceId, _id: { $in: release.serviceIds }, archivedAt: null }).select('criticality ownerIds').lean();
  const serviceIds = services.map((s) => s._id); const since = new Date(now.getTime() - 7 * 86400_000);
  const incidentRelationships = await ServiceRelationshipModel.find({ workspaceId, serviceId: { $in: serviceIds }, targetType: 'incident', archivedAt: null }).select('targetId').limit(500).lean(); const activeSloConfigs=await ServiceLevelObjectiveModel.find({workspaceId,serviceId:{$in:serviceIds},enabled:true,archivedAt:null}).select('_id version').limit(500).lean(); const activeSloVersions=new Map(activeSloConfigs.map(item=>[String(item._id),item.version]));
  const [environment, dependencies, incidents, alerts, sloEvaluations, failedMonitors, recentFailedDeployments] = await Promise.all([
    DeploymentEnvironmentModel.findOne({ workspaceId, _id: release.environmentId, active: true }).select('tier').lean(),
    ServiceDependencyModel.countDocuments({ workspaceId, enabled: true, archivedAt: null, $or: [{ upstreamServiceId: { $in: serviceIds } }, { downstreamServiceId: { $in: serviceIds } }] }).limit(101),
    IncidentModel.countDocuments({ workspaceId, _id: { $in: incidentRelationships.map((item) => item.targetId) }, status: { $ne: 'resolved' }, archivedAt: null }).limit(101),
    AlertModel.countDocuments({ workspaceId, serviceId: { $in: serviceIds }, status: { $nin: ['resolved'] } }).limit(101),
    SloEvaluationModel.find({ workspaceId, serviceId: { $in: serviceIds }, sloId: { $in: activeSloConfigs.map(item=>item._id) }, windowEnd: { $gte: new Date(now.getTime() - 24 * 3600_000), $lte: now } }).sort({ windowEnd: -1, _id: -1 }).limit(500).lean(),
    SyntheticMonitorRunModel.countDocuments({ workspaceId, serviceId: { $in: serviceIds }, endpointHealthy: false, completedAt: { $gte: since } }).limit(101),
    ChangeReleaseModel.countDocuments({ workspaceId, serviceIds: { $in: serviceIds }, state: { $in: ['failed', 'rolled_back'] }, lastEventAt: { $gte: since }, _id: { $ne: release._id } }).limit(101),
  ]);
  const latestSlos = new Map<string,(typeof sloEvaluations)[number]>(); for (const item of sloEvaluations) { if(activeSloVersions.get(String(item.sloId))!==item.sloVersion) continue; const key=`${item.serviceId}:${item.objectiveKey}`; if (!latestSlos.has(key)) latestSlos.set(key,item); } const slos=[...latestSlos.values()]; const usableSlos=slos.filter(item=>!['unknown','insufficient_data'].includes(item.state??'')&&item.remainingBudget!=null); const sloRisk = usableSlos.length ? Math.max(...usableSlos.map((item)=>item.breaching ? 100 : 100-Number(item.remainingBudget)*100)) : 70;
  const criticality = services.length ? Math.max(...services.map((s) => ({ tier1: 100, tier2: 70, tier3: 40, tier4: 20 }[s.criticality as string] ?? 50))) : 70;
  const configuration = policy.configuration as ChangePolicyInput; const freeze = localWindow(release.plannedAt ?? now, configuration.timezone, configuration.windows);
  const factors = [factor('environment', environment ? ({ development: 20, staging: 50, production: 100 }[environment.tier as string] ?? 70) : 70, 10, !environment, 'Environment tier'), factor('criticality', criticality, 10, !services.length, 'Highest service criticality'), factor('blastRadius', dependencies * 10, 8, false, 'Bounded dependency degree'), factor('activeResponse', (incidents + alerts) * 15, 10, false, 'Active incidents and alerts'), factor('sloBudget', sloRisk, 10, !usableSlos.length, 'Worst latest SLO budget and burn evidence'), factor('monitorFailures', failedMonitors * 10, 8, false, 'Recent failed monitors'), factor('recentFailedDeployments', recentFailedDeployments * 20, 8, false, 'Recent failed deployments'), factor('scope', serviceIds.length * 12, 8, false, 'Affected service count'), factor('freezeWindow', freeze ? 100 : 0, 8, false, 'Configured freeze-window conflict'), factor('ownership', services.some((s) => !s.ownerIds?.length) ? 100 : 0, 5, !services.length, 'Missing ownership'), factor('rollback', release.rollbackPlanRef ? 0 : 100, 5, false, 'Rollback plan availability'), factor('emergency', release.emergency ? 100 : 0, 5, false, 'Emergency change status'), factor('unknownEvidence', [environment, services.length, usableSlos.length].filter(Boolean).length < 3 ? 100 : 0, 5, !environment || !services.length || !usableSlos.length, 'Unknown or incomplete evidence')];
  const score = bounded(factors.reduce((sum, item) => sum + item.contribution, 0)); const band = score >= 75 ? 'critical' : score >= 50 ? 'high' : score >= 25 ? 'medium' : 'low'; const observationKey=stablePayloadHash(factors);
  const evidenceKey = stablePayloadHash({ environment: environment?.tier ?? null, services: services.map((item) => ({ id: String(item._id), criticality: item.criticality, owners: item.ownerIds?.map(String).sort() ?? [] })).sort((a,b) => a.id.localeCompare(b.id)), relationships: incidentRelationships.map((item) => String(item.targetId)).sort(), sloConfigs: activeSloConfigs.map((item) => ({ id: String(item._id), version: item.version })).sort((a,b) => a.id.localeCompare(b.id)), sloEvaluations: sloEvaluations.map((item) => ({ id: String(item._id), version: item.sloVersion, windowEnd: item.windowEnd, state: item.state, breaching: item.breaching, remainingBudget: item.remainingBudget })), dependencies, incidents, alerts, failedMonitors, recentFailedDeployments });
  if (beforePersist) await beforePersist();
  const session = await mongoose.startSession();
  try { return (await session.withTransaction(async () => {
    const currentRelease = await ChangeReleaseModel.findOne({ workspaceId, _id: release._id, revision: release.revision }).session(session); if (!currentRelease) return;
    const currentPolicy = await ChangePolicyModel.findOneAndUpdate({ workspaceId, _id: policy._id, version: policy.version, active: true }, { $inc: { __v: 1 } }, { new: true, session }); if (!currentPolicy) return;
    const currentEnvironment = await DeploymentEnvironmentModel.findOne({ workspaceId, _id: currentRelease.environmentId, active: true }).select('tier').session(session).lean();
    const ids = [...new Set(currentRelease.serviceIds.map(String))]; const currentServices = await ServiceModel.find({ workspaceId, _id: { $in: ids }, archivedAt: null }).select('criticality ownerIds').session(session).lean(); const currentProject = currentRelease.projectId ? await ProjectModel.exists({ workspaceId, _id: currentRelease.projectId, status: 'active' }).session(session) : true; if (!currentEnvironment || !currentProject || currentServices.length !== ids.length) return;
    const currentRelationships = await ServiceRelationshipModel.find({ workspaceId, serviceId: { $in: ids }, targetType: 'incident', archivedAt: null }).select('targetId').limit(500).session(session).lean(); const currentSloConfigs = await ServiceLevelObjectiveModel.find({ workspaceId, serviceId: { $in: ids }, enabled: true, archivedAt: null }).select('_id version').limit(500).session(session).lean();
    const [currentDependencies, currentIncidents, currentAlerts, currentSloEvaluations, currentFailedMonitors, currentRecentFailedDeployments] = await Promise.all([
      ServiceDependencyModel.countDocuments({ workspaceId, enabled: true, archivedAt: null, $or: [{ upstreamServiceId: { $in: ids } }, { downstreamServiceId: { $in: ids } }] }).limit(101).session(session),
      IncidentModel.countDocuments({ workspaceId, _id: { $in: currentRelationships.map((item) => item.targetId) }, status: { $ne: 'resolved' }, archivedAt: null }).limit(101).session(session),
      AlertModel.countDocuments({ workspaceId, serviceId: { $in: ids }, status: { $nin: ['resolved'] } }).limit(101).session(session),
      SloEvaluationModel.find({ workspaceId, serviceId: { $in: ids }, sloId: { $in: currentSloConfigs.map((item) => item._id) }, windowEnd: { $gte: new Date(now.getTime() - 24 * 3600_000), $lte: now } }).sort({ windowEnd: -1, _id: -1 }).limit(500).session(session).lean(),
      SyntheticMonitorRunModel.countDocuments({ workspaceId, serviceId: { $in: ids }, endpointHealthy: false, completedAt: { $gte: since } }).limit(101).session(session),
      ChangeReleaseModel.countDocuments({ workspaceId, serviceIds: { $in: ids }, state: { $in: ['failed', 'rolled_back'] }, lastEventAt: { $gte: since }, _id: { $ne: release._id } }).limit(101).session(session),
    ]);
    const currentEvidenceKey = stablePayloadHash({ environment: currentEnvironment.tier, services: currentServices.map((item) => ({ id: String(item._id), criticality: item.criticality, owners: item.ownerIds?.map(String).sort() ?? [] })).sort((a,b) => a.id.localeCompare(b.id)), relationships: currentRelationships.map((item) => String(item.targetId)).sort(), sloConfigs: currentSloConfigs.map((item) => ({ id: String(item._id), version: item.version })).sort((a,b) => a.id.localeCompare(b.id)), sloEvaluations: currentSloEvaluations.map((item) => ({ id: String(item._id), version: item.sloVersion, windowEnd: item.windowEnd, state: item.state, breaching: item.breaching, remainingBudget: item.remainingBudget })), dependencies: currentDependencies, incidents: currentIncidents, alerts: currentAlerts, failedMonitors: currentFailedMonitors, recentFailedDeployments: currentRecentFailedDeployments });
    if (currentEvidenceKey !== evidenceKey) return;
    return ChangeRiskModel.findOneAndUpdate({ workspaceId, releaseId: release._id, releaseRevision: release.revision, policyVersion: policy.version, observationKey }, { $set: { lastRefreshedAt: now }, $setOnInsert: { score, band, factors, explanation: `Deterministic ${band} risk from ${factors.length} bounded factors`, evaluatedAt: now } }, { upsert: true, new: true, session });
  })) ?? null; } finally { await session.endSession(); }
};

export const evaluateReleaseHealth = async (workspaceId: string, releaseId: string, phase: 'pre'|'post', now = new Date(), beforePersist?: () => Promise<void>) => {
  const release = await ChangeReleaseModel.findOne({ workspaceId, _id: releaseId }); if (!release) return null; const revision = release.revision;
  const freshnessFloor = new Date(now.getTime() - 24 * 3600_000); const evidenceSince = phase === 'post' ? new Date(Math.max((release.completedAt ?? release.lastEventAt ?? freshnessFloor).getTime(), freshnessFloor.getTime())) : freshnessFloor;
  const relationships = await ServiceRelationshipModel.find({ workspaceId, serviceId: { $in: release.serviceIds }, targetType: 'incident', archivedAt: null }).select('targetId').limit(500).lean();
  const [incidents, alerts, allSlos, allMonitors, signals, services] = await Promise.all([IncidentModel.find({ workspaceId, _id: { $in: relationships.map((item) => item.targetId) }, status: { $ne: 'resolved' }, archivedAt: null }).select('_id severity updatedAt').limit(100).lean(), AlertModel.find({ workspaceId, serviceId: { $in: release.serviceIds.map(String) }, status: { $ne: 'resolved' } }).select('_id serviceId severity updatedAt').limit(100).lean(), SloEvaluationModel.find({ workspaceId, serviceId: { $in: release.serviceIds }, windowEnd: { $gte: evidenceSince, $lte: now } }).select('_id serviceId sloId objectiveKey sloVersion windowEnd breaching state').sort({ windowEnd: -1 }).limit(500).lean(), SyntheticMonitorRunModel.find({ workspaceId, serviceId: { $in: release.serviceIds }, status: 'completed', completedAt: { $gte: evidenceSince, $lte: now }, endpointHealthy: { $type: 'bool' } }).select('_id serviceId monitorId configVersion completedAt endpointHealthy').sort({ completedAt: -1 }).limit(500).lean(), OperationalSignalModel.find({ workspaceId, serviceId: { $in: release.serviceIds }, state: 'active' }).select('_id observationVersion').sort({ detectedAt: -1, _id: -1 }).limit(100).lean(), ServiceModel.find({ workspaceId, _id: { $in: release.serviceIds }, archivedAt: null }).select('_id ownerIds version').limit(100).lean()]);
  const [activeSlos,activeMonitors]=await Promise.all([ServiceLevelObjectiveModel.find({workspaceId,_id:{$in:allSlos.map(item=>item.sloId)},enabled:true,archivedAt:null}).select('_id version').lean(),SyntheticMonitorModel.find({workspaceId,_id:{$in:allMonitors.map(item=>item.monitorId)},enabled:true,archivedAt:null}).select('_id configVersion').lean()]); const sloVersions=new Map(activeSlos.map(item=>[String(item._id),item.version])); const monitorVersions=new Map(activeMonitors.map(item=>[String(item._id),item.configVersion])); const latest = <T>(items: T[], key: (item: T) => string) => { const result = new Map<string,T>(); for (const item of items) if (!result.has(key(item))) result.set(key(item), item); return [...result.values()]; }; const slos = latest(allSlos.filter(item=>sloVersions.get(String(item.sloId))===item.sloVersion), (item) => `${item.serviceId}:${item.objectiveKey}`); const monitors = latest(allMonitors.filter(item=>monitorVersions.get(String(item.monitorId))===item.configVersion), (item) => String(item.monitorId));
  const coveredServices = new Set([...slos.filter((item) => item.state !== 'unknown' && item.state !== 'insufficient_data').map((item) => String(item.serviceId)), ...monitors.map((item) => String(item.serviceId))]); const unknown = release.serviceIds.some((id) => !coveredServices.has(String(id))); const evidenceFailed = slos.some((item) => item.breaching) || monitors.some((item) => item.endpointHealthy === false); const failed = ['failed', 'rolled_back'].includes(release.state) || incidents.some((item) => item.severity === 'sev1') || alerts.some((item) => item.severity === 'sev1'); const classification = failed ? 'failed' : unknown ? 'unknown' : incidents.length || alerts.length || evidenceFailed || signals.length ? 'degraded' : 'healthy';
  if (beforePersist) await beforePersist();
  const session = await mongoose.startSession();
  try { return (await session.withTransaction(async () => {
    if (phase === 'post') { const activePolicy = await ChangePolicyModel.findOneAndUpdate({ workspaceId, active: true }, { $inc: { __v: 1 } }, { new: true, session }); if (activePolicy?.configuration.postHealthRequired === false) return; }
    const currentRelease = await ChangeReleaseModel.findOne({ workspaceId, _id: releaseId, revision }).session(session); if (!currentRelease) return;
    const currentEnvironment = await DeploymentEnvironmentModel.findOneAndUpdate({ workspaceId, _id: currentRelease.environmentId, active: true }, { $inc: { __v: 1 } }, { new: true, session });
    const ids = [...new Set(currentRelease.serviceIds.map(String))]; const currentServices = await ServiceModel.updateMany({ workspaceId, _id: { $in: ids }, archivedAt: null }, { $inc: { __v: 1 } }, { session, timestamps: false }); const currentProject = currentRelease.projectId ? await ProjectModel.findOneAndUpdate({ workspaceId, _id: currentRelease.projectId, status: 'active' }, { $inc: { __v: 1 } }, { new: true, session, timestamps: false }) : true; if (!currentEnvironment || !currentProject || currentServices.matchedCount !== ids.length) return;
    const currentRelationships = await ServiceRelationshipModel.find({ workspaceId, serviceId: { $in: currentRelease.serviceIds }, targetType: 'incident', archivedAt: null }).select('targetId').limit(500).session(session).lean();
    const [currentIncidents, currentAlerts, currentSlos, currentMonitors, currentSignals, currentSloConfigs, currentMonitorConfigs, currentAllSlos, currentAllMonitors] = await Promise.all([
      IncidentModel.find({ workspaceId, _id: { $in: currentRelationships.map((item) => item.targetId) }, status: { $ne: 'resolved' }, archivedAt: null }).select('_id updatedAt').limit(100).session(session).lean(), AlertModel.find({ workspaceId, serviceId: { $in: currentRelease.serviceIds }, status: { $ne: 'resolved' } }).select('_id updatedAt').limit(100).session(session).lean(),
      SloEvaluationModel.find({ workspaceId, _id: { $in: slos.map((item) => item._id) } }).select('_id sloId sloVersion windowEnd').session(session).lean(), SyntheticMonitorRunModel.find({ workspaceId, _id: { $in: monitors.map((item) => item._id) }, status: 'completed' }).select('_id monitorId configVersion completedAt endpointHealthy').session(session).lean(),
      OperationalSignalModel.find({ workspaceId, serviceId: { $in: currentRelease.serviceIds }, state: 'active' }).select('_id observationVersion').sort({ detectedAt: -1, _id: -1 }).limit(100).session(session).lean(),
      ServiceLevelObjectiveModel.find({ workspaceId, _id: { $in: slos.map((item) => item.sloId) }, enabled: true, archivedAt: null }).select('_id version').session(session).lean(),
      SyntheticMonitorModel.find({ workspaceId, _id: { $in: monitors.map((item) => item.monitorId) }, enabled: true, archivedAt: null }).select('_id configVersion').session(session).lean(),
      SloEvaluationModel.find({ workspaceId, serviceId: { $in: currentRelease.serviceIds }, windowEnd: { $gte: evidenceSince, $lte: now } }).select('_id').sort({ windowEnd: -1 }).limit(500).session(session).lean(),
      SyntheticMonitorRunModel.find({ workspaceId, serviceId: { $in: currentRelease.serviceIds }, status: 'completed', completedAt: { $gte: evidenceSince, $lte: now }, endpointHealthy: { $type: 'bool' } }).select('_id').sort({ completedAt: -1 }).limit(500).session(session).lean(),
    ]);
    const revisionsMatch = (before: Array<{ _id: unknown; updatedAt?: Date }>, current: Array<{ _id: unknown; updatedAt?: Date }>) => before.length === current.length && before.every((item) => current.some((candidate) => String(candidate._id) === String(item._id) && candidate.updatedAt?.getTime() === item.updatedAt?.getTime()));
    const signalsMatch = signals.length === currentSignals.length && signals.every((item) => currentSignals.some((candidate) => String(candidate._id) === String(item._id) && candidate.observationVersion === item.observationVersion));
    const currentSloVersions = new Map(currentSloConfigs.map((item) => [String(item._id), item.version])); const currentMonitorVersions = new Map(currentMonitorConfigs.map((item) => [String(item._id), item.configVersion]));
    const slosMatch = slos.length === currentSlos.length && slos.every((item) => currentSlos.some((candidate) => String(candidate._id) === String(item._id) && candidate.sloVersion === item.sloVersion && candidate.windowEnd?.getTime() === item.windowEnd?.getTime() && currentSloVersions.get(String(candidate.sloId)) === candidate.sloVersion)); const monitorsMatch = monitors.length === currentMonitors.length && monitors.every((item) => currentMonitors.some((candidate) => String(candidate._id) === String(item._id) && candidate.configVersion === item.configVersion && candidate.completedAt?.getTime() === item.completedAt?.getTime() && candidate.endpointHealthy === item.endpointHealthy && currentMonitorVersions.get(String(candidate.monitorId)) === candidate.configVersion));
    if (!revisionsMatch(incidents, currentIncidents) || !revisionsMatch(alerts, currentAlerts) || currentAllSlos.length !== allSlos.length || currentAllMonitors.length !== allMonitors.length || currentAllSlos.some((item,index) => String(item._id) !== String(allSlos[index]?._id)) || currentAllMonitors.some((item,index) => String(item._id) !== String(allMonitors[index]?._id)) || !slosMatch || !monitorsMatch || !signalsMatch) return;
    const sourceRevisions = { release: revision, incidents: incidents.map((item) => `${item._id}:${item.updatedAt?.toISOString() ?? '1'}`), alerts: alerts.map((item) => `${item._id}:${item.updatedAt?.toISOString() ?? '1'}`), slos: slos.map((item) => `${item._id}:${item.sloVersion}`), monitors: monitors.map((item) => `${item._id}:${item.configVersion}`), services: services.map((service) => `${service._id}:${service.version}`), signals: signals.map((signal) => `${signal._id}:${signal.observationVersion}`) }; const observationKey = stablePayloadHash({ classification, sourceRevisions });
    return ChangeHealthModel.findOneAndUpdate({ workspaceId, releaseId: release._id, releaseRevision: revision, phase, observationKey }, { $set: { lastRefreshedAt: now }, $setOnInsert: { classification, evidence: { incidentCount: incidents.length, alertCount: alerts.length, operationalSignalCount: signals.length, ownerlessServiceCount: services.filter((service) => !service.ownerIds?.length).length, sloEvaluationIds: slos.map((item) => item._id), monitorRunIds: monitors.map((item) => item._id) }, sourceRevisions, evaluatedAt: now } }, { upsert: true, new: true, session });
  })) ?? null; } finally { await session.endSession(); }
};

export const generateChangeCorrelations = async (workspaceId: string, releaseId: string, now = new Date()) => {
  const release = await ChangeReleaseModel.findOne({ workspaceId, _id: releaseId }).lean();
  if (!release || !['completed', 'failed', 'rolled_back'].includes(release.state)) return [];
  const policy = await ensureChangePolicy(workspaceId, String(release.createdBy));
  const windowStart = release.lastEventAt ?? release.completedAt ?? release.createdAt;
  const windowEnd = new Date(Math.min(now.getTime(), windowStart.getTime() + 24 * 3600_000));
  const direct = release.serviceIds.slice(0, 100);
  const edges = await ServiceDependencyModel.find({ workspaceId, enabled: true, archivedAt: null, $or: [{ upstreamServiceId: { $in: direct } }, { downstreamServiceId: { $in: direct } }] }).select('upstreamServiceId downstreamServiceId').limit(500).lean();
  const serviceIds = [...new Set([...direct.map(String), ...edges.flatMap((edge) => [String(edge.upstreamServiceId), String(edge.downstreamServiceId)])])].slice(0, 500);
  const relationships = await ServiceRelationshipModel.find({ workspaceId, serviceId: { $in: serviceIds }, targetType: 'incident', archivedAt: null }).select('targetId').limit(500).lean();
  const incidentIds = relationships.map((item) => item.targetId);
  const [activeSlos, activeMonitors] = await Promise.all([
    ServiceLevelObjectiveModel.find({ workspaceId, serviceId: { $in: serviceIds }, enabled: true, archivedAt: null }).select('_id version').limit(500).lean(),
    SyntheticMonitorModel.find({ workspaceId, serviceId: { $in: serviceIds }, enabled: true, archivedAt: null }).select('_id configVersion').limit(500).lean(),
  ]);
  const activeSloVersions = new Map(activeSlos.map((item) => [String(item._id), item.version]));
  const activeMonitorVersions = new Map(activeMonitors.map((item) => [String(item._id), item.configVersion]));
  const [incidents, alerts, slos, monitors, signals] = await Promise.all([
    IncidentModel.find({ workspaceId, _id: { $in: incidentIds }, declaredAt: { $gte: windowStart, $lte: windowEnd }, archivedAt: null }).select('_id severity updatedAt').limit(100).lean(),
    AlertModel.find({ workspaceId, serviceId: { $in: serviceIds }, firstReceivedAt: { $gte: windowStart, $lte: windowEnd } }).select('_id severity updatedAt').limit(100).lean(),
    SloEvaluationModel.find({ workspaceId, serviceId: { $in: serviceIds }, sloId: { $in: activeSlos.map((item) => item._id) }, breaching: true, windowEnd: { $gte: windowStart, $lte: windowEnd } }).select('_id sloId sloVersion windowEnd').limit(100).lean(),
    SyntheticMonitorRunModel.find({ workspaceId, serviceId: { $in: serviceIds }, monitorId: { $in: activeMonitors.map((item) => item._id) }, endpointHealthy: false, completedAt: { $gte: windowStart, $lte: windowEnd } }).select('_id monitorId configVersion completedAt').limit(100).lean(),
    OperationalSignalModel.find({ workspaceId, serviceId: { $in: serviceIds }, detectedAt: { $gte: windowStart, $lte: windowEnd } }).select('_id observationVersion detectedAt').limit(100).lean(),
  ]);
  const sources = [
    ...incidents.map((item) => ({ type: 'incident', id: item._id, revision: item.updatedAt?.toISOString() ?? '1', observedAt: item.updatedAt })),
    ...alerts.map((item) => ({ type: 'alert', id: item._id, revision: item.updatedAt?.toISOString() ?? '1', observedAt: item.updatedAt })),
    ...slos.filter((item) => activeSloVersions.get(String(item.sloId)) === item.sloVersion).map((item) => ({ type: 'slo', id: item._id, revision: String(item.sloVersion), observedAt: item.windowEnd })),
    ...monitors.filter((item) => activeMonitorVersions.get(String(item.monitorId)) === item.configVersion).map((item) => ({ type: 'monitor', id: item._id, revision: String(item.configVersion), observedAt: item.completedAt })),
    ...signals.map((item) => ({ type: 'intelligence', id: item._id, revision: String(item.observationVersion), observedAt: item.detectedAt })),
  ].slice(0, 300);
  const session = await mongoose.startSession();
  try { await session.withTransaction(async () => {
    const currentRelease = await ChangeReleaseModel.findOne({ workspaceId, _id: release._id, revision: release.revision, state: release.state }).session(session); if (!currentRelease) return;
    const currentPolicy = await ChangePolicyModel.findOneAndUpdate({ workspaceId, _id: policy._id, version: policy.version, active: true }, { $inc: { __v: 1 } }, { new: true, session }); if (!currentPolicy) return;
    const currentEnvironment = await DeploymentEnvironmentModel.findOneAndUpdate({ workspaceId, _id: currentRelease.environmentId, active: true }, { $inc: { __v: 1 } }, { new: true, session });
    const ids = [...new Set(currentRelease.serviceIds.map(String))]; const currentServices = await ServiceModel.updateMany({ workspaceId, _id: { $in: ids }, archivedAt: null }, { $inc: { __v: 1 } }, { session, timestamps: false }); const currentProject = currentRelease.projectId ? await ProjectModel.findOneAndUpdate({ workspaceId, _id: currentRelease.projectId, status: 'active' }, { $inc: { __v: 1 } }, { new: true, session, timestamps: false }) : true; if (!currentEnvironment || !currentProject || currentServices.matchedCount !== ids.length) return;
    const byType = (type: string) => sources.filter((source) => source.type === type).map((source) => source.id);
    const [currentIncidents, currentAlerts, currentSlos, currentMonitors, currentSignals] = await Promise.all([
      IncidentModel.find({ workspaceId, _id: { $in: byType('incident') }, archivedAt: null, status: { $ne: 'resolved' } }).select('_id updatedAt').session(session).lean(),
      AlertModel.find({ workspaceId, _id: { $in: byType('alert') }, status: { $ne: 'resolved' } }).select('_id updatedAt').session(session).lean(),
      SloEvaluationModel.find({ workspaceId, _id: { $in: byType('slo') }, breaching: true }).select('_id sloVersion').session(session).lean(),
      SyntheticMonitorRunModel.find({ workspaceId, _id: { $in: byType('monitor') }, endpointHealthy: false }).select('_id configVersion').session(session).lean(),
      OperationalSignalModel.find({ workspaceId, _id: { $in: byType('intelligence') }, state: 'active' }).select('_id observationVersion').session(session).lean(),
    ]);
    const revisions = new Map<string, string>([
      ...currentIncidents.map((item) => [`incident:${item._id}`, item.updatedAt?.toISOString() ?? '1'] as const), ...currentAlerts.map((item) => [`alert:${item._id}`, item.updatedAt?.toISOString() ?? '1'] as const),
      ...currentSlos.map((item) => [`slo:${item._id}`, String(item.sloVersion)] as const), ...currentMonitors.map((item) => [`monitor:${item._id}`, String(item.configVersion)] as const), ...currentSignals.map((item) => [`intelligence:${item._id}`, String(item.observationVersion)] as const),
    ]);
    const validSources = sources.filter((source) => revisions.get(`${source.type}:${source.id}`) === source.revision);
    await Promise.all(validSources.map(async (source) => { const identity = { workspaceId, releaseId: release._id, releaseRevision: release.revision, sourceType: source.type, sourceId: String(source.id) }; const values = { deploymentRevision: release.sequence, policyVersion: policy.version, sourceRevision: source.revision, confidence: direct.length === serviceIds.length ? 'medium' : 'low', evidence: { relationship: direct.length === serviceIds.length ? 'sameService' : 'boundedDependency', windowStart, windowEnd, observedAt: source.observedAt }, expiresAt: new Date(windowEnd.getTime() + 30 * 86400_000) }; const refreshed = await ChangeCorrelationModel.findOneAndUpdate({ ...identity, state: { $in: ['candidate', 'stale'] } }, { $set: { ...values, state: 'candidate' } }, { new: true, session }); if (!refreshed) await ChangeCorrelationModel.findOneAndUpdate(identity, { $setOnInsert: { ...values, state: 'candidate' } }, { upsert: true, new: true, session }); }));
    await ChangeCorrelationModel.updateMany({ workspaceId, releaseId: release._id, releaseRevision: release.revision, state: 'candidate', sourceId: { $nin: validSources.map((source) => String(source.id)) } }, { $set: { state: 'stale' } }, { session });
  }); } finally { await session.endSession(); }
  return ChangeCorrelationModel.find({ workspaceId, releaseId: release._id }).sort({ createdAt: 1, _id: 1 }).limit(300).lean();
};

export const correlationSourceIsCurrent = async (correlation: { workspaceId: unknown; releaseId: unknown; releaseRevision?: number | null; sourceType?: string | null; sourceId?: string | null; sourceRevision?: string | null; expiresAt?: Date | null }, session: mongoose.ClientSession, now = new Date()) => {
  if (correlation.releaseRevision == null || !correlation.sourceType || !correlation.sourceId || !correlation.sourceRevision) return false;
  if (correlation.expiresAt && correlation.expiresAt <= now) return false;
  const workspaceId = correlation.workspaceId; const release = await ChangeReleaseModel.exists({ workspaceId, _id: correlation.releaseId, revision: correlation.releaseRevision }).session(session);
  if (!release) return false;
  if (correlation.sourceType === 'incident') { const source = await IncidentModel.findOne({ workspaceId, _id: correlation.sourceId, archivedAt: null, status: { $ne: 'resolved' } }).select('updatedAt').session(session).lean(); return source?.updatedAt?.toISOString() === correlation.sourceRevision; }
  if (correlation.sourceType === 'alert') { const source = await AlertModel.findOne({ workspaceId, _id: correlation.sourceId, status: { $ne: 'resolved' } }).select('updatedAt').session(session).lean(); return source?.updatedAt?.toISOString() === correlation.sourceRevision; }
  if (correlation.sourceType === 'slo') { const source=await SloEvaluationModel.findOne({workspaceId,_id:correlation.sourceId,sloVersion:Number(correlation.sourceRevision),breaching:true}).select('sloId sloVersion').session(session).lean(); return Boolean(source&&await ServiceLevelObjectiveModel.exists({workspaceId,_id:source.sloId,version:source.sloVersion,enabled:true,archivedAt:null}).session(session)); }
  if (correlation.sourceType === 'monitor') { const source=await SyntheticMonitorRunModel.findOne({workspaceId,_id:correlation.sourceId,configVersion:Number(correlation.sourceRevision),endpointHealthy:false}).select('monitorId configVersion').session(session).lean(); return Boolean(source&&await SyntheticMonitorModel.exists({workspaceId,_id:source.monitorId,configVersion:source.configVersion,enabled:true,archivedAt:null}).session(session)); }
  if (correlation.sourceType === 'intelligence') return Boolean(await OperationalSignalModel.exists({ workspaceId, _id: correlation.sourceId, observationVersion: Number(correlation.sourceRevision), state: 'active' }).session(session));
  return false;
};

export const enqueueChangeWork = async (workspaceId: string, kind: string, entityId: unknown, sourceRevision: string, refresh = false) => { const operationKey = `${kind}:${entityId}:${sourceRevision}`; const session=await mongoose.startSession(); try { return await session.withTransaction(async()=>{ const existing=await ChangeWorkModel.findOne({workspaceId,operationKey}).session(session); if(existing&&!(refresh&&existing.status==='completed'))return existing; const policy=await ChangePolicyModel.findOneAndUpdate({workspaceId,active:true},{$inc:{__v:1}},{new:true,session}); const limit=Math.max(1,policy?.configuration.queueLimit??defaultChangePolicy.queueLimit); const queued=await ChangeWorkModel.countDocuments({workspaceId,status:{$in:['pending','processing']}}).session(session); if(queued>=limit)return null; if(existing){existing.status='pending';existing.availableAt=new Date();existing.attemptCount=0;existing.completedAt=undefined;existing.error=undefined;existing.leaseOwner=undefined;existing.leaseExpiresAt=undefined;await existing.save({session});return existing;} const [created]=await ChangeWorkModel.create([{workspaceId,operationKey,kind,entityId,sourceRevision,status:'pending',availableAt:new Date()}],{session}); return created;}); } finally {await session.endSession();} };
export const expireChangeApprovals = async (now = new Date()) => {
  const expired = await ChangeApprovalModel.find({ state: 'pending', expiresAt: { $lte: now } }).select('_id').sort({ expiresAt: 1, _id: 1 }).limit(100).lean();
  if (!expired.length) return 0;
  const result = await ChangeApprovalModel.updateMany({ _id: { $in: expired.map((item) => item._id) }, state: 'pending', expiresAt: { $lte: now } }, { $set: { state: 'expired' } });
  return result.modifiedCount;
};
export const changeSourceCurrent = async (workspaceId: string, releaseId: string, revision: string) => { const release = await ChangeReleaseModel.findOne({ workspaceId, _id: releaseId, revision: Number(revision) }).select('environmentId serviceIds projectId').lean(); if (!release) return false; const [environment, services, project] = await Promise.all([DeploymentEnvironmentModel.exists({ workspaceId, _id: release.environmentId, active: true }), ServiceModel.countDocuments({ workspaceId, _id: { $in: release.serviceIds }, archivedAt: null }), release.projectId ? ProjectModel.exists({ workspaceId, _id: release.projectId, status: 'active' }) : true]); return Boolean(environment) && Boolean(project) && services === new Set(release.serviceIds.map(String)).size; };
const changeWorkRefreshNeeded = async (workspaceId: string, kind: string, entityId: unknown, revision: string, policyVersion: number, now: Date) => {
  const operationKey = `${kind}:${entityId}:${revision}`;
  const work = await ChangeWorkModel.findOne({ workspaceId, operationKey, status: 'completed' }).select('completedAt').lean();
  if (!work) return false;
  const freshSince = new Date(now.getTime() - 24 * 60 * 60_000);
  if (kind === 'risk') {
    return !(await ChangeRiskModel.exists({ workspaceId, releaseId: entityId, releaseRevision: Number(revision), policyVersion, $or: [{ lastRefreshedAt: { $gte: freshSince } }, { evaluatedAt: { $gte: freshSince } }] }));
  }
  if (kind === 'pre-health' || kind === 'post-health') {
    const phase = kind === 'pre-health' ? 'pre' : 'post';
    return !(await ChangeHealthModel.exists({ workspaceId, releaseId: entityId, releaseRevision: Number(revision), phase, $or: [{ lastRefreshedAt: { $gte: freshSince } }, { evaluatedAt: { $gte: freshSince } }] }));
  }
  if (kind === 'correlation') return !work.completedAt || work.completedAt < freshSince;
  return false;
};

export const scheduleChangeReconciliation = async (now = new Date(), worker = 'change-reconcile') => {
  const leaseOwner = `${worker}:${randomUUID()}`;
  const leaseExpiresAt = new Date(now.getTime() + 60_000);
  let checkpoint;
  try {
    checkpoint = await ChangeCheckpointModel.findOneAndUpdate(
      { _id: 'release-cursor', $or: [{ leaseExpiresAt: null }, { leaseExpiresAt: { $lte: now } }] },
      { $set: { leaseOwner, leaseExpiresAt }, $setOnInsert: { lastRunAt: new Date(0) } },
      { upsert: true, new: true },
    );
  } catch (error) {
    if ((error as { code?: number }).code === 11000) return 0;
    throw error;
  }
  if (!checkpoint || checkpoint.leaseOwner !== leaseOwner) return 0;
  if (!checkpoint.cursor && checkpoint.lastRunAt && checkpoint.lastRunAt.getTime() > now.getTime() - 60_000) {
    await ChangeCheckpointModel.updateOne({ _id: checkpoint._id, leaseOwner }, { $unset: { leaseOwner: 1, leaseExpiresAt: 1 } });
    return 0;
  }

  const filter = checkpoint.cursor ? { _id: { $gt: checkpoint.cursor } } : {};
  const releases = await ChangeReleaseModel.find(filter).select('_id workspaceId revision state').sort({ _id: 1 }).limit(100).lean();
  const policies = new Map<string, { version: number; postHealthRequired: boolean }>();
  let scheduled = 0;
  let lastScheduled = checkpoint.cursor;
  let blocked = false;

  for (const release of releases) {
    const workspaceId = String(release.workspaceId);
    const releaseId = String(release._id);
    const revision = String(release.revision);
    if (!(await changeSourceCurrent(workspaceId, releaseId, revision))) {
      lastScheduled = release._id;
      scheduled++;
      continue;
    }

    let policy = policies.get(workspaceId);
    if (!policy) {
      const active = await ChangePolicyModel.findOne({ workspaceId, active: true }).select('version configuration.postHealthRequired').lean();
      policy = { version: active?.version ?? 1, postHealthRequired: active?.configuration?.postHealthRequired !== false };
      policies.set(workspaceId, policy);
    }

    const terminal = ['completed', 'failed', 'rolled_back'].includes(release.state);
    const riskRefresh = await changeWorkRefreshNeeded(workspaceId, 'risk', release._id, revision, policy.version, now);
    const admitted: unknown[] = [await enqueueChangeWork(workspaceId, 'risk', release._id, revision, riskRefresh)];
    if (!terminal) {
      const healthRefresh = await changeWorkRefreshNeeded(workspaceId, 'pre-health', release._id, revision, policy.version, now);
      admitted.push(await enqueueChangeWork(workspaceId, 'pre-health', release._id, revision, healthRefresh));
    } else {
      if (policy.postHealthRequired) {
        const healthRefresh = await changeWorkRefreshNeeded(workspaceId, 'post-health', release._id, revision, policy.version, now);
        admitted.push(await enqueueChangeWork(workspaceId, 'post-health', release._id, revision, healthRefresh));
      }
      const correlationRefresh = await changeWorkRefreshNeeded(workspaceId, 'correlation', release._id, revision, policy.version, now);
      admitted.push(await enqueueChangeWork(workspaceId, 'correlation', release._id, revision, correlationRefresh));
    }
    if (admitted.some((item) => item == null)) {
      blocked = true;
      break;
    }
    lastScheduled = release._id;
    scheduled++;
  }

  const pageComplete = !blocked && releases.length < 100;
  await ChangeCheckpointModel.updateOne(
    { _id: checkpoint._id, leaseOwner },
    { $set: { cursor: pageComplete ? null : lastScheduled ?? null, lastRunAt: pageComplete ? now : checkpoint.lastRunAt }, $unset: { leaseOwner: 1, leaseExpiresAt: 1 } },
  );
  return scheduled;
};
type ChangeRefreshEvent = { workspaceId: string; actorId: string; entityId: string; type: 'change.riskEvaluated'|'change.healthUpdated'|'change.correlationUpdated'; payload: Record<string, never> };
const publishChangeRefresh = (event: ChangeRefreshEvent) => publishAutomationHint({ workspaceId: event.workspaceId, actorId: event.actorId, entityId: event.entityId, type: event.type });
export const processChangeWork = async (now = new Date(), worker = 'change-worker', controlledExecution?: (job: { kind?: string | null; entityId: unknown; sourceRevision?: string | null }) => Promise<void>, publish: (event: ChangeRefreshEvent) => unknown = publishChangeRefresh) => {
  await Promise.all([scheduleChangeReconciliation(now,worker), expireChangeApprovals(now)]); const owner = `${worker}:${randomUUID()}`; const job = await ChangeWorkModel.findOneAndUpdate({ status: { $in: ['pending', 'processing'] }, availableAt: { $lte: now }, $or: [{ leaseExpiresAt: null }, { leaseExpiresAt: { $lte: now } }] }, { $set: { status: 'processing', leaseOwner: owner, leaseExpiresAt: new Date(now.getTime() + 60_000) }, $inc: { attemptCount: 1 } }, { sort: { availableAt: 1, _id: 1 }, new: true }); if (!job) return false;
  if (!(await changeSourceCurrent(String(job.workspaceId), String(job.entityId), String(job.sourceRevision)))) { await ChangeWorkModel.updateOne({ _id: job._id, leaseOwner: owner, status: 'processing' }, { $set: { status: 'completed', completedAt: now, error: 'SOURCE_STALE' }, $unset: { leaseOwner: 1, leaseExpiresAt: 1 } }); return true; }
  try { let refreshType: 'change.riskEvaluated'|'change.healthUpdated'|'change.correlationUpdated'|undefined; if (controlledExecution) await controlledExecution(job); else if (job.kind === 'risk') { if (await evaluateChangeRisk(String(job.workspaceId), String(job.entityId), now)) refreshType='change.riskEvaluated'; } else if (job.kind === 'pre-health' || job.kind === 'post-health') { if (job.kind !== 'post-health' || await activePolicyRequiresPostHealth(String(job.workspaceId))) { if (await evaluateReleaseHealth(String(job.workspaceId), String(job.entityId), job.kind === 'pre-health' ? 'pre' : 'post', now)) refreshType='change.healthUpdated'; } } else if (job.kind === 'correlation') { await generateChangeCorrelations(String(job.workspaceId), String(job.entityId), now); refreshType='change.correlationUpdated'; } const completed = await ChangeWorkModel.updateOne({ _id: job._id, leaseOwner: owner, status: 'processing' }, { $set: { status: 'completed', completedAt: now }, $unset: { leaseOwner: 1, leaseExpiresAt: 1, error: 1 } }); if (completed.matchedCount !== 1) throw new Error('Lease lost'); if (refreshType) publish({ workspaceId: String(job.workspaceId), actorId: automationActorId, entityId: String(job.entityId), type: refreshType, payload: {} }); }
  catch { const dead = job.attemptCount >= 5; await ChangeWorkModel.updateOne({ _id: job._id, leaseOwner: owner }, { $set: { status: dead ? 'dead' : 'pending', availableAt: new Date(now.getTime() + Math.min(300_000, 1000 * 2 ** job.attemptCount)), error: 'CHANGE_EVALUATION_FAILED' }, $unset: { leaseOwner: 1, leaseExpiresAt: 1 } }); } return true;
};
const canonicalPayload = (value: unknown): unknown => Array.isArray(value) ? value.map(canonicalPayload) : value && typeof value === 'object' && !(value instanceof Date) ? Object.fromEntries(Object.entries(value).sort(([left],[right]) => left.localeCompare(right)).map(([key,item]) => [key,canonicalPayload(item)])) : value;
export const stablePayloadHash = (value: unknown) => createHash('sha256').update(JSON.stringify(canonicalPayload(value))).digest('hex');
const average = (values: number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
export const calculateChangeMetrics = async (workspaceId: string, from: Date, to: Date) => {
  const releases = await ChangeReleaseModel.find({ workspaceId, createdAt: { $gte: from, $lte: to } }).select('_id state serviceIds environmentId projectId plannedAt completedAt createdAt revision').sort({ createdAt: 1, _id: 1 }).limit(5000).lean();
  const deployments = await ChangeDeploymentHistoryModel.find({ workspaceId, occurredAt: { $gte: from, $lte: to }, state: { $in: ['deploying','completed','failed','rolled_back'] } }).select('releaseId state occurredAt').sort({ occurredAt: 1, _id: 1 }).limit(5000).lean();
  const releaseIds = releases.map((release) => release._id); const risks = await ChangeRiskModel.find({ workspaceId, releaseId: { $in: releaseIds }, evaluatedAt: { $gte: from, $lte: to } }).select('releaseId policyVersion score band factors').limit(10_000).lean();
  const [approvals, health, correlations, work] = await Promise.all([ChangeApprovalModel.find({ workspaceId, releaseId: { $in: releaseIds }, createdAt: { $gte: from, $lte: to } }).select('state createdAt updatedAt').limit(5000).lean(), ChangeHealthModel.find({ workspaceId, releaseId: { $in: releaseIds }, phase: 'post', evaluatedAt: { $gte: from, $lte: to } }).select('releaseId classification evaluatedAt lastRefreshedAt').limit(5000).lean(), ChangeCorrelationModel.find({ workspaceId, releaseId: { $in: releaseIds }, state: 'confirmed', decidedAt: { $gte: from, $lte: to } }).select('sourceType').limit(5000).lean(), ChangeWorkModel.find({ workspaceId, createdAt: { $gte: from, $lte: to } }).select('status attemptCount').limit(5000).lean()]);
  const deploymentByRelease = new Map<string, typeof deployments[number]>(); for (const deployment of deployments) deploymentByRelease.set(String(deployment.releaseId), deployment); const deploymentOutcomes = [...deploymentByRelease.values()]; const states = Object.fromEntries(['deploying','completed','failed','rolled_back'].map((state) => [state, deploymentOutcomes.filter((deployment) => deployment.state === state).length])); const deploymentTotal = deploymentOutcomes.length; const completed = states.completed ?? 0; const failures = (states.failed ?? 0) + (states.rolled_back ?? 0);
  const leadTimes = releases.filter((release) => release.plannedAt && release.completedAt && release.completedAt >= release.plannedAt).map((release) => release.completedAt!.getTime() - release.plannedAt!.getTime()); const approvalDurations = approvals.filter((approval) => approval.state !== 'pending').map((approval) => approval.updatedAt.getTime() - approval.createdAt.getTime());
  const releaseById = new Map(releases.map((release) => [String(release._id), release])); const riskGroups = new Map<string,{count:number;total:number}>(); for (const risk of risks) { const release = releaseById.get(String(risk.releaseId)); if (!release) continue; for (const key of [`environment:${release.environmentId}`, ...(release.projectId ? [`project:${release.projectId}`] : []), ...release.serviceIds.map((id) => `service:${id}`), `policy:${risk.policyVersion}`]) { const item = riskGroups.get(key) ?? { count: 0, total: 0 }; item.count++; item.total += risk.score ?? 0; riskGroups.set(key, item); } }
  const riskDistribution = [...riskGroups].map(([key, item]) => ({ key, count: item.count, averageScore: item.total / item.count })).sort((a,b) => b.averageScore-a.averageScore || a.key.localeCompare(b.key)).slice(0,500); const healthByRelease = new Map<string, typeof health>(); for (const item of health) { const key=String(item.releaseId); healthByRelease.set(key,[...(healthByRelease.get(key)??[]),item]); } const post = healthByRelease.size; const refreshed=(item:(typeof health)[number])=>item.lastRefreshedAt??item.evaluatedAt!; const degraded = [...healthByRelease.values()].filter((items) => ['degraded','failed'].includes(items.reduce((latest,item)=>!latest||refreshed(item)>refreshed(latest)?item:latest,undefined as (typeof items)[number]|undefined)?.classification ?? 'unknown')).length; const timeToHealthy = [...healthByRelease.entries()].map(([releaseId,items]) => { const release=releaseById.get(releaseId); const firstHealthy=items.filter((item)=>item.classification==='healthy').sort((a,b)=>a.evaluatedAt!.getTime()-b.evaluatedAt!.getTime())[0]; return release?.completedAt&&firstHealthy?.evaluatedAt ? Math.max(0,firstHealthy.evaluatedAt.getTime()-release.completedAt.getTime()) : null; }).filter((value):value is number=>value!==null);
  return { cohort: { from: from.toISOString(), to: to.toISOString(), maximumDays: 366, releaseCount: releases.length, truncated: releases.length === 5000 || deployments.length === 5000 }, deployments: { total: deploymentTotal, frequencyPerDay: deploymentTotal / Math.max(1,(to.getTime()-from.getTime())/86400_000), byState: states, changeFailureRate: completed+failures ? failures/(completed+failures) : null, leadTimeMs: { average: average(leadTimes), sampleCount: leadTimes.length, excluded: releases.length-leadTimes.length } }, approvals: { averageDurationMs: average(approvalDurations), rejectionRate: approvals.length ? approvals.filter((item)=>item.state==='rejected').length/approvals.length : null, sampleCount: approvals.length, pending: approvals.filter((item)=>item.state==='pending').length }, policyBlocks: { pendingApprovals: approvals.filter((item)=>item.state==='pending').length, freezeWindowRisks: risks.filter((risk)=>risk.factors.some((factor)=>factor.key==='freezeWindow'&&(factor.value??0)>0)).length }, health: { postDeploymentDegradationRate: post ? degraded/post : null, timeToHealthyMs: average(timeToHealthy), unknown: health.filter((item)=>item.classification==='unknown').length }, confirmedCorrelations: Object.fromEntries(['incident','alert','slo','monitor','intelligence'].map((type)=>[type,correlations.filter((item)=>item.sourceType===type).length])), risk: { distribution: riskDistribution, highestRiskServices: riskDistribution.filter((item)=>item.key.startsWith('service:')).slice(0,20), highestRiskProjects: riskDistribution.filter((item)=>item.key.startsWith('project:')).slice(0,20) }, worker: { failures: work.filter((item)=>item.status==='dead').length, retries: work.reduce((sum,item)=>sum+Math.max(0,item.attemptCount-1),0), deadLetters: work.filter((item)=>item.status==='dead').length }, insufficientData: releases.length===0 && deploymentTotal===0, limitations: 'Release counts use a creation cohort; deployment totals use the latest bounded deployment-history event per release. At most 5,000 releases and deployment events, 10,000 risk snapshots, 366 days, and 500 grouped risk rows. Null means insufficient valid data.' };
};
export const changeModelsReady = async () => { await Promise.all([ChangeWorkModel.createIndexes(), ChangeReleaseModel.createIndexes(), ChangePolicyModel.createIndexes()]); void mongoose; };

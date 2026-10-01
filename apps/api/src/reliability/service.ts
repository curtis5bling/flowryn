import { createHash, randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';

import type { sliBatchSchema } from '@flowryn/shared';
import mongoose from 'mongoose';
import type { ClientSession } from 'mongoose';
import type { z } from 'zod';

import { publishAutomationHint } from '../automation/hints.js';
import { emitDomainEvent } from '../automation/outbox.js';
import { automationActorId, automationPrincipal, type AutomationContext } from '../automation/principal.js';
import { decryptSecret } from '../automation/security.js';
import { publicAddress } from '../automation/security.js';
import { IncidentError } from '../incidents/service.js';
import { AlertModel, PolicyModel } from '../oncall/models.js';
import { cancelEscalations, createAlert, selectPolicy, startEscalation } from '../oncall/service.js';

import { ServiceDependencyModel, ServiceLevelObjectiveModel, ServiceModel, SliSampleModel, SloEvaluationModel, SyntheticMonitorModel, SyntheticMonitorRunModel } from './models.js';


export const normalizeServiceSlug = (value: string) => value.normalize('NFKC').toLowerCase();
export const nextMonitorRunAt = (now: Date, intervalSeconds: number) => new Date(now.getTime() + intervalSeconds * 1000);
export const assertSafeMonitorUrl = (raw: string) => {
  const url = new URL(raw);
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) throw new IncidentError(400, 'Only credential-free HTTPS URLs on port 443 are supported');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if ((isIP(host) && !publicAddress(host)) || /(^|\.)(localhost|local|internal|test|invalid|example|onion)$/.test(host.toLowerCase())) throw new IncidentError(400, 'Monitor destination denied');
  return url;
};
export const dependencyImpact = async (workspaceId: string, serviceId: string, direction: 'upstream' | 'downstream', maxDepth = 10, maxNodes = 500, session?: ClientSession) => {
  const visited = new Set([serviceId]); let frontier = [serviceId]; const edges: Array<{ upstreamServiceId: string; downstreamServiceId: string; depth: number }> = [];
  for (let depth = 1; frontier.length && depth <= maxDepth; depth++) {
    const query = direction === 'upstream' ? { downstreamServiceId: { $in: frontier } } : { upstreamServiceId: { $in: frontier } };
    const found = await ServiceDependencyModel.find({ workspaceId, enabled: true, archivedAt: null, ...query }).limit(maxNodes + 1).session(session ?? null).lean();
    if (found.length > maxNodes) throw new IncidentError(409, 'Dependency graph limit exceeded');
    const next: string[] = [];
    for (const edge of found) {
      const candidate = String(direction === 'upstream' ? edge.upstreamServiceId : edge.downstreamServiceId);
      edges.push({ upstreamServiceId: String(edge.upstreamServiceId), downstreamServiceId: String(edge.downstreamServiceId), depth });
      if (!visited.has(candidate)) { visited.add(candidate); next.push(candidate); }
      if (visited.size > maxNodes) throw new IncidentError(409, 'Dependency graph limit exceeded');
    }
    frontier = next;
  }
  if (frontier.length) {
    const boundary = direction === 'upstream' ? { downstreamServiceId: { $in: frontier } } : { upstreamServiceId: { $in: frontier } };
    if (await ServiceDependencyModel.exists({ workspaceId, enabled: true, archivedAt: null, ...boundary }).session(session ?? null)) throw new IncidentError(409, 'Dependency graph depth limit exceeded');
  }
  return { serviceIds: [...visited].slice(1), edges };
};
export const wouldCreateCycle = async (workspaceId: string, upstream: string, downstream: string, session?: ClientSession) => (await dependencyImpact(workspaceId, upstream.toLowerCase(), 'upstream', 10, 500, session)).serviceIds.includes(downstream.toLowerCase());
export const ingestSliBatch = async (input: { workspaceId: string; source: 'api' | 'webhook' | 'automation'; sourceId?: string; batch: z.infer<typeof sliBatchSchema>; now?: Date; session?: ClientSession }) => {
  const now = input.now ?? new Date();
  const samples = input.batch.samples.map((sample) => ({ ...sample, serviceId: sample.serviceId.toLowerCase(), sloId: sample.sloId.toLowerCase() }));
  const sloIds = [...new Set(samples.map((sample) => sample.sloId))];
  const ingest = async (session: ClientSession) => {
    const slos = await ServiceLevelObjectiveModel.find({ workspaceId: input.workspaceId, _id: { $in: sloIds }, enabled: true, archivedAt: null }).limit(101).session(session);
    if (slos.length !== sloIds.length) throw new IncidentError(400, 'Active workspace SLOs required');
    const byId = new Map(slos.map((slo) => [slo.id, slo]));
    const operations = samples.map((sample) => {
      const timestamp = new Date(sample.timestamp); const slo = byId.get(sample.sloId)!; const source = slo.dataSource as { type: string; sourceId?: string };
      if (timestamp.getTime() > now.getTime() + 300_000 || timestamp.getTime() < now.getTime() - 7 * 86400_000) throw new IncidentError(400, 'Sample timestamp outside ingestion window');
      if (String(slo.serviceId) !== sample.serviceId || source.type !== input.source || (source.sourceId && source.sourceId !== input.sourceId)) throw new IncidentError(400, 'SLO source is not eligible');
      const observations = sample.latencyMs ?? []; const total = slo.indicatorType === 'latency' ? observations.length : sample.total!; const good = slo.indicatorType === 'latency' ? observations.filter((value) => value <= slo.latencyThresholdMs!).length : sample.good!;
      if (slo.indicatorType === 'latency' && !observations.length) throw new IncidentError(400, 'Latency observations required');
      if (slo.indicatorType !== 'latency' && sample.good === undefined) throw new IncidentError(400, 'Good and total counts required');
      return { updateOne: { filter: { workspaceId: input.workspaceId, idempotencyKey: sample.idempotencyKey }, update: { $setOnInsert: { ...sample, good, total, workspaceId: input.workspaceId, timestamp, bucketAt: new Date(Math.floor(timestamp.getTime() / 300000) * 300000), sloVersion: slo.version, source: input.source, ...(input.sourceId ? { sourceId: input.sourceId } : {}), expiresAt: new Date(now.getTime() + 400 * 86400_000) } }, upsert: true } };
    });
    for (const slo of slos) {
      const fenced = await ServiceLevelObjectiveModel.updateOne({ workspaceId: input.workspaceId, _id: slo._id, version: slo.version, enabled: true, archivedAt: null }, { $inc: { ingestionRevision: 1 } }, { session });
      if (!fenced.modifiedCount) throw new IncidentError(409, 'SLO changed during ingestion');
    }
    const result = await SliSampleModel.bulkWrite(operations as Parameters<typeof SliSampleModel.bulkWrite>[0], { ordered: false, session });
    return { accepted: result.upsertedCount, duplicates: samples.length - result.upsertedCount };
  };
  if (input.session) return ingest(input.session);
  const session = await mongoose.startSession(); let result: Awaited<ReturnType<typeof ingest>> | undefined;
  try { await session.withTransaction(async () => { result = await ingest(session); }); }
  finally { await session.endSession(); }
  if (!result) throw new IncidentError(500, 'SLI ingestion failed');
  return result;
};
export const calculateEvaluation = async (workspaceId: string, slo: InstanceType<typeof ServiceLevelObjectiveModel>, now = new Date()) => {
  const windowStart = new Date(now.getTime() - slo.rollingWindowDays! * 86400_000);
  const source = slo.dataSource as { type: string; sourceId?: string };
  const compatibleVersions = await ServiceLevelObjectiveModel.find({ workspaceId, objectiveKey: slo.objectiveKey, serviceId: slo.serviceId, indicatorType: slo.indicatorType, 'dataSource.type': source.type, ...(source.sourceId ? { 'dataSource.sourceId': source.sourceId } : { 'dataSource.sourceId': { $exists: false } }), ...(slo.indicatorType === 'latency' ? { latencyThresholdMs: slo.latencyThresholdMs, percentile: slo.percentile } : {}) }).select('_id version').lean();
  const compatibleSamples = compatibleVersions.map((version) => ({ sloId: version._id, sloVersion: version.version }));
  const aggregate = async (start: Date) => {
    const match = { workspaceId: slo.workspaceId, $or: compatibleSamples, source: source.type, ...(source.sourceId ? { sourceId: source.sourceId } : {}), timestamp: { $gte: start, $lte: now } };
    if (slo.indicatorType !== 'latency') return (await SliSampleModel.aggregate([{ $match: match }, { $group: { _id: null, good: { $sum: '$good' }, total: { $sum: '$total' } } }]))[0] ?? { good: 0, total: 0 };
    const rows = await SliSampleModel.aggregate([{ $match: match }, { $unwind: '$latencyMs' }, { $group: { _id: null, percentile: { $percentile: { input: '$latencyMs', p: [slo.percentile! / 100], method: 'approximate' } }, total: { $sum: 1 }, good: { $sum: { $cond: [{ $and: [{ $ne: ['$endpointHealthy', false] }, { $lte: ['$latencyMs', slo.latencyThresholdMs!] }] }, 1, 0] } } } } as never]);
    const row = rows[0] as { percentile?: number[]; total?: number; good?: number } | undefined;
    const total = row?.total ?? 0;
    if (!total) return { good: 0, total: 0 };
    return { good: row?.good ?? 0, total, percentileBreaching: row?.percentile?.[0] === undefined || row.percentile[0] > slo.latencyThresholdMs! };
  };
  const configuredRules = [...(slo.burnRateAlerts ?? [])].sort((a, b) => (a.shortWindowMinutes ?? 0) - (b.shortWindowMinutes ?? 0) || (a.longWindowMinutes ?? 0) - (b.longWindowMinutes ?? 0)) as Array<{ shortWindowMinutes: number; longWindowMinutes: number; threshold: number; recoveryThreshold?: number; escalationPolicyId?: unknown }>;
  const configured = configuredRules[0];
  const shortWindowStart = new Date(now.getTime() - (configured?.shortWindowMinutes ?? 60) * 60000);
  const longWindowStart = new Date(now.getTime() - (configured?.longWindowMinutes ?? 360) * 60000);
  const [samples, ...windowSamples] = await Promise.all([aggregate(windowStart), ...configuredRules.flatMap((rule) => [aggregate(new Date(now.getTime() - rule.shortWindowMinutes * 60000)), aggregate(new Date(now.getTime() - rule.longWindowMinutes * 60000))])]);
  const short = windowSamples[0] ?? await aggregate(shortWindowStart); const long = windowSamples[1] ?? await aggregate(longWindowStart);
  const { good = 0, total = 0 } = samples;
  const compliance = total ? good / total : null; const target = slo.objectiveTarget! / 100; const allowed = 1 - target;
  const consumption = total && allowed > 0 ? (1 - compliance!) / allowed : null;
  const state = total ? (slo.indicatorType === 'latency' ? (samples.percentileBreaching || compliance! < target ? 'breaching' : 'healthy') : compliance! >= target ? 'healthy' : 'breaching') : slo.missingDataPolicy === 'bad' ? 'breaching' : 'unknown';
  const burn = (sample: { good: number; total: number }) => sample.total && allowed > 0 ? (1 - sample.good / sample.total) / allowed : null;
  const burnWindows = configuredRules.map((rule, index) => { const shortRate = burn(windowSamples[index * 2]!); const longRate = burn(windowSamples[index * 2 + 1]!); const recoveryThreshold = rule.recoveryThreshold ?? rule.threshold * 0.5; return { shortWindowMinutes: rule.shortWindowMinutes, longWindowMinutes: rule.longWindowMinutes, threshold: rule.threshold, recoveryThreshold, escalationPolicyId: rule.escalationPolicyId, shortBurnRate: shortRate, longBurnRate: longRate, breached: shortRate !== null && longRate !== null && shortRate >= rule.threshold && longRate >= rule.threshold, recovered: shortRate !== null && longRate !== null && shortRate <= recoveryThreshold && longRate <= recoveryThreshold }; });
  const shortBurnRate = burn(short); const longBurnRate = burn(long); const thresholdBreached = burnWindows.some((window) => window.breached);
  return { workspaceId, serviceId: slo.serviceId, sloId: slo._id, objectiveKey: slo.objectiveKey, sloVersion: slo.version, windowStart, windowEnd: now, shortWindowStart, longWindowStart, burnWindows, state, good, total, compliance, remainingBudget: consumption === null ? null : Math.max(0, 1 - consumption), consumption, shortBurnRate, longBurnRate, breaching: state === 'breaching' || thresholdBreached };
};
export const storeEvaluation = async (workspaceId: string, slo: InstanceType<typeof ServiceLevelObjectiveModel>, now = new Date()) => {
  now = new Date(Math.floor(now.getTime() / 60000) * 60000);
  const persisted = await SloEvaluationModel.findOne({ workspaceId, sloId: slo._id, sloVersion: slo.version, windowEnd: now }).lean();
  if (persisted) return persisted;
  const result = await calculateEvaluation(workspaceId, slo, now);
  let transition: 'breached' | 'recovered' | undefined;
  let budgetThresholdReached = false;
  const session = await mongoose.startSession();
  try { await session.withTransaction(async () => {
    transition = undefined; budgetThresholdReached = false;
    const active = await ServiceLevelObjectiveModel.updateOne(
      { workspaceId, _id: slo._id, objectiveKey: slo.objectiveKey, version: slo.version, enabled: true, archivedAt: null, $or: [{ lastEvaluationAt: null }, { lastEvaluationAt: { $lt: now } }] },
      { $set: { lastEvaluationAt: now } },
      { session },
    );
    if (!active.modifiedCount) {
      const existing = await SloEvaluationModel.findOne({ sloId: slo._id, sloVersion: slo.version, windowEnd: now }).session(session).lean();
      if (existing) Object.assign(result, existing);
      return;
    }
    const newer = await SloEvaluationModel.exists({ workspaceId, objectiveKey: slo.objectiveKey, windowEnd: { $gt: now } }).session(session);
    const previous = await SloEvaluationModel.findOne({ workspaceId, objectiveKey: slo.objectiveKey, ...(slo.transitionBaselineAt ? { createdAt: { $gte: slo.transitionBaselineAt } } : {}), windowEnd: { $lte: now } }).sort({ windowEnd: -1, sloVersion: -1, createdAt: -1 }).session(session);
    const previouslyBreaching = Boolean(previous?.breaching);
    if (previouslyBreaching && (result.state !== 'healthy' || result.burnWindows.some((window) => !window.recovered))) result.breaching = true;
    const stored = await SloEvaluationModel.updateOne({ sloId: slo._id, sloVersion: slo.version, windowEnd: now }, { $setOnInsert: { ...result, ...(result.breaching && !previouslyBreaching ? { breachedAt: now } : {}), ...(!result.breaching && previouslyBreaching ? { recoveredAt: now } : {}) } }, { upsert: true, session });
    if (!stored.upsertedCount || newer) return;
    const context: AutomationContext = { principal: automationPrincipal, configuredBy: String(slo.updatedBy), correlationId: `slo:${slo.objectiveKey}`, causationId: `evaluation:${slo.id}:${now.toISOString()}`, chainDepth: 0, rulePath: [] };
    const payload = { actorId: automationActorId, serviceId: String(slo.serviceId), sloId: slo.id, sloVersion: slo.version, windowStart: result.windowStart.toISOString(), windowEnd: now.toISOString(), ...(result.longBurnRate === null ? {} : { burnRate: result.longBurnRate }), ...(result.remainingBudget === null ? {} : { remainingBudget: result.remainingBudget }) };
    if (result.breaching && !previouslyBreaching) {
      transition = 'breached';
      const rule = result.burnWindows.find((window) => window.breached) ?? result.burnWindows[0];
      const hash = createHash('sha256').update(`slo-breach:${slo.objectiveKey}:${slo.version}:${now.toISOString()}`).digest('hex');
      const operationId = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
      const policyId = rule?.escalationPolicyId && await PolicyModel.exists({ workspaceId, _id: rule.escalationPolicyId, enabled: true, archivedAt: null }).session(session) ? String(rule.escalationPolicyId) : undefined;
      const fields = { operationId, fingerprint: `slo:${slo.objectiveKey}`, title: `SLO breached: ${slo.name}`, summary: `Version ${slo.version}; evaluation window ${result.windowStart.toISOString()} to ${now.toISOString()}`, severity: 'sev2' as const, serviceId: String(slo.serviceId), labels: { source: 'flowryn-slo' }, ...(policyId ? { escalationPolicyId: policyId } : {}) };
      const resolved = await AlertModel.findOne({ workspaceId, fingerprint: fields.fingerprint, status: 'resolved' }).session(session);
      if (resolved) { const selected = await selectPolicy(workspaceId, fields, now, session); resolved.status = 'open'; resolved.cycle += 1; resolved.resolvedAt = undefined; resolved.resolvedBy = undefined; resolved.acknowledgedAt = undefined; resolved.acknowledgedBy = undefined; await resolved.save({ session }); await startEscalation(resolved, selected.policy, session, now, context); }
      await createAlert({ workspaceId, actorId: automationActorId, session, automation: context, fields });
      await emitDomainEvent(session, { workspaceId, eventType: 'slo.breached', aggregateType: 'slo', aggregateId: slo.id, payload, context });
    } else if (!result.breaching && previouslyBreaching) {
      transition = 'recovered';
      const alert = await AlertModel.findOne({ workspaceId, fingerprint: `slo:${slo.objectiveKey}`, status: { $ne: 'resolved' } }).session(session);
      if (alert) { alert.status = 'resolved'; alert.resolvedAt = now; alert.resolvedBy = new mongoose.Types.ObjectId(automationActorId); await alert.save({ session }); await cancelEscalations(workspaceId, alert.id, session); }
      await emitDomainEvent(session, { workspaceId, eventType: 'slo.recovered', aggregateType: 'slo', aggregateId: slo.id, payload, context });
    }
    if (result.remainingBudget !== null && result.remainingBudget <= 0.25 && (previous?.remainingBudget == null || previous.remainingBudget > 0.25)) { const eventId = createHash('sha256').update(`slo-budget:${slo.objectiveKey}:${slo.version}:${now.toISOString()}`).digest('hex'); budgetThresholdReached = true; await emitDomainEvent(session, { workspaceId, eventType: 'slo.errorBudgetThresholdReached', aggregateType: 'slo', aggregateId: slo.id, eventId, payload, context }); }
  }); } finally { await session.endSession(); }
  if (transition) publishAutomationHint({ workspaceId, actorId: automationActorId, entityId: slo.id, type: transition === 'breached' ? 'slo.breached' : 'slo.recovered' });
  if (budgetThresholdReached) publishAutomationHint({ workspaceId, actorId: automationActorId, entityId: slo.id, type: 'slo.errorBudgetThresholdReached' });
  return result;
};

export const processDueSloEvaluation = async (now = new Date(), owner = 'reliability-worker') => {
  const leaseOwner = `${owner}:slo:${randomUUID()}`; const evaluatedAt = new Date(Math.floor(now.getTime() / 60000) * 60000);
  const slo = await ServiceLevelObjectiveModel.findOneAndUpdate({ enabled: true, archivedAt: null, $and: [{ $or: [{ nextEvaluationAt: null }, { nextEvaluationAt: { $lte: now } }] }, { $or: [{ evaluationLeaseExpiresAt: null }, { evaluationLeaseExpiresAt: { $lte: now } }] }] }, { $set: { evaluationLeaseOwner: leaseOwner, evaluationLeaseExpiresAt: new Date(now.getTime() + 60000) } }, { new: true, sort: { nextEvaluationAt: 1, _id: 1 } });
  if (!slo) return false;
  try { await storeEvaluation(String(slo.workspaceId), slo, evaluatedAt); await ServiceLevelObjectiveModel.updateOne({ _id: slo._id, evaluationLeaseOwner: leaseOwner }, { $set: { nextEvaluationAt: new Date(evaluatedAt.getTime() + 60000) }, $unset: { evaluationLeaseOwner: 1, evaluationLeaseExpiresAt: 1 } }); }
  catch (error) { await ServiceLevelObjectiveModel.updateOne({ _id: slo._id, evaluationLeaseOwner: leaseOwner }, { $set: { nextEvaluationAt: new Date(now.getTime() + 30000) }, $unset: { evaluationLeaseOwner: 1, evaluationLeaseExpiresAt: 1 } }); throw error; }
  return true;
};

export type MonitorNetwork = (input: { url: URL; method: 'GET' | 'HEAD'; timeoutMs: number; maxRedirects: number; headers: Record<string, string>; assertion?: string }) => Promise<{ statusCode: number; latencyMs: number; body: string }>;
const infrastructureNetworkError = (error: unknown) => {
  const value = error as { code?: string; message?: string };
  return ['DESTINATION_DENIED', 'DNS_TIMEOUT', 'CROSS_ORIGIN_REDIRECT_DENIED', 'ERR_INVALID_CHAR', 'ERR_HTTP_INVALID_HEADER_VALUE'].includes(value.message ?? '') || ['ENOTFOUND', 'EAI_AGAIN', 'ENODATA', 'ERR_INVALID_CHAR', 'ERR_HTTP_INVALID_HEADER_VALUE'].includes(value.code ?? '');
};
export const secureMonitorNetwork: MonitorNetwork = async (input) => {
  let current = input.url; const started = Date.now(); const deadline = started + input.timeoutMs;
  const beforeDeadline = async <T>(operation: Promise<T>) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('TIMEOUT');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([operation, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('TIMEOUT')), remaining); })]); }
    finally { if (timer) clearTimeout(timer); }
  };
  for (let redirect = 0; redirect <= input.maxRedirects; redirect++) {
    assertSafeMonitorUrl(current.toString());
    const host = current.hostname.replace(/^\[|\]$/g, ''); let addresses: Array<{ address: string; family: number }>;
    try { addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await beforeDeadline(lookup(host, { all: true, verbatim: true })); }
    catch (error) { if ((error as Error).message === 'TIMEOUT') throw new Error('DNS_TIMEOUT'); throw error; }
    if (!addresses.length || addresses.length > 16 || addresses.some((x) => !publicAddress(x.address))) throw new Error('DESTINATION_DENIED');
    const result = await new Promise<{ statusCode: number; location?: string; body: string }>((resolve, reject) => {
      const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), Math.max(1, deadline - Date.now()));
      const req = httpsRequest(current, { method: input.method, signal: controller.signal, agent: false, headers: input.headers, maxHeaderSize: 8192, lookup: (_h, options, callback) => options.all ? callback(null, [addresses[0]!]) : callback(null, addresses[0]!.address, addresses[0]!.family) }, (res) => {
        const chunks: Buffer[] = []; let bytes = 0; let complete = false;
        res.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > 65536) req.destroy(new Error('RESPONSE_LIMIT')); else chunks.push(chunk); });
        res.on('end', () => { complete = true; resolve({ statusCode: res.statusCode ?? 0, location: res.headers.location, body: Buffer.concat(chunks).toString('utf8') }); });
        res.on('error', reject);
        res.on('close', () => { if (!complete) reject(new Error('RESPONSE_INTERRUPTED')); });
      });
      req.on('error', reject); req.on('close', () => clearTimeout(timer)); req.end();
    });
    if (result.statusCode >= 300 && result.statusCode < 400 && result.location) { if (redirect === input.maxRedirects) throw new Error('REDIRECT_LIMIT'); const next = new URL(result.location, current); if (next.origin !== current.origin) throw new Error('CROSS_ORIGIN_REDIRECT_DENIED'); current = next; continue; }
    return { statusCode: result.statusCode, latencyMs: Date.now() - started, body: result.body };
  }
  throw new Error('REDIRECT_LIMIT');
};
export const processReliabilityWork = async (now = new Date(), owner = 'reliability-worker', network: MonitorNetwork = secureMonitorNetwork, requested?: { workspaceId: string; monitorId: string }) => {
  const leaseOwner = `${owner}:${randomUUID()}`;
  const monitor = await SyntheticMonitorModel.findOneAndUpdate({ enabled: true, archivedAt: null, nextRunAt: { $lte: now }, ...(requested ? { workspaceId: requested.workspaceId, _id: requested.monitorId } : {}), $or: [{ leaseExpiresAt: null }, { leaseExpiresAt: { $lte: now } }] }, { $set: { leaseOwner, leaseExpiresAt: new Date(now.getTime() + 60000) } }, { new: true, sort: { nextRunAt: 1, _id: 1 } }).select('+secretCiphertext +secretKeyVersion');
  if (!monitor) return false;
  const scheduledAt = monitor.retryScheduledAt ?? monitor.nextRunAt ?? now; const key = createHash('sha256').update(`${monitor.id}:${scheduledAt.toISOString()}`).digest('hex');
  const prior = await SyntheticMonitorRunModel.findOne({ monitorId: monitor._id, idempotencyKey: key });
  if (prior && (['completed', 'deadLetter'].includes(prior.status!) || (prior.status === 'retrying' && prior.nextAttemptAt && prior.nextAttemptAt > now) || (prior.status === 'running' && prior.leaseExpiresAt && prior.leaseExpiresAt > now))) { await SyntheticMonitorModel.updateOne({ _id: monitor._id, leaseOwner }, { $set: { nextRunAt: prior.status === 'retrying' ? prior.nextAttemptAt : nextMonitorRunAt(now, monitor.intervalSeconds!), ...(prior.status === 'retrying' ? { retryScheduledAt: prior.scheduledAt } : {}) }, ...(prior.status === 'retrying' ? {} : { $unset: { retryScheduledAt: 1, leaseOwner: 1, leaseExpiresAt: 1 } }) }); if (prior.status === 'retrying') await SyntheticMonitorModel.updateOne({ _id: monitor._id, leaseOwner }, { $unset: { leaseOwner: 1, leaseExpiresAt: 1 } }); return false; }
  const run = await SyntheticMonitorRunModel.findOneAndUpdate({ monitorId: monitor._id, idempotencyKey: key, configVersion: monitor.configVersion, $or: [{ status: { $in: ['queued', 'retrying'] } }, { status: 'running', leaseExpiresAt: { $lte: now } }, { status: { $exists: false } }] }, { $setOnInsert: { workspaceId: monitor.workspaceId, serviceId: monitor.serviceId, configVersion: monitor.configVersion, scheduledAt }, $set: { status: 'running', leaseOwner, leaseExpiresAt: new Date(now.getTime() + 60000), startedAt: now }, $inc: { attemptCount: 1 } }, { upsert: !prior, new: true });
  if (!run) { await SyntheticMonitorModel.updateOne({ _id: monitor._id, leaseOwner }, { $unset: { leaseOwner: 1, leaseExpiresAt: 1 } }); return false; }
  let healthTransition: 'failed' | 'recovered' | undefined;
  try {
    const fresh = await SyntheticMonitorModel.findOne({ _id: monitor._id, enabled: true, archivedAt: null, configVersion: monitor.configVersion, leaseOwner, leaseExpiresAt: { $gt: now } }).select('+secretCiphertext +secretKeyVersion');
    if (!fresh) { await SyntheticMonitorRunModel.updateOne({ _id: run._id, status: 'running', leaseOwner }, { $set: { status: 'completed', errorCode: 'MONITOR_CONFIGURATION_CHANGED', completedAt: now }, $unset: { leaseOwner: 1, leaseExpiresAt: 1 } }); await SyntheticMonitorModel.updateOne({ _id: monitor._id, leaseOwner }, { $set: { nextRunAt: nextMonitorRunAt(now, monitor.intervalSeconds!) }, $unset: { retryScheduledAt: 1, leaseOwner: 1, leaseExpiresAt: 1 } }); return true; }
    if (!(await ServiceModel.exists({ workspaceId: fresh.workspaceId, _id: fresh.serviceId, archivedAt: null }))) { await SyntheticMonitorModel.updateOne({ _id: fresh._id, leaseOwner }, { $set: { enabled: false, health: 'unknown' }, $unset: { retryScheduledAt: 1, leaseOwner: 1, leaseExpiresAt: 1 } }); await SyntheticMonitorRunModel.updateOne({ _id: run._id, status: 'running', leaseOwner }, { $set: { status: 'completed', errorCode: 'SERVICE_ARCHIVED', completedAt: now }, $unset: { leaseOwner: 1, leaseExpiresAt: 1 } }); return true; }
    const headers = fresh.secretCiphertext ? JSON.parse(decryptSecret({ workspaceId: fresh.workspaceId, _id: fresh._id, keyVersion: fresh.secretKeyVersion!, credentials: fresh.secretCiphertext })) : {};
    let endpointError = false;
    const result = await network({ url: assertSafeMonitorUrl(fresh.url!), method: fresh.method as 'GET' | 'HEAD', timeoutMs: fresh.timeoutMs!, maxRedirects: fresh.maxRedirects!, headers, assertion: fresh.textAssertion ?? undefined }).catch((error) => { if (infrastructureNetworkError(error)) throw error; endpointError = true; return { statusCode: 0, latencyMs: fresh.timeoutMs!, body: '' }; });
    const healthy = !endpointError && result.statusCode >= fresh.expectedStatusMin! && result.statusCode <= fresh.expectedStatusMax! && (!fresh.textAssertion || result.body.includes(fresh.textAssertion));
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        const fenced = await SyntheticMonitorModel.findOne({ _id: fresh._id, enabled: true, archivedAt: null, configVersion: fresh.configVersion, leaseOwner, leaseExpiresAt: { $gt: now } }).session(session);
        if (!fenced) throw new Error('LEASE_LOST');
        const slo = fenced.sloId ? await ServiceLevelObjectiveModel.findOne({ workspaceId: fenced.workspaceId, _id: fenced.sloId, serviceId: fenced.serviceId, enabled: true, archivedAt: null, 'dataSource.type': 'synthetic', $or: [{ 'dataSource.sourceId': { $exists: false } }, { 'dataSource.sourceId': String(fenced._id) }] }).session(session) : null;
        if (slo) {
          const sloFence = await ServiceLevelObjectiveModel.updateOne({ workspaceId: fenced.workspaceId, _id: slo._id, version: slo.version, enabled: true, archivedAt: null }, { $inc: { ingestionRevision: 1 } }, { session });
          if (!sloFence.modifiedCount) throw new Error('SLO_CONFIGURATION_CHANGED');
        }
        const completed = await SyntheticMonitorRunModel.updateOne({ _id: run._id, status: 'running', leaseOwner }, { $set: { status: 'completed', endpointHealthy: healthy, statusCode: result.statusCode || null, latencyMs: result.latencyMs, errorCode: endpointError ? 'ENDPOINT_UNREACHABLE' : null, completedAt: now }, $unset: { leaseOwner: 1, leaseExpiresAt: 1, nextAttemptAt: 1 } }, { session });
        if (!completed.modifiedCount) throw new Error('LEASE_LOST');
        const observationGood = healthy && (!slo || slo.indicatorType !== 'latency' || result.latencyMs <= slo.latencyThresholdMs!);
        if (slo) await SliSampleModel.updateOne({ workspaceId: fenced.workspaceId, idempotencyKey: key }, { $setOnInsert: { serviceId: fenced.serviceId, sloId: slo._id, sloVersion: slo.version, timestamp: now, bucketAt: new Date(Math.floor(now.getTime() / 300000) * 300000), good: observationGood ? 1 : 0, total: 1, latencyMs: [result.latencyMs], endpointHealthy: healthy, source: 'synthetic', sourceId: String(fenced._id), metadata: {}, expiresAt: new Date(now.getTime() + 400 * 86400_000) } }, { upsert: true, session });
        healthTransition = !healthy && fenced.health !== 'failed' ? 'failed' : healthy && fenced.health === 'failed' ? 'recovered' : undefined;
        if (healthTransition) await emitDomainEvent(session, { workspaceId: String(fenced.workspaceId), eventType: healthTransition === 'failed' ? 'monitor.failed' : 'monitor.recovered', aggregateType: 'monitor', aggregateId: fenced.id, eventId: `${key}:${healthTransition}`, payload: { actorId: automationActorId, serviceId: String(fenced.serviceId), monitorId: fenced.id }, context: { principal: automationPrincipal, configuredBy: String(fenced.updatedBy), correlationId: `monitor:${fenced.id}`, causationId: key, chainDepth: 0, rulePath: [] } });
        const saved = await SyntheticMonitorModel.updateOne({ _id: fenced._id, leaseOwner }, { $set: { health: healthy ? 'healthy' : 'failed', failureCount: healthy ? 0 : fenced.failureCount + 1, nextRunAt: nextMonitorRunAt(now, fenced.intervalSeconds!) }, $unset: { retryScheduledAt: 1, leaseOwner: 1, leaseExpiresAt: 1 } }, { session });
        if (!saved.modifiedCount) throw new Error('LEASE_LOST');
      });
    } finally { await session.endSession(); }
  } catch {
    const stillOwned = await SyntheticMonitorModel.exists({ _id: monitor._id, configVersion: monitor.configVersion, leaseOwner });
    if (!stillOwned) {
      await SyntheticMonitorRunModel.updateOne({ _id: run._id, status: 'running', leaseOwner }, { $set: { status: 'completed', errorCode: 'MONITOR_CONFIGURATION_CHANGED', completedAt: now }, $unset: { leaseOwner: 1, leaseExpiresAt: 1, nextAttemptAt: 1 } });
      return true;
    }
    const dead = (run.attemptCount ?? 1) >= 5; const retryAt = new Date(now.getTime() + Math.min(3600_000, 30_000 * 2 ** Math.max(0, (run.attemptCount ?? 1) - 1)) + Number.parseInt(key.slice(0, 4), 16) % 5000);
    await SyntheticMonitorRunModel.updateOne({ _id: run._id, status: 'running', leaseOwner }, { $set: { status: dead ? 'deadLetter' : 'retrying', errorCode: 'MONITOR_INFRASTRUCTURE_FAILURE', ...(dead ? { completedAt: now } : { nextAttemptAt: retryAt }) }, $unset: { leaseOwner: 1, leaseExpiresAt: 1 } });
    await SyntheticMonitorModel.updateOne({ _id: monitor._id, leaseOwner }, { $set: { nextRunAt: dead ? nextMonitorRunAt(now, monitor.intervalSeconds!) : retryAt, ...(dead ? {} : { retryScheduledAt: scheduledAt }) }, ...(dead ? { $unset: { retryScheduledAt: 1, leaseOwner: 1, leaseExpiresAt: 1 } } : { $unset: { leaseOwner: 1, leaseExpiresAt: 1 } }) });
  }
  if (healthTransition === 'failed') publishAutomationHint({ workspaceId: String(monitor.workspaceId), actorId: automationActorId, entityId: monitor.id, type: 'monitor.failed' });
  if (healthTransition === 'recovered') publishAutomationHint({ workspaceId: String(monitor.workspaceId), actorId: automationActorId, entityId: monitor.id, type: 'monitor.recovered' });
  if (healthTransition) publishAutomationHint({ workspaceId: String(monitor.workspaceId), actorId: automationActorId, entityId: monitor.id, type: 'monitor.healthChanged' });
  return true;
};

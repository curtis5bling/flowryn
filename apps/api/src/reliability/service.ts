import { createHash, randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';

import mongoose from 'mongoose';
import type { ClientSession } from 'mongoose';

import { decryptSecret } from '../automation/security.js';
import { publicAddress } from '../automation/security.js';
import { IncidentError } from '../incidents/service.js';

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
export const calculateEvaluation = async (workspaceId: string, slo: InstanceType<typeof ServiceLevelObjectiveModel>, now = new Date()) => {
  const windowStart = new Date(now.getTime() - slo.rollingWindowDays! * 86400_000);
  const source = slo.dataSource as { type: string; sourceId?: string };
  const aggregate = async (start: Date) => (await SliSampleModel.aggregate([{ $match: { workspaceId: slo.workspaceId, sloId: slo._id, sloVersion: slo.version, source: source.type, ...(source.sourceId ? { sourceId: source.sourceId } : {}), timestamp: { $gte: start, $lte: now } } }, { $group: { _id: null, good: { $sum: '$good' }, total: { $sum: '$total' } } }]))[0] ?? { good: 0, total: 0 };
  const configured = slo.burnRateAlerts?.[0] as { shortWindowMinutes?: number; longWindowMinutes?: number } | undefined;
  const [samples, short, long] = await Promise.all([
    aggregate(windowStart),
    aggregate(new Date(now.getTime() - (configured?.shortWindowMinutes ?? 60) * 60000)),
    aggregate(new Date(now.getTime() - (configured?.longWindowMinutes ?? 360) * 60000)),
  ]);
  const { good = 0, total = 0 } = samples;
  const compliance = total ? good / total : null; const target = slo.objectiveTarget! / 100; const allowed = 1 - target;
  const consumption = total && allowed > 0 ? (1 - compliance!) / allowed : null;
  const state = total ? (compliance! >= target ? 'healthy' : 'breaching') : slo.missingDataPolicy === 'bad' ? 'breaching' : 'unknown';
  const burn = (sample: { good: number; total: number }) => sample.total && allowed > 0 ? (1 - sample.good / sample.total) / allowed : null;
  return { workspaceId, serviceId: slo.serviceId, sloId: slo._id, sloVersion: slo.version, windowStart, windowEnd: now, state, good, total, compliance, remainingBudget: consumption === null ? null : Math.max(0, 1 - consumption), consumption, shortBurnRate: burn(short), longBurnRate: burn(long), breaching: state === 'breaching' };
};
export const storeEvaluation = async (workspaceId: string, slo: InstanceType<typeof ServiceLevelObjectiveModel>, now = new Date()) => {
  const result = await calculateEvaluation(workspaceId, slo, now);
  await SloEvaluationModel.updateOne({ sloId: slo._id, sloVersion: slo.version, windowEnd: now }, { $setOnInsert: result }, { upsert: true });
  return result;
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
  const scheduledAt = monitor.nextRunAt ?? now; const key = createHash('sha256').update(`${monitor.id}:${scheduledAt.toISOString()}`).digest('hex');
  const run = await SyntheticMonitorRunModel.findOneAndUpdate({ monitorId: monitor._id, idempotencyKey: key }, { $setOnInsert: { workspaceId: monitor.workspaceId, serviceId: monitor.serviceId, scheduledAt, startedAt: now }, $set: { status: 'running', leaseOwner }, $inc: { attemptCount: 1 } }, { upsert: true, new: true });
  try {
    const fresh = await SyntheticMonitorModel.findOne({ _id: monitor._id, enabled: true, archivedAt: null, configVersion: monitor.configVersion, leaseOwner, leaseExpiresAt: { $gt: new Date() } }).select('+secretCiphertext +secretKeyVersion');
    if (!fresh) { await SyntheticMonitorRunModel.updateOne({ _id: run._id, status: 'running', leaseOwner }, { $set: { status: 'failed', errorCode: 'MONITOR_CONFIGURATION_CHANGED', completedAt: new Date() }, $unset: { leaseOwner: 1 } }); return true; }
    if (!(await ServiceModel.exists({ workspaceId: fresh.workspaceId, _id: fresh.serviceId, archivedAt: null }))) { await SyntheticMonitorModel.updateOne({ _id: fresh._id, leaseOwner }, { $set: { enabled: false, health: 'unknown' }, $unset: { leaseOwner: 1, leaseExpiresAt: 1 } }); await SyntheticMonitorRunModel.updateOne({ _id: run._id, status: 'running', leaseOwner }, { $set: { status: 'failed', errorCode: 'SERVICE_ARCHIVED', completedAt: new Date() }, $unset: { leaseOwner: 1 } }); return true; }
    const headers = fresh.secretCiphertext ? JSON.parse(decryptSecret({ workspaceId: fresh.workspaceId, _id: fresh._id, keyVersion: fresh.secretKeyVersion!, credentials: fresh.secretCiphertext })) : {};
    let endpointError = false;
    const result = await network({ url: assertSafeMonitorUrl(fresh.url!), method: fresh.method as 'GET' | 'HEAD', timeoutMs: fresh.timeoutMs!, maxRedirects: fresh.maxRedirects!, headers, assertion: fresh.textAssertion ?? undefined }).catch((error) => { if (infrastructureNetworkError(error)) throw error; endpointError = true; return { statusCode: 0, latencyMs: fresh.timeoutMs!, body: '' }; });
    const healthy = !endpointError && result.statusCode >= fresh.expectedStatusMin! && result.statusCode <= fresh.expectedStatusMax! && (!fresh.textAssertion || result.body.includes(fresh.textAssertion));
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        const fenced = await SyntheticMonitorModel.findOne({ _id: fresh._id, enabled: true, archivedAt: null, configVersion: fresh.configVersion, leaseOwner, leaseExpiresAt: { $gt: new Date() } }).session(session);
        if (!fenced) throw new Error('LEASE_LOST');
        const slo = fenced.sloId ? await ServiceLevelObjectiveModel.findOne({ workspaceId: fenced.workspaceId, _id: fenced.sloId, serviceId: fenced.serviceId, enabled: true, archivedAt: null, 'dataSource.type': 'synthetic', $or: [{ 'dataSource.sourceId': { $exists: false } }, { 'dataSource.sourceId': String(fenced._id) }] }).session(session) : null;
        const completed = await SyntheticMonitorRunModel.updateOne({ _id: run._id, status: 'running', leaseOwner }, { $set: { status: 'completed', endpointHealthy: healthy, statusCode: result.statusCode || null, latencyMs: result.latencyMs, errorCode: endpointError ? 'ENDPOINT_UNREACHABLE' : null, completedAt: new Date() }, $unset: { leaseOwner: 1 } }, { session });
        if (!completed.modifiedCount) throw new Error('LEASE_LOST');
        const observationGood = healthy && (!slo || slo.indicatorType !== 'latency' || result.latencyMs <= slo.latencyThresholdMs!);
        if (slo) await SliSampleModel.updateOne({ workspaceId: fenced.workspaceId, idempotencyKey: key }, { $setOnInsert: { serviceId: fenced.serviceId, sloId: slo._id, sloVersion: slo.version, timestamp: now, bucketAt: new Date(Math.floor(now.getTime() / 300000) * 300000), good: observationGood ? 1 : 0, total: 1, latencyMs: [result.latencyMs], source: 'synthetic', sourceId: String(fenced._id), metadata: {}, expiresAt: new Date(now.getTime() + 400 * 86400_000) } }, { upsert: true, session });
        const saved = await SyntheticMonitorModel.updateOne({ _id: fenced._id, leaseOwner }, { $set: { health: healthy ? 'healthy' : 'failed', failureCount: healthy ? 0 : fenced.failureCount + 1, nextRunAt: nextMonitorRunAt(now, fenced.intervalSeconds!) }, $unset: { leaseOwner: 1, leaseExpiresAt: 1 } }, { session });
        if (!saved.modifiedCount) throw new Error('LEASE_LOST');
      });
    } finally { await session.endSession(); }
  } catch {
    await SyntheticMonitorRunModel.updateOne({ _id: run._id, status: 'running', leaseOwner }, { $set: { status: 'failed', errorCode: 'MONITOR_INFRASTRUCTURE_FAILURE', completedAt: new Date() }, $unset: { leaseOwner: 1 } });
    await SyntheticMonitorModel.updateOne({ _id: monitor._id, leaseOwner }, { $set: { health: 'unknown', nextRunAt: new Date(now.getTime() + 60000) }, $unset: { leaseOwner: 1, leaseExpiresAt: 1 } });
  }
  return true;
};

import { Types, type PipelineStage } from 'mongoose';

import { AlertModel, EscalationModel, EscalationDeliveryModel, ScheduleModel } from './models.js';
import { forecastOncall, scheduleContext } from './schedules.js';
type DurationResult = { count: number; meanMs: number; percentiles: number[] };
const summary = (rows: DurationResult[]) => {
  const row = rows[0];
  return {
    count: row?.count ?? 0,
    meanMs: row?.meanMs ?? null,
    p50Ms: row?.percentiles[0] ?? null,
    p95Ms: row?.percentiles[1] ?? null,
  };
};
export const oncallMetrics = async (workspaceId: string, now = new Date()) => {
  const scope = { workspaceId: new Types.ObjectId(workspaceId) };
  const since = new Date(now.getTime() - 30 * 86400000);
  const [
    openBySeverity,
    volume,
    durations,
    counts,
    escalationCount,
    acknowledgedSteps,
    deliveryStates,
    pages,
    schedules,
  ] = await Promise.all([
    AlertModel.aggregate([
      { $match: { ...scope, status: 'open' } },
      { $group: { _id: '$severity', count: { $sum: 1 } } },
    ]),
    AlertModel.aggregate([
      { $match: { ...scope, firstReceivedAt: { $gte: since } } },
      {
        $group: {
          _id: { $dateToString: { date: '$firstReceivedAt', format: '%Y-%m-%d', timezone: 'UTC' } },
          alerts: { $sum: 1 },
          occurrences: { $sum: '$occurrenceCount' },
        },
      },
      { $sort: { _id: 1 } },
    ]),
    Promise.all(
      ['acknowledgedAt', 'resolvedAt'].map((field) =>
        AlertModel.aggregate<DurationResult>([
          {
            $match: {
              ...scope,
              firstReceivedAt: { $gte: since, $lte: now },
              status: { $ne: 'suppressed' },
              [field]: { $type: 'date' },
            },
          },
          {
            $project: { duration: { $max: [0, { $subtract: [`$${field}`, '$firstReceivedAt'] }] } },
          },
          // Mongoose's bundled accumulator types predate MongoDB 7's $percentile.
          {
            $group: {
              _id: null,
              count: { $sum: 1 },
              meanMs: { $avg: '$duration' },
              percentiles: {
                $percentile: { input: '$duration', p: [0.5, 0.95], method: 'approximate' },
              },
            },
          } as unknown as PipelineStage.Group,
        ]),
      ),
    ),
    AlertModel.aggregate([
      { $match: scope },
      {
        $group: {
          _id: null,
          alerts: { $sum: 1 },
          occurrences: { $sum: '$occurrenceCount' },
          suppressed: { $sum: { $cond: [{ $eq: ['$status', 'suppressed'] }, 1, 0] } },
        },
      },
    ]),
    EscalationModel.countDocuments(scope),
    AlertModel.aggregate([
      { $match: { ...scope, acknowledgedAt: { $type: 'date' }, status: { $ne: 'suppressed' } } },
      {
        $group: {
          _id: { policyId: '$escalationPolicyId', step: '$acknowledgedStep' },
          count: { $sum: 1 },
        },
      },
    ]),
    EscalationDeliveryModel.aggregate([
      { $match: scope },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]),
    EscalationDeliveryModel.aggregate([
      { $match: { ...scope, channel: 'notification', status: 'succeeded' } },
      { $unwind: '$recipients' },
      { $group: { _id: '$recipients', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 100 },
    ]),
    ScheduleModel.find({ ...scope, enabled: true, archivedAt: null })
      .select('_id')
      .limit(100),
  ]);
  const from = new Date(Math.floor(now.getTime() / 60000) * 60000),
    to = new Date(from.getTime() + 86400000);
  const coverage = [];
  for (const schedule of schedules) {
    const context = await scheduleContext(workspaceId, schedule.id, from, to);
    if (context) {
      const segments = forecastOncall(context.input, from, to, context.active, context.overrides);
      coverage.push({
        scheduleId: schedule.id,
        gapMinutes: segments
          .filter((s) => s.gap)
          .reduce((n, s) => n + (Date.parse(s.endsAt) - Date.parse(s.startsAt)) / 60000, 0),
      });
    }
  }
  const succeeded = deliveryStates.find((row) => row._id === 'succeeded')?.count ?? 0,
    failed = deliveryStates.find((row) => row._id === 'dead')?.count ?? 0;
  const totals = counts[0] ?? { alerts: 0, occurrences: 0, suppressed: 0 };
  return {
    openBySeverity,
    volume,
    acknowledgement: summary(durations[0]!),
    resolution: summary(durations[1]!),
    escalationCount,
    acknowledgedSteps,
    duplicateOccurrenceRate: totals.occurrences
      ? (totals.occurrences - totals.alerts) / totals.occurrences
      : null,
    deliveryFailureRate: failed + succeeded ? failed / (failed + succeeded) : null,
    pageVolumePerResponder: pages,
    coverage,
    totals,
    durationWindow: {
      from: since.toISOString(),
      to: now.toISOString(),
      percentiles: 'MongoDB approximate percentiles; full cohort, no application sampling',
      excluded: 'suppressed; missing timestamps excluded from respective durations',
    },
  };
};

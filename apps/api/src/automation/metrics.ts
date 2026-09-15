import { Types } from 'mongoose';

import { AutomationRunModel, OutboxEventModel, WebhookDeliveryModel } from './models.js';

export const automationMetrics = async (workspaceId: string, from?: string, to?: string) => {
  const filter = {
    workspaceId: new Types.ObjectId(workspaceId),
    ...(from || to
      ? {
          createdAt: {
            ...(from ? { $gte: new Date(from) } : {}),
            ...(to ? { $lte: new Date(to) } : {}),
          },
        }
      : {}),
  };
  const [[runs], [deliveries], [dead]] = await Promise.all([
    AutomationRunModel.aggregate([
      { $match: filter },
      {
        $facet: {
          byStatus: [{ $group: { _id: '$status', count: { $sum: 1 } } }],
          summary: [
            {
              $group: {
                _id: null,
                retryCount: { $sum: { $max: [0, { $subtract: ['$attemptCount', 1] }] } },
                durationMs: {
                  $avg: {
                    $cond: [
                      {
                        $and: [
                          { $in: ['$status', ['succeeded', 'failed', 'partiallyFailed']] },
                          { $ne: ['$startedAt', null] },
                          { $ne: ['$completedAt', null] },
                        ],
                      },
                      { $subtract: ['$completedAt', '$startedAt'] },
                      null,
                    ],
                  },
                },
                succeeded: { $sum: { $cond: [{ $eq: ['$status', 'succeeded'] }, 1, 0] } },
                failed: {
                  $sum: { $cond: [{ $in: ['$status', ['failed', 'partiallyFailed']] }, 1, 0] },
                },
              },
            },
          ],
          failingRules: [
            { $match: { status: { $in: ['failed', 'partiallyFailed'] } } },
            { $group: { _id: '$ruleId', count: { $sum: 1 } } },
            { $sort: { count: -1, _id: 1 } },
            { $limit: 10 },
          ],
          overTime: [
            {
              $group: {
                _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: 'UTC' } },
                count: { $sum: 1 },
              },
            },
            { $sort: { _id: 1 } },
          ],
        },
      },
    ]),
    WebhookDeliveryModel.aggregate([
      { $match: { ...filter, direction: 'outbound', status: { $in: ['succeeded', 'failed'] } } },
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          succeeded: { $sum: { $cond: [{ $eq: ['$status', 'succeeded'] }, 1, 0] } },
        },
      },
    ]),
    OutboxEventModel.aggregate([{ $match: { ...filter, status: 'dead' } }, { $count: 'count' }]),
  ]);
  const summary = runs?.summary[0] ?? { retryCount: 0, durationMs: null, succeeded: 0, failed: 0 };
  const terminal = summary.succeeded + summary.failed;
  return {
    ...runs,
    summary,
    successRate: terminal ? summary.succeeded / terminal : null,
    failureRate: terminal ? summary.failed / terminal : null,
    deadLetterCount: dead?.count ?? 0,
    webhookSuccessRate: deliveries?.total ? deliveries.succeeded / deliveries.total : null,
  };
};

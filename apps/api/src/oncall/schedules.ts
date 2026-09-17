import {
  type CoverageSegment,
  type ScheduleInput,
  type OverrideInput,
  type RoutingInput,
} from '@flowryn/shared';
import type { ClientSession } from 'mongoose';

import { UserModel } from '../models/User.js';
import { WorkspaceMemberModel } from '../models/WorkspaceMember.js';

import { OverrideModel, ScheduleModel } from './models.js';

const formatters = new Map<string, Intl.DateTimeFormat>();
export const localMinute = (timezone: string, at: Date) => {
  let formatter = formatters.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    if (formatters.size >= 128) formatters.clear();
    formatters.set(timezone, formatter);
  }
  const parts = Object.fromEntries(
    formatter.formatToParts(at).map((part) => [part.type, part.value]),
  );
  return {
    day: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday!),
    minute: Number(parts.hour) * 60 + Number(parts.minute),
  };
};
export const inCoverage = (
  timezone: string,
  coverage: NonNullable<ScheduleInput['layers'][number]['coverage']>,
  at: Date,
) => {
  const local = localMinute(timezone, at);
  return (
    coverage.days.includes(local.day) &&
    local.minute >= coverage.startsMinute &&
    local.minute < coverage.endsMinute
  );
};
export type CalculationOverride = OverrideInput & {
  id: string;
  cancelledAt?: Date | string | null;
};
export const calculateOncall = (
  schedule: ScheduleInput,
  at: Date,
  active: ReadonlySet<string>,
  overrides: CalculationOverride[] = [],
) =>
  schedule.layers.map((layer) => {
    const start = Date.parse(layer.startsAt);
    let userId: string | null = null;
    let overrideId: string | undefined;
    if (
      schedule.enabled &&
      at.getTime() >= start &&
      (!layer.coverage || inCoverage(schedule.timezone, layer.coverage, at))
    ) {
      const index =
        Math.floor((at.getTime() - start) / (layer.shiftMinutes * 60000)) %
        layer.participants.length;
      const original = layer.participants[index]!;
      const override = overrides.find(
        (item) =>
          item.layerId === layer.id &&
          !item.cancelledAt &&
          Date.parse(item.startsAt) <= at.getTime() &&
          Date.parse(item.endsAt) > at.getTime() &&
          (!item.originalUserId || item.originalUserId === original),
      );
      const candidate = override?.replacementUserId ?? original;
      userId = active.has(candidate) ? candidate : null;
      overrideId = override?.id;
    }
    return { layerId: layer.id, userId, ...(overrideId ? { overrideId } : {}) };
  });
export const forecastOncall = (
  schedule: ScheduleInput,
  from: Date,
  to: Date,
  active: ReadonlySet<string>,
  overrides: CalculationOverride[] = [],
): CoverageSegment[] => {
  if (
    from.getTime() % 60000 ||
    to.getTime() % 60000 ||
    to <= from ||
    to.getTime() - from.getTime() > 7 * 86400000
  )
    throw new Error('Invalid forecast range');
  const result: CoverageSegment[] = [];
  let previous = '';
  for (let time = from.getTime(); time < to.getTime(); time += 60000) {
    const layerRecipients = calculateOncall(schedule, new Date(time), active, overrides);
    const key = JSON.stringify(layerRecipients);
    if (key === previous) result[result.length - 1]!.endsAt = new Date(time + 60000).toISOString();
    else {
      result.push({
        startsAt: new Date(time).toISOString(),
        endsAt: new Date(time + 60000).toISOString(),
        layerRecipients,
        gap: layerRecipients.every((layer) => !layer.userId),
      });
      previous = key;
    }
  }
  return result;
};
export const activeMembers = async (
  workspaceId: string,
  ids: string[],
  session?: ClientSession,
) => {
  const unique = [...new Set(ids.map((id) => id.toLowerCase()))];
  const members = await WorkspaceMemberModel.find({
    workspaceId,
    userId: { $in: unique },
    disabled: { $ne: true },
  })
    .select('userId')
    .session(session ?? null);
  const users = await UserModel.find({
    _id: { $in: members.map((member) => member.userId) },
    status: 'active',
  })
    .select('_id')
    .session(session ?? null);
  return new Set(users.map((user) => user.id));
};
export const scheduleContext = async (
  workspaceId: string,
  scheduleId: string,
  from: Date,
  to: Date,
  session?: ClientSession,
) => {
  const schedule = await ScheduleModel.findOne({
    workspaceId,
    _id: scheduleId,
    archivedAt: null,
  }).session(session ?? null);
  if (!schedule) return null;
  const rows = await OverrideModel.find({
    workspaceId,
    scheduleId,
    cancelledAt: null,
    startsAt: { $lt: to },
    endsAt: { $gt: from },
  }).session(session ?? null);
  const overrides = rows.map((row) => ({
    id: row.id,
    layerId: row.layerId,
    startsAt: row.startsAt.toISOString(),
    endsAt: row.endsAt.toISOString(),
    originalUserId: row.originalUserId ? String(row.originalUserId) : undefined,
    replacementUserId: String(row.replacementUserId),
    reason: row.reason ?? '',
  }));
  const input = {
    name: schedule.name,
    description: schedule.description ?? '',
    timezone: schedule.timezone,
    enabled: !!schedule.enabled,
    allowSelfOverrides: !!schedule.allowSelfOverrides,
    layers: schedule.layers,
  } as ScheduleInput;
  const active = await activeMembers(
    workspaceId,
    [
      ...input.layers.flatMap((layer) => layer.participants),
      ...overrides.map((item) => item.replacementUserId),
    ],
    session,
  );
  return { schedule, input, overrides, active };
};
export const matchesRoute = (
  rule: RoutingInput,
  input: {
    severity: string;
    sourceIntegrationId?: string;
    projectId?: string;
    serviceId?: string;
    labels: Record<string, string>;
    linkedIncidentId?: string;
  },
  at: Date,
) =>
  rule.conditions.every((condition) => {
    if (condition.field === 'label') return input.labels[condition.key] === condition.value;
    if (condition.field === 'hasIncident') return !!input.linkedIncidentId === condition.value;
    if (condition.field === 'timeWindow')
      return inCoverage(condition.timezone, condition.coverage, at);
    return input[condition.field] === condition.value;
  });

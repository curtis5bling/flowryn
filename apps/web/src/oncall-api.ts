import type {
  Alert,
  CoverageSegment,
  EscalationDelivery,
  EscalationExecution,
  ScheduleOverride,
} from '@flowryn/shared';

import { request, type Page } from './api';
export const oncallPath = (workspaceId: string) => `/api/workspaces/${workspaceId}/oncall`;
export const oncallList = <T>(
  workspaceId: string,
  resource: string,
  filters: Record<string, string | number> = {},
) =>
  request<Page<T>>(
    `${oncallPath(workspaceId)}/${resource}?${new URLSearchParams(
      Object.entries(filters)
        .filter(([, value]) => value !== '')
        .map(([key, value]) => [key, String(value)]),
    )}`,
  );
export const saveOncall = <T>(
  workspaceId: string,
  resource: string,
  config: unknown,
  existing?: { id: string; version: number },
) =>
  request<{ item: T }>(
    `${oncallPath(workspaceId)}/${resource}${existing ? `/${existing.id}` : ''}`,
    {
      method: existing ? 'PUT' : 'POST',
      body: JSON.stringify(existing ? { version: existing.version, config } : config),
    },
  );
export const oncallCommand = <T = unknown>(workspaceId: string, path: string, body: unknown = {}) =>
  request<T>(`${oncallPath(workspaceId)}/${path}`, { method: 'POST', body: JSON.stringify(body) });
export const getCoverage = (workspaceId: string, id: string, from: string, to: string) =>
  request<{
    timezone: string;
    segments: CoverageSegment[];
    gaps: CoverageSegment[];
    layerGaps: CoverageSegment[];
  }>(`${oncallPath(workspaceId)}/schedules/${id}/upcoming?${new URLSearchParams({ from, to })}`);
export const getAlert = (workspaceId: string, id: string) =>
  request<{ alert: Alert }>(`${oncallPath(workspaceId)}/alerts/${id}`);
export const getEscalationHistory = (workspaceId: string, id: string, page: number) =>
  request<Page<EscalationDelivery> & { executions: EscalationExecution[] }>(
    `${oncallPath(workspaceId)}/alerts/${id}/history?page=${page}`,
  );
export const getOverrides = (workspaceId: string, id: string, page: number) =>
  oncallList<ScheduleOverride>(workspaceId, `schedules/${id}/overrides`, { page });
export type OncallMetrics = {
  openBySeverity: Array<{ _id: string; count: number }>;
  volume: Array<{ _id: string; alerts: number; occurrences: number }>;
  acknowledgement: {
    meanMs: number | null;
    p50Ms: number | null;
    p95Ms: number | null;
    count: number;
  };
  resolution: { meanMs: number | null };
  escalationCount: number;
  duplicateOccurrenceRate: number | null;
  deliveryFailureRate: number | null;
  coverage: Array<{ scheduleId: string; gapMinutes: number }>;
  pageVolumePerResponder: Array<{ _id: string; count: number }>;
  acknowledgedSteps: Array<{ _id: { policyId: string; step: number }; count: number }>;
  totals: { alerts: number; occurrences: number; suppressed: number };
};
export const getOncallMetrics = (workspaceId: string) =>
  request<OncallMetrics>(`${oncallPath(workspaceId)}/metrics`);

import type {
  Incident,
  IncidentCommand,
  IncidentMetrics,
  IncidentTimelineEvent,
  Runbook,
  RunbookInput,
} from '@flowryn/shared';

import { request, type Page } from './api';

export const incidentPath = (workspaceId: string) => `/api/workspaces/${workspaceId}/incidents`;
export const listIncidents = (workspaceId: string, filters: Record<string, string>) =>
  request<Page<Incident>>(
    `${incidentPath(workspaceId)}?${new URLSearchParams(Object.entries(filters).filter(([, value]) => value))}`,
  );
export const getIncident = (workspaceId: string, id: string) =>
  request<{ incident: Incident }>(`${incidentPath(workspaceId)}/${id}`);
export const declareIncident = (workspaceId: string, body: unknown) =>
  request<{ incident: Incident }>(incidentPath(workspaceId), {
    method: 'POST',
    body: JSON.stringify(body),
  });
export const commandIncident = (workspaceId: string, id: string, body: IncidentCommand) =>
  request<{ incident: Incident }>(`${incidentPath(workspaceId)}/${id}/actions`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
export const incidentTimeline = (workspaceId: string, id: string, page: number) =>
  request<Page<IncidentTimelineEvent>>(`${incidentPath(workspaceId)}/${id}/timeline?page=${page}`);
export const incidentMetrics = (workspaceId: string, filters: Record<string, string>) =>
  request<IncidentMetrics>(
    `${incidentPath(workspaceId)}/metrics?${new URLSearchParams(Object.entries(filters).filter(([, value]) => value))}`,
  );
export const incidentPresence = (workspaceId: string, id: string) =>
  request<{ users: Array<{ id: string; name: string }> }>(
    `${incidentPath(workspaceId)}/${id}/presence`,
  );
export const incidentReferences = (workspaceId: string, page = 1) =>
  request<{
    projects: Array<{ _id: string; name: string }>;
    tasks: Array<{ _id: string; title: string }>;
    pages: number;
  }>(`${incidentPath(workspaceId)}/references?page=${page}`);
export const listRunbooks = (workspaceId: string, page = 1) =>
  request<Page<Runbook>>(`/api/workspaces/${workspaceId}/runbooks?page=${page}`);
export const saveRunbook = (workspaceId: string, body: RunbookInput, id?: string) =>
  request<{ runbook: Runbook }>(`/api/workspaces/${workspaceId}/runbooks${id ? `/${id}` : ''}`, {
    method: id ? 'PUT' : 'POST',
    body: JSON.stringify(body),
  });
export const archiveRunbook = (workspaceId: string, id: string) =>
  request(`/api/workspaces/${workspaceId}/runbooks/${id}/archive`, { method: 'POST' });

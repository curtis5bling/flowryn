import { request } from './api';

export type Service = { _id: string; name: string; slug: string; description: string; lifecycle: string; criticality: string; ownerIds: string[] };
export type Slo = { _id: string; serviceId: string; name: string; objectiveTarget: number; rollingWindowDays: number; indicatorType: string; missingDataPolicy: string };
export const listServices = (workspaceId: string, page = 1) => request<{ services: Service[] }>(`/api/workspaces/${workspaceId}/reliability/services?page=${page}&limit=100`);
export const createService = (workspaceId: string, body: unknown) => request<{ service: Service }>(`/api/workspaces/${workspaceId}/reliability/services`, { method: 'POST', body: JSON.stringify(body) });
export const listDependencies = (workspaceId: string) => request<{ dependencies: Array<{ _id: string; upstreamServiceId: string; downstreamServiceId: string; type: string; criticality: string }> }>(`/api/workspaces/${workspaceId}/reliability/dependencies`);
export const createDependency = (workspaceId: string, body: unknown) => request(`/api/workspaces/${workspaceId}/reliability/dependencies`, { method: 'POST', body: JSON.stringify(body) });
export const listSlos = (workspaceId: string) => request<{ slos: Slo[] }>(`/api/workspaces/${workspaceId}/reliability/slos`);
export const createSlo = (workspaceId: string, body: unknown) => request<{ slo: Slo }>(`/api/workspaces/${workspaceId}/reliability/slos`, { method: 'POST', body: JSON.stringify(body) });
export const getEvaluation = (workspaceId: string, sloId: string) => request<{ evaluation: { state: string; compliance: number | null; remainingBudget: number | null; total: number } }>(`/api/workspaces/${workspaceId}/reliability/slos/${sloId}/evaluation`);
export const listMonitors = (workspaceId: string, page = 1) => request<{ monitors: Array<{ _id: string; name: string; url: string; enabled: boolean; health: string }> }>(`/api/workspaces/${workspaceId}/reliability/monitors?page=${page}&limit=100`);
export const createMonitor = (workspaceId: string, body: unknown) => request(`/api/workspaces/${workspaceId}/reliability/monitors`, { method: 'POST', body: JSON.stringify(body) });
export const updateMonitor = (workspaceId: string, monitorId: string, body: unknown) => request(`/api/workspaces/${workspaceId}/reliability/monitors/${monitorId}`, { method: 'PATCH', body: JSON.stringify(body) });
export const getReliabilityMetrics = (workspaceId: string) => request<{ servicesWithoutOwners: number; sloStates: Array<{ _id: string; count: number }>; monitorStates: Array<{ _id: string; count: number }>; notice: string }>(`/api/workspaces/${workspaceId}/reliability/metrics`);

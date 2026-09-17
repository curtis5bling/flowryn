import type { StatusComponentState, StatusPageInput } from '@flowryn/shared';

import { request } from './api';

export type StatusPage = StatusPageInput & {
  _id: string;
  publishedAt?: string | null;
  archivedAt?: string | null;
};
export type PublicSnapshot = {
  page: {
    name: string;
    slug: string;
    description: string;
    branding: { logoUrl: string | null; primaryColor: string };
    supportUrl: string | null;
    timezone: string;
    lastUpdatedAt: string;
  };
  subscriptionsAvailable: boolean;
  overallStatus: StatusComponentState;
  groups: Array<{ id: string; name: string; description: string; order: number }>;
  components: Array<{
    id: string;
    name: string;
    description: string;
    status: StatusComponentState;
    order: number;
    groupId: string | null;
  }>;
  incidents: Array<{
    id: string;
    title: string;
    summary: string;
    impact: string;
    status: string;
    publishedAt: string;
    resolvedAt: string | null;
    updates: Array<{ id: string; status: string; message: string; publishedAt: string }>;
  }>;
  maintenance: Array<{
    id: string;
    title: string;
    description: string;
    status: string;
    scheduledStartAt: string;
    scheduledEndAt: string;
  }>;
};
export const listStatusPages = (workspaceId: string) =>
  request<{ pages: StatusPage[] }>(`/api/workspaces/${workspaceId}/status-pages`);
export const createStatusPage = (workspaceId: string, body: StatusPageInput) =>
  request<{ page: StatusPage }>(`/api/workspaces/${workspaceId}/status-pages`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
export const publishStatusPage = (workspaceId: string, pageId: string) =>
  request<{ page: StatusPage }>(`/api/workspaces/${workspaceId}/status-pages/${pageId}/publish`, {
    method: 'POST',
  });
export type ManagedComponent = { _id: string; name: string; description: string; status: StatusComponentState; hidden: boolean; order: number };
export const getStatusComponents = (workspaceId: string, pageId: string) =>
  request<{ groups: Array<{ _id: string; name: string; order: number }>; components: ManagedComponent[] }>(`/api/workspaces/${workspaceId}/status-pages/${pageId}/components`);
export const setComponentStatus = (workspaceId: string, pageId: string, componentId: string, status: StatusComponentState) =>
  request<{ component: ManagedComponent }>(`/api/workspaces/${workspaceId}/status-pages/${pageId}/components/${componentId}/status`, { method: 'PATCH', body: JSON.stringify({ status }) });
export const getStatusMetrics = (workspaceId: string, pageId: string) =>
  request<{ components: Record<string, number>; subscribers: number; deliverySuccessRate: number | null; publicIncidentsLast365Days: number; meanIncidentDurationMs: number | null; availabilityNotice: string }>(`/api/workspaces/${workspaceId}/status-pages/${pageId}/metrics`);
export const getDeliveryFailures = (workspaceId: string, pageId: string) =>
  request<{ deliveries: Array<{ _id: string; status: string; errorCode: string; attemptCount: number }> }>(`/api/workspaces/${workspaceId}/status-pages/${pageId}/deliveries`);
export const getPublicStatus = (slug: string) =>
  request<PublicSnapshot>(`/api/status/${encodeURIComponent(slug)}`);
export const subscribeStatus = (slug: string, email: string) =>
  request<{ message: string }>(`/api/status/${encodeURIComponent(slug)}/subscribe`, {
    method: 'POST',
    body: JSON.stringify({
      channel: 'email',
      address: email,
      componentIds: [],
      incidents: true,
      maintenance: true,
    }),
  });
export const unsubscribeStatus = (slug: string, token: string) =>
  request<{ message: string }>(`/api/status/${encodeURIComponent(slug)}/unsubscribe`, {
    method: 'POST',
    body: JSON.stringify({ token }),
  });

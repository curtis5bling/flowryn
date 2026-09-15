import type {
  AutomationRule,
  AutomationRuleInput,
  AutomationRun,
  Integration,
  IntegrationInput,
} from '@flowryn/shared';

import { request, type Page } from './api';

export const automationPath = (workspaceId: string) => `/api/workspaces/${workspaceId}/automation`;
export const automationList = <T>(
  workspaceId: string,
  resource: string,
  filters: Record<string, string | number> = {},
) =>
  request<Page<T>>(
    `${automationPath(workspaceId)}/${resource}?${new URLSearchParams(Object.entries(filters).map(([key, value]) => [key, String(value)]))}`,
  );
export const saveAutomationRule = (
  workspaceId: string,
  rule: AutomationRuleInput,
  existing?: AutomationRule,
) =>
  request<{ rule: AutomationRule }>(
    `${automationPath(workspaceId)}/rules${existing ? `/${existing.id}` : ''}`,
    {
      method: existing ? 'PUT' : 'POST',
      body: JSON.stringify(existing ? { version: existing.version, rule } : rule),
    },
  );
export const automationCommand = <T = unknown>(
  workspaceId: string,
  path: string,
  body: unknown = {},
) =>
  request<T>(`${automationPath(workspaceId)}/${path}`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
export const getAutomationRun = (workspaceId: string, id: string) =>
  request<{ run: AutomationRun }>(`${automationPath(workspaceId)}/runs/${id}`);
export const saveIntegration = (
  workspaceId: string,
  input: IntegrationInput,
  existing?: Integration,
) =>
  request<{ integration: Integration; secret?: string }>(
    `${automationPath(workspaceId)}/integrations${existing ? `/${existing.id}` : ''}`,
    { method: existing ? 'PUT' : 'POST', body: JSON.stringify(input) },
  );
export type AutomationMetrics = {
  byStatus: Array<{ _id: string; count: number }>;
  summary: { durationMs: number | null; retryCount: number };
  successRate: number | null;
  failureRate: number | null;
  deadLetterCount: number;
  webhookSuccessRate: number | null;
  failingRules: Array<{ _id: string; count: number }>;
  overTime: Array<{ _id: string; count: number }>;
};
export const getAutomationMetrics = (workspaceId: string) =>
  request<AutomationMetrics>(`${automationPath(workspaceId)}/metrics`);

import {
  automationFieldSchema,
  automationLimits,
  automationRuleSchema,
  automationRunStatusSchema,
  automationTriggerSchema,
  type AutomationAction,
  type AutomationCondition,
  type AutomationRule,
  type AutomationRuleInput,
  type AutomationRun,
  type Integration,
  type IntegrationInput,
} from '@flowryn/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import { listMembers, listProjects } from '../api';
import {
  automationCommand,
  automationList,
  getAutomationMetrics,
  getAutomationRun,
  saveAutomationRule,
  saveIntegration,
} from '../automation-api';
import { incidentReferences, listIncidents, listRunbooks } from '../incidents-api';
import { bindRealtime, connectRealtime, type ConnectionState } from '../realtime';

type References = {
  projects: Array<{ id: string; name: string }>;
  members: Array<{ id: string; name: string }>;
  runbooks: Array<{ id: string; name: string }>;
  integrations: Integration[];
};
const actionNames: AutomationAction['type'][] = [
  'incident.timeline',
  'task.create',
  'task.update',
  'task.assign',
  'notification.send',
  'incident.runbook',
  'incident.severity',
  'incident.transition',
  'webhook.invoke',
  'incident.declare',
];
const newAction = (type: AutomationAction['type']): AutomationAction => {
  const id = crypto.randomUUID();
  switch (type) {
    case 'incident.timeline':
      return { id, type, message: '' };
    case 'task.create':
      return { id, type, projectId: '', title: '' };
    case 'task.update':
      return { id, type, field: 'status', value: 'todo' };
    case 'task.assign':
      return { id, type, userId: '' };
    case 'notification.send':
      return { id, type, userId: '', title: '' };
    case 'incident.runbook':
      return { id, type, runbookId: '' };
    case 'incident.severity':
      return { id, type, severity: 'sev3' };
    case 'incident.transition':
      return { id, type, status: 'investigating' };
    case 'webhook.invoke':
      return { id, type, integrationId: '' };
    case 'incident.declare':
      return { id, type, title: '', severity: 'sev3' };
  }
};
const freshRule = (): AutomationRuleInput => ({
  name: '',
  description: '',
  enabled: false,
  triggerType: 'automation.manual',
  triggerVersion: 1,
  conditions: { mode: 'all', children: [] },
  actions: [newAction('incident.timeline')],
});
function SelectReference({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: Array<{ id: string; name: string }>;
  onChange: (value: string) => void;
}) {
  return (
    <label>
      {label}
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">Choose {label.toLowerCase()}</option>
        {options.map((option) => (
          <option key={option.id} value={option.id}>
            {option.name}
          </option>
        ))}
      </select>
    </label>
  );
}
export function ConditionBuilder({
  value,
  onChange,
  depth = 1,
  references,
}: {
  value: AutomationCondition;
  onChange: (condition: AutomationCondition) => void;
  depth?: number;
  references?: References;
}) {
  const choices =
    'field' in value
      ? value.field === 'projectId'
        ? references?.projects
        : value.field === 'integrationId'
          ? references?.integrations
          : ['actorId', 'commanderId', 'responderIds', 'assigneeId'].includes(value.field)
            ? references?.members
            : (value.field === 'incident.severity'
                ? ['sev1', 'sev2', 'sev3', 'sev4']
                : value.field === 'incident.status'
                  ? ['declared', 'investigating', 'identified', 'monitoring', 'resolved']
                  : value.field === 'task.status'
                    ? ['backlog', 'todo', 'in_progress', 'review', 'done']
                    : []
              ).map((id) => ({ id, name: id }))
      : [];
  if ('field' in value)
    return (
      <fieldset>
        <legend>Condition</legend>
        <label>
          Field
          <select
            value={value.field}
            onChange={(e) =>
              onChange({ ...value, field: e.target.value as typeof value.field, values: [''] })
            }
          >
            {automationFieldSchema.options.map((field) => (
              <option key={field}>{field}</option>
            ))}
          </select>
        </label>
        <label>
          Comparison
          <select
            value={value.operator}
            onChange={(e) => onChange({ ...value, operator: e.target.value as 'eq' | 'in' })}
          >
            <option value="eq">Equals</option>
            <option value="in">Is one of</option>
          </select>
        </label>
        <label>
          Values (comma separated)
          <input
            value={value.values.join(',')}
            onChange={(e) =>
              onChange({
                ...value,
                values: e.target.value
                  .split(',')
                  .map((v) =>
                    value.field === 'incident.ageMinutes'
                      ? Number(v.trim())
                      : v.trim() === 'null'
                        ? null
                        : v.trim(),
                  ),
              })
            }
          />
        </label>
        {choices?.length ? (
          <label>
            Choose condition value
            <select
              value=""
              onChange={(event) => {
                if (event.target.value)
                  onChange({
                    ...value,
                    values:
                      value.operator === 'eq'
                        ? [event.target.value]
                        : [
                            ...new Set([
                              ...value.values.filter((v) => v !== ''),
                              event.target.value,
                            ]),
                          ],
                  });
              }}
            >
              <option value="">Choose a value</option>
              {choices.map((choice) => (
                <option key={choice.id} value={choice.id}>
                  {choice.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <button
          type="button"
          disabled={depth >= automationLimits.depth}
          onClick={() => onChange({ mode: 'all', children: [] })}
        >
          Replace with group
        </button>
      </fieldset>
    );
  return (
    <fieldset>
      <legend>Condition group</legend>
      <label>
        Match
        <select
          value={value.mode}
          onChange={(e) => onChange({ ...value, mode: e.target.value as 'all' | 'any' })}
        >
          <option value="all">All conditions</option>
          <option value="any">Any condition</option>
        </select>
      </label>
      {value.children.map((child, index) => (
        <div key={index}>
          <ConditionBuilder
            depth={depth + 1}
            references={references}
            value={child}
            onChange={(updated) =>
              onChange({
                ...value,
                children: value.children.map((old, n) => (n === index ? updated : old)),
              })
            }
          />
          <button
            type="button"
            onClick={() =>
              onChange({ ...value, children: value.children.filter((_, n) => n !== index) })
            }
          >
            Remove condition {index + 1}
          </button>
        </div>
      ))}
      <button
        type="button"
        disabled={depth >= automationLimits.depth || value.children.length >= 31}
        onClick={() =>
          onChange({
            ...value,
            children: [
              ...value.children,
              { field: 'incident.severity', operator: 'eq', values: ['sev3'] },
            ],
          })
        }
      >
        Add condition
      </button>
      {depth < automationLimits.depth - 1 && (
        <button
          type="button"
          onClick={() =>
            onChange({ ...value, children: [...value.children, { mode: 'all', children: [] }] })
          }
        >
          Add group
        </button>
      )}
    </fieldset>
  );
}
function ActionFields({
  action,
  references,
  onChange,
}: {
  action: AutomationAction;
  references: References;
  onChange: (action: AutomationAction) => void;
}) {
  const change = (fields: object) => onChange({ ...action, ...fields });
  return (
    <>
      {'message' in action && (
        <label>
          Timeline message
          <textarea
            maxLength={4000}
            value={action.message}
            onChange={(e) => change({ message: e.target.value })}
          />
        </label>
      )}
      {'title' in action && (
        <label>
          Title
          <input
            maxLength={action.type === 'notification.send' ? 240 : 200}
            value={action.title}
            onChange={(e) => change({ title: e.target.value })}
          />
        </label>
      )}
      {'projectId' in action && (
        <SelectReference
          label="Project"
          options={references.projects}
          value={action.projectId}
          onChange={(projectId) => change({ projectId })}
        />
      )}
      {'userId' in action && (
        <SelectReference
          label="Recipient or assignee"
          options={references.members}
          value={action.userId}
          onChange={(userId) => change({ userId })}
        />
      )}
      {action.type === 'task.create' && (
        <SelectReference
          label="Optional task assignee"
          options={references.members}
          value={action.assigneeId ?? ''}
          onChange={(assigneeId) => change({ assigneeId: assigneeId || null })}
        />
      )}
      {'runbookId' in action && (
        <SelectReference
          label="Runbook"
          options={references.runbooks}
          value={action.runbookId}
          onChange={(runbookId) => change({ runbookId })}
        />
      )}
      {'integrationId' in action && (
        <SelectReference
          label="Outbound integration"
          options={references.integrations}
          value={action.integrationId}
          onChange={(integrationId) => change({ integrationId })}
        />
      )}
      {'severity' in action && (
        <label>
          Severity
          <select value={action.severity} onChange={(e) => change({ severity: e.target.value })}>
            {['sev1', 'sev2', 'sev3', 'sev4'].map((v) => (
              <option key={v}>{v}</option>
            ))}
          </select>
        </label>
      )}
      {action.type === 'incident.transition' && (
        <>
          <label>
            Incident status
            <select value={action.status} onChange={(e) => change({ status: e.target.value })}>
              {['investigating', 'identified', 'monitoring', 'resolved'].map((v) => (
                <option key={v}>{v}</option>
              ))}
            </select>
          </label>
          {action.status === 'resolved' && (
            <label>
              Resolution summary
              <textarea
                value={action.resolutionSummary ?? ''}
                onChange={(e) => change({ resolutionSummary: e.target.value })}
                required
                maxLength={4000}
              />
            </label>
          )}
        </>
      )}
      {action.type === 'task.update' && (
        <>
          <label>
            Task field
            <select
              value={action.field}
              onChange={(e) =>
                change({
                  field: e.target.value,
                  value:
                    e.target.value === 'status'
                      ? 'todo'
                      : e.target.value === 'priority'
                        ? 'medium'
                        : '',
                })
              }
            >
              {['status', 'priority', 'title'].map((v) => (
                <option key={v}>{v}</option>
              ))}
            </select>
          </label>
          {action.field === 'title' ? (
            <label>
              New task title
              <input value={action.value} onChange={(e) => change({ value: e.target.value })} />
            </label>
          ) : (
            <label>
              New value
              <select value={action.value} onChange={(e) => change({ value: e.target.value })}>
                {(action.field === 'status'
                  ? ['backlog', 'todo', 'in_progress', 'review', 'done']
                  : ['low', 'medium', 'high', 'urgent']
                ).map((v) => (
                  <option key={v}>{v}</option>
                ))}
              </select>
            </label>
          )}
        </>
      )}
    </>
  );
}
export function RuleEditor({
  existing,
  references,
  onSave,
  onClose,
  pending,
}: {
  existing?: AutomationRule;
  references: References;
  onSave: (input: AutomationRuleInput) => void;
  onClose: () => void;
  pending: boolean;
}) {
  const [rule, setRule] = useState<AutomationRuleInput>(() =>
    existing
      ? {
          name: existing.name,
          description: existing.description,
          enabled: existing.enabled,
          triggerType: existing.triggerType,
          triggerVersion: 1,
          conditions: existing.conditions,
          actions: existing.actions,
          inboundIntegrationId: existing.inboundIntegrationId,
        }
      : freshRule(),
  );
  const [preview, setPreview] = useState('');
  const parsed = automationRuleSchema.safeParse(rule);
  return (
    <section className="automation-panel">
      <h2>{existing ? 'Edit rule' : 'Create rule'}</h2>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (parsed.success) onSave(parsed.data);
          else setPreview(parsed.error.issues.map((i) => i.message).join('; '));
        }}
      >
        <label>
          Rule name
          <input
            required
            maxLength={200}
            value={rule.name}
            onChange={(e) => setRule({ ...rule, name: e.target.value })}
          />
        </label>
        <label>
          Description
          <textarea
            maxLength={2000}
            value={rule.description}
            onChange={(e) => setRule({ ...rule, description: e.target.value })}
          />
        </label>
        <label>
          Trigger
          <select
            value={rule.triggerType}
            onChange={(e) =>
              setRule({
                ...rule,
                triggerType: e.target.value as AutomationRuleInput['triggerType'],
                inboundIntegrationId: undefined,
              })
            }
          >
            {automationTriggerSchema.options.map((type) => (
              <option key={type}>{type}</option>
            ))}
          </select>
        </label>
        {rule.triggerType === 'automation.manual' && (
          <SelectReference
            label="Optional inbound integration"
            options={references.integrations.filter((i) => i.inboundEvents.length)}
            value={rule.inboundIntegrationId ?? ''}
            onChange={(inboundIntegrationId) =>
              setRule({ ...rule, inboundIntegrationId: inboundIntegrationId || undefined })
            }
          />
        )}
        <ConditionBuilder
          value={rule.conditions}
          references={references}
          onChange={(conditions) => setRule({ ...rule, conditions })}
        />
        <h3>Ordered actions</h3>
        <p role="note">
          These actions can change incidents, assign users, create tasks, send private
          notifications, and call external endpoints. Review every action before enabling.
        </p>
        {rule.actions.map((action, index) => (
          <fieldset key={action.id}>
            <legend>Action {index + 1}</legend>
            <label>
              Action type
              <select
                value={action.type}
                onChange={(e) => {
                  const replacement = {
                    ...newAction(e.target.value as AutomationAction['type']),
                    id: action.id,
                  };
                  setRule({
                    ...rule,
                    actions: rule.actions.map((a, n) => (n === index ? replacement : a)),
                  });
                }}
              >
                {actionNames.map((type) => (
                  <option key={type}>{type}</option>
                ))}
              </select>
            </label>
            <ActionFields
              action={action}
              references={references}
              onChange={(updated) =>
                setRule({
                  ...rule,
                  actions: rule.actions.map((a, n) => (n === index ? updated : a)),
                })
              }
            />
            {(['up', 'down'] as const).map((direction) => (
              <button
                key={direction}
                type="button"
                aria-label={`Move action ${index + 1} ${direction}`}
                disabled={direction === 'up' ? index === 0 : index === rule.actions.length - 1}
                onClick={() => {
                  const actions = [...rule.actions];
                  const target = index + (direction === 'up' ? -1 : 1);
                  [actions[index], actions[target]] = [actions[target]!, actions[index]!];
                  setRule({ ...rule, actions });
                }}
              >
                {direction === 'up' ? 'Move up' : 'Move down'}
              </button>
            ))}
            <button
              type="button"
              disabled={rule.actions.length === 1}
              onClick={() =>
                setRule({ ...rule, actions: rule.actions.filter((a) => a.id !== action.id) })
              }
            >
              Remove action {index + 1}
            </button>
          </fieldset>
        ))}
        <button
          type="button"
          disabled={rule.actions.length >= automationLimits.actions}
          onClick={() =>
            setRule({ ...rule, actions: [...rule.actions, newAction('incident.timeline')] })
          }
        >
          Add action
        </button>
        <label>
          <input
            type="checkbox"
            checked={rule.enabled}
            onChange={(e) => setRule({ ...rule, enabled: e.target.checked })}
          />{' '}
          Enable rule after saving
        </label>
        <button
          type="button"
          onClick={() =>
            setPreview(
              parsed.success
                ? 'Rule structure is valid. Save and use dry-run to check workspace references and conditions.'
                : parsed.error.issues.map((i) => i.message).join('; '),
            )
          }
        >
          Validate preview
        </button>
        <p role="status">{preview}</p>
        <button disabled={pending} className="primary-button">
          {pending ? 'Saving…' : 'Save rule'}
        </button>
        <button type="button" onClick={onClose}>
          Close editor
        </button>
      </form>
    </section>
  );
}
export function IntegrationEditor({
  existing,
  onSave,
  onClose,
  pending,
}: {
  existing?: Integration;
  onSave: (input: IntegrationInput) => void;
  onClose: () => void;
  pending: boolean;
}) {
  const [input, setInput] = useState<IntegrationInput>(() => ({
    name: existing?.name ?? '',
    type: 'genericWebhook',
    status: existing?.status ?? 'active',
    endpoint: existing?.endpoint ?? '',
    inboundEvents: existing?.inboundEvents ?? [],
    outboundEvents: existing?.outboundEvents ?? [],
  }));
  return (
    <section className="automation-panel">
      <h2>{existing ? 'Edit integration' : 'Set up integration'}</h2>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSave({ ...input, endpoint: input.endpoint || undefined });
        }}
      >
        <label>
          Integration name
          <input
            required
            value={input.name}
            maxLength={200}
            onChange={(e) => setInput({ ...input, name: e.target.value })}
          />
        </label>
        <label>
          Outbound HTTPS endpoint
          <input
            type="url"
            value={input.endpoint ?? ''}
            onChange={(e) => setInput({ ...input, endpoint: e.target.value })}
          />
        </label>
        <p>
          Only public HTTPS destinations on port 443 are allowed. Query strings, URL credentials,
          and redirects are rejected.
        </p>
        <label>
          Status
          <select
            value={input.status}
            onChange={(e) =>
              setInput({ ...input, status: e.target.value as IntegrationInput['status'] })
            }
          >
            <option value="active">Active</option>
            <option value="disabled">Disabled</option>
          </select>
        </label>
        <label>
          <input
            type="checkbox"
            checked={input.inboundEvents.length > 0}
            onChange={(e) =>
              setInput({ ...input, inboundEvents: e.target.checked ? ['alert.received'] : [] })
            }
          />{' '}
          Accept signed alerts through explicitly configured rules
        </label>
        <fieldset>
          <legend>Allowed outbound events</legend>
          {automationTriggerSchema.options.map((type) => (
            <label key={type}>
              <input
                type="checkbox"
                checked={input.outboundEvents.includes(type)}
                onChange={(e) =>
                  setInput({
                    ...input,
                    outboundEvents: e.target.checked
                      ? [...input.outboundEvents, type]
                      : input.outboundEvents.filter((v) => v !== type),
                  })
                }
              />
              {type}
            </label>
          ))}
        </fieldset>
        <p role="note">
          External endpoints receive a signed, bounded event snapshot. A new secret is shown once
          after creation or rotation.
        </p>
        <button disabled={pending} className="primary-button">
          Save integration
        </button>
        <button type="button" onClick={onClose}>
          Close setup
        </button>
      </form>
    </section>
  );
}
function Pagination({
  page,
  pages,
  onChange,
}: {
  page: number;
  pages?: number;
  onChange: (page: number) => void;
}) {
  return (
    <nav aria-label="Pagination">
      <button disabled={page <= 1} onClick={() => onChange(page - 1)}>
        Previous page
      </button>
      <span>
        {' '}
        Page {page} of {Math.max(1, pages ?? 1)}{' '}
      </span>
      <button disabled={page >= (pages ?? 1)} onClick={() => onChange(page + 1)}>
        Next page
      </button>
    </nav>
  );
}
export function AutomationApp({
  workspaceId,
  workspaceName,
  role,
  onLogout,
}: {
  workspaceId: string;
  workspaceName: string;
  role: string;
  onLogout: () => void;
}) {
  const client = useQueryClient();
  const admin = role === 'owner' || role === 'admin';
  const [state, setState] = useState<ConnectionState>('connecting');
  const [tab, setTab] = useState<'rules' | 'runs' | 'integrations' | 'dead-letters' | 'metrics'>(
    'rules',
  );
  const [page, setPage] = useState(1);
  const [referencePage, setReferencePage] = useState(1);
  const [archived, setArchived] = useState(false);
  const [status, setStatus] = useState('');
  const [ruleFilter, setRuleFilter] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [editor, setEditor] = useState<AutomationRule | 'new'>();
  const [integrationEditor, setIntegrationEditor] = useState<Integration | 'new'>();
  const [selectedRun, setSelectedRun] = useState('');
  const [selectedIntegration, setSelectedIntegration] = useState('');
  const [secret, setSecret] = useState('');
  const [confirm, setConfirm] = useState<{ path: string; label: string }>();
  const [previewRule, setPreviewRule] = useState<AutomationRule>();
  const [targetIncident, setTargetIncident] = useState('');
  const [targetTask, setTargetTask] = useState('');
  const [operationId, setOperationId] = useState(() => crypto.randomUUID());
  const [notice, setNotice] = useState('');
  const [dryRunResults, setDryRunResults] = useState<
    Array<{ id: string; type: string; status: string; reason?: string }>
  >([]);
  useEffect(
    () => bindRealtime(connectRealtime(), workspaceId, undefined, client, setState),
    [workspaceId, client],
  );
  const filters = {
    page,
    ...(archived ? { archived: 'true' } : {}),
    ...(status ? { status } : {}),
    ...(ruleFilter ? { ruleId: ruleFilter } : {}),
    ...(from ? { from: new Date(from).toISOString() } : {}),
    ...(to ? { to: new Date(to).toISOString() } : {}),
  };
  const rules = useQuery({
    queryKey: ['automation-rules', workspaceId, page, archived],
    queryFn: () =>
      automationList<AutomationRule>(workspaceId, 'rules', { page, archived: String(archived) }),
    refetchInterval: 15000,
  });
  const runs = useQuery({
    queryKey: ['automation-runs', workspaceId, filters],
    queryFn: () => automationList<AutomationRun>(workspaceId, 'runs', filters),
    enabled: admin && tab === 'runs',
    refetchInterval: 15000,
  });
  const integrations = useQuery({
    queryKey: ['automation-integrations', workspaceId, page, archived],
    queryFn: () =>
      automationList<Integration>(workspaceId, 'integrations', {
        page,
        archived: String(archived),
      }),
    enabled: admin,
    refetchInterval: 15000,
  });
  const dead = useQuery({
    queryKey: ['automation-dead-letters', workspaceId, page],
    queryFn: () =>
      automationList<{ id: string; eventType: string; error: string }>(
        workspaceId,
        'dead-letters',
        { page },
      ),
    enabled: admin && tab === 'dead-letters',
    refetchInterval: 15000,
  });
  const metrics = useQuery({
    queryKey: ['automation-metrics', workspaceId],
    queryFn: () => getAutomationMetrics(workspaceId),
    enabled: admin && tab === 'metrics',
    refetchInterval: 15000,
  });
  const detail = useQuery({
    queryKey: ['automation-run', workspaceId, selectedRun],
    queryFn: () => getAutomationRun(workspaceId, selectedRun),
    enabled: admin && Boolean(selectedRun),
    refetchInterval: 15000,
  });
  const deliveries = useQuery({
    queryKey: ['automation-deliveries', workspaceId, selectedIntegration, page],
    queryFn: () =>
      automationList<{
        id: string;
        direction: string;
        status: string;
        error?: string;
        attemptCount: number;
      }>(workspaceId, `integrations/${selectedIntegration}/deliveries`, { page }),
    enabled: admin && Boolean(selectedIntegration),
    refetchInterval: 15000,
  });
  const projects = useQuery({
    queryKey: ['projects', workspaceId, 'automation-references', referencePage],
    queryFn: () => listProjects(workspaceId, referencePage),
    enabled: admin,
  });
  const members = useQuery({
    queryKey: ['members', workspaceId],
    queryFn: () => listMembers(workspaceId),
    enabled: admin,
  });
  const books = useQuery({
    queryKey: ['runbooks', workspaceId, referencePage],
    queryFn: () => listRunbooks(workspaceId, referencePage),
    enabled: admin,
  });
  const incidents = useQuery({
    queryKey: ['incidents', workspaceId, 'automation-targets', referencePage],
    queryFn: () => listIncidents(workspaceId, { page: String(referencePage), limit: '100' }),
    enabled: Boolean(previewRule),
  });
  const work = useQuery({
    queryKey: ['incident-references', workspaceId, referencePage],
    queryFn: () => incidentReferences(workspaceId, referencePage),
    enabled: Boolean(previewRule),
  });
  const integrationReferences = useQuery({
    queryKey: ['automation-integrations', workspaceId, 'references', referencePage],
    queryFn: () =>
      automationList<Integration>(workspaceId, 'integrations', { page: referencePage, limit: 100 }),
    enabled: admin && Boolean(editor),
  });
  const refresh = () => {
    for (const key of [
      'automation-rules',
      'automation-runs',
      'automation-run',
      'automation-integrations',
      'automation-deliveries',
      'automation-dead-letters',
      'automation-metrics',
    ])
      void client.invalidateQueries({ queryKey: [key, workspaceId] });
  };
  const saveRule = useMutation({
    mutationFn: (input: AutomationRuleInput) =>
      saveAutomationRule(workspaceId, input, editor === 'new' ? undefined : editor),
    onSuccess: () => {
      setEditor(undefined);
      setNotice('Rule saved');
      refresh();
    },
  });
  const saveConnection = useMutation({
    mutationFn: (input: IntegrationInput) =>
      saveIntegration(
        workspaceId,
        input,
        integrationEditor === 'new' ? undefined : integrationEditor,
      ),
    onSuccess: (data) => {
      setIntegrationEditor(undefined);
      setSecret(data.secret ?? '');
      setNotice('Integration saved');
      refresh();
    },
  });
  const command = useMutation({
    mutationFn: (input: { path: string; body?: unknown }) =>
      automationCommand<{
        secret?: string;
        matched?: boolean;
        actions?: Array<{ id: string; type: string; status: string; reason?: string }>;
      }>(workspaceId, input.path, input.body ?? {}),
    onSuccess: (data, input) => {
      if (data.secret) setSecret(data.secret);
      if (input.path.endsWith('dry-run')) setDryRunResults(data.actions ?? []);
      setConfirm(undefined);
      setNotice(
        input.path.endsWith('dry-run')
          ? `Dry-run: ${data.matched ? 'conditions matched' : 'conditions did not match'}. No actions executed.`
          : 'Request accepted',
      );
      if (input.path.endsWith('/execute')) setOperationId(crypto.randomUUID());
      refresh();
    },
  });
  const references: References = {
    projects: projects.data?.items ?? [],
    members: members.data?.members.map((m) => ({ id: m.user._id, name: m.user.name })) ?? [],
    runbooks: books.data?.items.filter((b) => b.status === 'active') ?? [],
    integrations:
      (integrationReferences.data?.items ?? integrations.data?.items)?.filter(
        (i) => i.status === 'active' && !i.archivedAt,
      ) ?? [],
  };
  const activeQuery =
    tab === 'rules'
      ? rules
      : tab === 'runs'
        ? runs
        : tab === 'integrations'
          ? integrations
          : tab === 'dead-letters'
            ? dead
            : metrics;
  return (
    <main className="automation-page">
      <header>
        <div className="brand">flowryn</div>
        <h1>Automation · {workspaceName}</h1>
        <button onClick={onLogout}>Sign out</button>
      </header>
      <p role="status" aria-live="polite">
        {state === 'connected'
          ? 'Connected — automation data is current'
          : state === 'reconnecting' || state === 'connecting'
            ? 'Reconnecting — REST refresh remains active'
            : 'Offline — automation data may be delayed'}{' '}
        {notice}
      </p>
      <nav aria-label="Automation views">
        {(['rules', 'runs', 'integrations', 'dead-letters', 'metrics'] as const)
          .filter((t) => admin || t === 'rules')
          .map((t) => (
            <button
              key={t}
              aria-pressed={tab === t}
              onClick={() => {
                setTab(t);
                setPage(1);
                setSelectedIntegration('');
                setSelectedRun('');
              }}
            >
              {t.replace('-', ' ')}
            </button>
          ))}
      </nav>
      {!admin && (
        <p>
          Members can view rule state. Owners and admins manage rules, executions, and integrations.
        </p>
      )}
      {activeQuery.isLoading && <p role="status">Loading automation…</p>}
      {activeQuery.error && (
        <p role="alert">
          {activeQuery.error.message}
          <button onClick={() => void activeQuery.refetch()}>Retry loading</button>
        </p>
      )}
      {[saveRule.error, saveConnection.error, command.error, detail.error, deliveries.error]
        .filter(Boolean)
        .map((error, index) => (
          <p key={index} role="alert">
            {error?.message}
          </p>
        ))}
      {(tab === 'rules' || tab === 'integrations') && (
        <label>
          <input
            type="checkbox"
            checked={archived}
            onChange={(e) => {
              setArchived(e.target.checked);
              setPage(1);
            }}
          />{' '}
          Show archived
        </label>
      )}
      {tab === 'rules' && (
        <>
          <h2>Rules</h2>
          {admin && <button onClick={() => setEditor('new')}>Create rule</button>}
          {rules.data?.items.length === 0 && <p>No automation rules yet.</p>}
          {rules.data?.items.map((rule) => (
            <article className="automation-panel" key={rule.id}>
              <h3>{rule.name}</h3>
              <p>
                {rule.archivedAt ? 'Archived' : rule.enabled ? 'Enabled' : 'Disabled'} ·{' '}
                {rule.health === 'healthy'
                  ? 'Healthy'
                  : rule.health === 'failing'
                    ? 'Failing'
                    : rule.health === 'pending'
                      ? 'Latest execution pending or skipped'
                      : 'Never executed'}{' '}
                · Version {rule.version} · {rule.triggerType}
              </p>
              <p>{rule.description}</p>
              {admin && !rule.archivedAt && (
                <>
                  <button onClick={() => setEditor(rule)}>Edit rule</button>
                  <button
                    onClick={() => {
                      setPreviewRule(rule);
                      setTargetIncident('');
                      setTargetTask('');
                      setOperationId(crypto.randomUUID());
                    }}
                  >
                    Dry-run / manual execution
                  </button>
                  <button
                    onClick={() =>
                      setConfirm({
                        path: `rules/${rule.id}/${rule.enabled ? 'disable' : 'enable'}`,
                        label: `${rule.enabled ? 'Disable' : 'Enable'} ${rule.name}? Enabling allows all configured effects.`,
                      })
                    }
                  >
                    {rule.enabled ? 'Disable' : 'Enable'}
                  </button>
                  <button
                    onClick={() =>
                      setConfirm({
                        path: `rules/${rule.id}/archive`,
                        label: `Archive ${rule.name}? Existing snapshotted runs remain eligible.`,
                      })
                    }
                  >
                    Archive rule
                  </button>
                </>
              )}
            </article>
          ))}
          <Pagination page={page} pages={rules.data?.pagination.pages} onChange={setPage} />
        </>
      )}
      {(editor || previewRule) && (
        <section aria-label="Available references">
          <p>
            Browse reference pages to choose projects, tasks, incidents, runbooks, and integrations.
          </p>
          <Pagination
            page={referencePage}
            pages={Math.max(
              projects.data?.pagination.pages ?? 1,
              books.data?.pagination.pages ?? 1,
              incidents.data?.pagination.pages ?? 1,
              work.data?.pages ?? 1,
              integrationReferences.data?.pagination.pages ?? 1,
            )}
            onChange={setReferencePage}
          />
          {[
            projects.error,
            members.error,
            books.error,
            incidents.error,
            work.error,
            integrationReferences.error,
          ]
            .filter(Boolean)
            .map((error, index) => (
              <p key={index} role="alert">
                {error?.message}
              </p>
            ))}
        </section>
      )}
      {editor && (
        <RuleEditor
          key={editor === 'new' ? 'new' : `${editor.id}:${editor.version}`}
          existing={editor === 'new' ? undefined : editor}
          references={references}
          pending={saveRule.isPending}
          onSave={(input) => saveRule.mutate(input)}
          onClose={() => setEditor(undefined)}
        />
      )}
      {previewRule && (
        <section className="automation-panel">
          <h2>Evaluate {previewRule.name}</h2>
          {dryRunResults.length > 0 && (
            <ol aria-label="Dry-run action results">
              {dryRunResults.map((action) => (
                <li key={action.id}>
                  {action.type}: {action.status}
                  {action.reason ? ` · ${action.reason}` : ''}
                </li>
              ))}
            </ol>
          )}
          <SelectReference
            label="Optional incident"
            value={targetIncident}
            options={
              incidents.data?.items.map((i) => ({
                id: i.id,
                name: `${i.incidentNumber}: ${i.title}`,
              })) ?? []
            }
            onChange={(value) => {
              setTargetIncident(value);
              setOperationId(crypto.randomUUID());
            }}
          />
          <SelectReference
            label="Optional task"
            value={targetTask}
            options={work.data?.tasks.map((t) => ({ id: t._id, name: t.title })) ?? []}
            onChange={(value) => {
              setTargetTask(value);
              setOperationId(crypto.randomUUID());
            }}
          />
          <button
            disabled={command.isPending}
            onClick={() =>
              command.mutate({
                path: `rules/${previewRule.id}/dry-run`,
                body: {
                  operationId,
                  incidentId: targetIncident || undefined,
                  taskId: targetTask || undefined,
                },
              })
            }
          >
            Run dry-run
          </button>
          {previewRule.triggerType === 'automation.manual' && previewRule.enabled && (
            <button
              disabled={command.isPending}
              onClick={() => {
                if (
                  window.confirm(
                    'Execute every configured action? This can change work and call external endpoints.',
                  )
                )
                  command.mutate({
                    path: `rules/${previewRule.id}/execute`,
                    body: {
                      operationId,
                      incidentId: targetIncident || undefined,
                      taskId: targetTask || undefined,
                    },
                  });
              }}
            >
              Execute rule
            </button>
          )}
          <button onClick={() => setPreviewRule(undefined)}>Close evaluation</button>
        </section>
      )}
      {tab === 'runs' && (
        <>
          <h2>Execution history</h2>
          <label>
            Status
            <select
              value={status}
              onChange={(e) => {
                setStatus(e.target.value);
                setPage(1);
              }}
            >
              <option value="">All statuses</option>
              {automationRunStatusSchema.options.map((v) => (
                <option key={v}>{v}</option>
              ))}
            </select>
          </label>
          <SelectReference
            label="Rule filter"
            value={ruleFilter}
            options={rules.data?.items ?? []}
            onChange={(value) => {
              setRuleFilter(value);
              setPage(1);
            }}
          />
          <label>
            From
            <input
              type="datetime-local"
              value={from}
              onChange={(e) => {
                setFrom(e.target.value);
                setPage(1);
              }}
            />
          </label>
          <label>
            To
            <input
              type="datetime-local"
              value={to}
              onChange={(e) => {
                setTo(e.target.value);
                setPage(1);
              }}
            />
          </label>
          {runs.data?.items.length === 0 && <p>No executions match these filters.</p>}
          {runs.data?.items.map((run) => (
            <article key={run.id} className="automation-panel">
              <p>
                {rules.data?.items.find((r) => r.id === run.ruleId)?.name ?? 'Rule'} · {run.status}{' '}
                · {run.attemptCount} attempts · {new Date(run.createdAt).toLocaleString()}
              </p>
              <button onClick={() => setSelectedRun(run.id)}>Execution details</button>
              {run.status === 'queued' && (
                <button
                  disabled={command.isPending}
                  onClick={() =>
                    setConfirm({ path: `runs/${run.id}/cancel`, label: 'Cancel this queued run?' })
                  }
                >
                  Cancel run
                </button>
              )}
              {['failed', 'partiallyFailed'].includes(run.status) && (
                <button
                  disabled={command.isPending}
                  onClick={() =>
                    setConfirm({
                      path: `runs/${run.id}/retry`,
                      label: 'Retry failed actions? Completed actions will be preserved.',
                    })
                  }
                >
                  Retry run
                </button>
              )}
            </article>
          ))}
          <Pagination page={page} pages={runs.data?.pagination.pages} onChange={setPage} />
        </>
      )}
      {detail.data && selectedRun && (
        <section className="automation-panel">
          <h2>Execution details</h2>
          <p>
            {detail.data.run.status} · Rule version {detail.data.run.ruleVersion}
          </p>
          <p>
            Started:{' '}
            {detail.data.run.startedAt
              ? new Date(detail.data.run.startedAt).toLocaleString()
              : 'Not started'}{' '}
            · Completed:{' '}
            {detail.data.run.completedAt
              ? new Date(detail.data.run.completedAt).toLocaleString()
              : 'Not completed'}{' '}
            · Attempts: {detail.data.run.attemptCount}
          </p>
          {detail.data.run.error && <p role="alert">{detail.data.run.error}</p>}
          <ol>
            {detail.data.run.actionResults.map((action, index) => (
              <li key={action.id}>
                Action {index + 1}: {action.status}
                {action.error && ` · ${action.error}`}
              </li>
            ))}
          </ol>
          <button onClick={() => setSelectedRun('')}>Close execution</button>
        </section>
      )}
      {tab === 'integrations' && (
        <>
          <h2>Integrations</h2>
          <button
            onClick={() => {
              setSecret('');
              setIntegrationEditor('new');
            }}
          >
            Set up integration
          </button>
          {integrations.data?.items.length === 0 && <p>No integrations yet.</p>}
          {integrations.data?.items.map((integration) => (
            <article key={integration.id} className="automation-panel">
              <h3>{integration.name}</h3>
              <p>
                {integration.archivedAt ? 'Archived' : integration.status} ·{' '}
                {integration.lastDeliveryStatus === 'failed'
                  ? 'Failing'
                  : integration.lastDeliveryStatus === 'succeeded'
                    ? 'Healthy'
                    : 'No delivery yet'}
              </p>
              <p>{integration.endpoint}</p>
              {integration.inboundEvents.length > 0 && (
                <label>
                  Inbound webhook URL
                  <input
                    readOnly
                    value={`${import.meta.env.VITE_API_URL ?? 'http://localhost:4000'}/api/webhooks/${workspaceId}/${integration.id}`}
                  />
                </label>
              )}
              <button
                onClick={() => {
                  setSelectedIntegration(integration.id);
                  setPage(1);
                }}
              >
                Delivery history
              </button>
              {!integration.archivedAt && (
                <>
                  <button onClick={() => setIntegrationEditor(integration)}>
                    Edit integration
                  </button>
                  <button
                    disabled={command.isPending}
                    onClick={() =>
                      setConfirm({
                        path: `integrations/${integration.id}/test`,
                        label: 'Queue a signed test delivery to this external endpoint?',
                      })
                    }
                  >
                    Test integration
                  </button>
                  <button
                    disabled={command.isPending}
                    onClick={() => {
                      setSecret('');
                      setConfirm({
                        path: `integrations/${integration.id}/rotate`,
                        label:
                          'Rotate signing secret? The current secret becomes invalid immediately.',
                      });
                    }}
                  >
                    Rotate secret
                  </button>
                  <button
                    onClick={() =>
                      setConfirm({
                        path: `integrations/${integration.id}/archive`,
                        label:
                          'Archive this integration? Future deliveries and inbound requests will be rejected.',
                      })
                    }
                  >
                    Archive integration
                  </button>
                </>
              )}
            </article>
          ))}
          <Pagination page={page} pages={integrations.data?.pagination.pages} onChange={setPage} />
        </>
      )}
      {integrationEditor && (
        <IntegrationEditor
          key={integrationEditor === 'new' ? 'new-integration' : integrationEditor.id}
          existing={integrationEditor === 'new' ? undefined : integrationEditor}
          pending={saveConnection.isPending}
          onSave={(input) => saveConnection.mutate(input)}
          onClose={() => setIntegrationEditor(undefined)}
        />
      )}
      {secret && (
        <section className="automation-panel" aria-label="New signing secret">
          <h2>Save your signing secret now</h2>
          <p role="alert">
            Shown only once. Store this secret securely; Flowryn cannot display it again.
          </p>
          <output className="automation-secret">{secret}</output>
          <button onClick={() => setSecret('')}>I saved it — hide secret</button>
        </section>
      )}
      {selectedIntegration && (
        <section className="automation-panel">
          <h2>Webhook deliveries</h2>
          {deliveries.data?.items.length === 0 && <p>No deliveries yet.</p>}
          {deliveries.data?.items.map((d) => (
            <p key={d.id}>
              {d.direction} · {d.status} · {d.attemptCount} attempts {d.error}
            </p>
          ))}
          <Pagination page={page} pages={deliveries.data?.pagination.pages} onChange={setPage} />
          <button onClick={() => setSelectedIntegration('')}>Close deliveries</button>
        </section>
      )}
      {tab === 'dead-letters' && (
        <>
          <h2>Dead-letter events</h2>
          {dead.data?.items.length === 0 && <p>No dead-letter events.</p>}
          {dead.data?.items.map((event) => (
            <article key={event.id} className="automation-panel">
              <p>
                {event.eventType} · {event.error}
              </p>
              <button
                onClick={() =>
                  setConfirm({
                    path: `dead-letters/${event.id}/replay`,
                    label:
                      'Replay this event? Existing rule/event receipts prevent duplicate runs.',
                  })
                }
              >
                Replay event
              </button>
            </article>
          ))}
          <Pagination page={page} pages={dead.data?.pagination.pages} onChange={setPage} />
        </>
      )}
      {tab === 'metrics' && metrics.data && (
        <section className="automation-panel">
          <h2>Automation metrics</h2>
          <p>
            Terminal runs define rates: partially failed counts as failure; skipped, cancelled,
            queued and running are excluded. Retries update the same run.
          </p>
          <dl>
            <dt>Success rate</dt>
            <dd>
              {metrics.data.successRate === null
                ? 'No samples'
                : `${(metrics.data.successRate * 100).toFixed(1)}%`}
            </dd>
            <dt>Failure rate</dt>
            <dd>
              {metrics.data.failureRate === null
                ? 'No samples'
                : `${(metrics.data.failureRate * 100).toFixed(1)}%`}
            </dd>
            <dt>Average execution duration</dt>
            <dd>
              {metrics.data.summary.durationMs === null
                ? 'No samples'
                : `${metrics.data.summary.durationMs.toFixed(0)} ms`}
            </dd>
            <dt>Retries</dt>
            <dd>{metrics.data.summary.retryCount}</dd>
            <dt>Dead letters</dt>
            <dd>{metrics.data.deadLetterCount}</dd>
            <dt>Webhook success rate</dt>
            <dd>
              {metrics.data.webhookSuccessRate === null
                ? 'No samples'
                : `${(metrics.data.webhookSuccessRate * 100).toFixed(1)}%`}
            </dd>
          </dl>
          <h3>Runs by status</h3>
          {metrics.data.byStatus.map((s) => (
            <p key={s._id}>
              {s._id}: {s.count}
            </p>
          ))}
          <h3>Frequently failing rules</h3>
          {metrics.data.failingRules.map((r) => (
            <p key={r._id}>
              {rules.data?.items.find((rule) => rule.id === r._id)?.name ?? 'Rule'}: {r.count}
            </p>
          ))}
          <h3>Executions by UTC day</h3>
          {metrics.data.overTime.map((d) => (
            <p key={d._id}>
              {d._id}: {d.count}
            </p>
          ))}
        </section>
      )}
      {confirm && (
        <section
          role="alertdialog"
          aria-modal="false"
          aria-label="Confirm automation action"
          className="automation-panel"
        >
          <p>{confirm.label}</p>
          <button
            autoFocus
            disabled={command.isPending}
            onClick={() => command.mutate({ path: confirm.path })}
          >
            Confirm action
          </button>
          <button disabled={command.isPending} onClick={() => setConfirm(undefined)}>
            Keep current state
          </button>
        </section>
      )}
    </main>
  );
}

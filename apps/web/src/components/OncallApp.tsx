import {
  alertInputSchema,
  policySchema,
  routingSchema,
  scheduleSchema,
  type Alert,
  type AlertInput,
  type EscalationPolicy,
  type OverrideInput,
  type PolicyInput,
  type RoutingInput,
  type RoutingRule,
  type Schedule,
  type ScheduleInput,
} from '@flowryn/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import { listMembers, listProjects, request } from '../api';
import { automationList } from '../automation-api';
import { listIncidents } from '../incidents-api';
import {
  getAlert,
  getCoverage,
  getEscalationHistory,
  getOncallMetrics,
  getOverrides,
  oncallCommand,
  oncallList,
  oncallPath,
  saveOncall,
} from '../oncall-api';
import { bindRealtime, connectRealtime, type ConnectionState } from '../realtime';

type Ref = { id: string; name: string };
type Refs = {
  members: Ref[];
  schedules: Schedule[];
  policies: EscalationPolicy[];
  integrations: Ref[];
  incidents: Ref[];
  projects: Ref[];
};
const minuteNow = () => new Date(Math.floor(Date.now() / 60000) * 60000).toISOString();
const utcInput = (value: string) => value.slice(0, 16);
const isoInput = (value: string) => (value ? new Date(`${value}:00Z`).toISOString() : '');
const move = <T,>(values: T[], index: number, offset: number) => {
  const next = [...values];
  const destination = index + offset;
  if (destination < 0 || destination >= next.length) return values;
  [next[index], next[destination]] = [next[destination]!, next[index]!];
  return next;
};
function Order({
  label,
  index,
  total,
  onMove,
}: {
  label: string;
  index: number;
  total: number;
  onMove: (offset: number) => void;
}) {
  return (
    <span className="oncall-order">
      <button
        type="button"
        aria-label={`Move ${label} up`}
        disabled={!index}
        onClick={() => onMove(-1)}
      >
        Up
      </button>
      <button
        type="button"
        aria-label={`Move ${label} down`}
        disabled={index === total - 1}
        onClick={() => onMove(1)}
      >
        Down
      </button>
    </span>
  );
}
function SelectRef({
  label,
  value,
  items,
  onChange,
  optional = false,
}: {
  label: string;
  value: string;
  items: Ref[];
  onChange: (value: string) => void;
  optional?: boolean;
}) {
  return (
    <label>
      {label}
      <select required={!optional} value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">{optional ? 'None / use routing' : 'Choose'}</option>
        {items.map((item) => (
          <option key={item.id} value={item.id}>
            {item.name}
          </option>
        ))}
      </select>
    </label>
  );
}
function DateUTC({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label>
      {label} (UTC)
      <input
        type="datetime-local"
        required
        value={utcInput(value)}
        onChange={(event) => onChange(isoInput(event.target.value))}
      />
    </label>
  );
}
function Times({ value, timezone }: { value: string; timezone: string }) {
  return (
    <span>
      {new Date(value).toLocaleString(undefined, { timeZone: timezone })} ({timezone}); local:{' '}
      {new Date(value).toLocaleString()} ({Intl.DateTimeFormat().resolvedOptions().timeZone})
    </span>
  );
}
function CoverageEditor({
  coverage,
  onChange,
}: {
  coverage: NonNullable<ScheduleInput['layers'][number]['coverage']>;
  onChange: (value: NonNullable<ScheduleInput['layers'][number]['coverage']>) => void;
}) {
  return (
    <fieldset>
      <legend>Local coverage window</legend>
      {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((day, index) => (
        <label className="oncall-check" key={day}>
          <input
            type="checkbox"
            checked={coverage.days.includes(index)}
            onChange={(event) =>
              onChange({
                ...coverage,
                days: event.target.checked
                  ? [...coverage.days, index]
                  : coverage.days.filter((value) => value !== index),
              })
            }
          />
          {day}
        </label>
      ))}
      <label>
        Starts at local minute (0–1439)
        <input
          type="number"
          min={0}
          max={1439}
          value={coverage.startsMinute}
          onChange={(event) => onChange({ ...coverage, startsMinute: Number(event.target.value) })}
        />
      </label>
      <label>
        Ends at local minute (1–1440)
        <input
          type="number"
          min={1}
          max={1440}
          value={coverage.endsMinute}
          onChange={(event) => onChange({ ...coverage, endsMinute: Number(event.target.value) })}
        />
      </label>
      <p>540 = 09:00; 1020 = 17:00. Split overnight coverage into separate layers.</p>
    </fieldset>
  );
}
const layer = (): ScheduleInput['layers'][number] => ({
  id: crypto.randomUUID(),
  name: 'Primary',
  participants: [],
  startsAt: minuteNow(),
  shiftMinutes: 1440,
  handoff: 'elapsedUTC',
});
export function ScheduleEditor({
  existing,
  members,
  onSave,
  onClose,
  pending,
}: {
  existing?: Schedule;
  members: Ref[];
  onSave: (input: ScheduleInput) => void;
  onClose: () => void;
  pending: boolean;
}) {
  const [value, setValue] = useState<ScheduleInput>(() =>
    existing
      ? {
          name: existing.name,
          description: existing.description,
          timezone: existing.timezone,
          enabled: existing.enabled,
          allowSelfOverrides: existing.allowSelfOverrides,
          layers: existing.layers,
        }
      : {
          name: '',
          description: '',
          timezone: 'UTC',
          enabled: true,
          allowSelfOverrides: false,
          layers: [layer()],
        },
  );
  const [error, setError] = useState('');
  const changeLayer = (index: number, changes: Partial<ScheduleInput['layers'][number]>) =>
    setValue({
      ...value,
      layers: value.layers.map((item, i) => (i === index ? { ...item, ...changes } : item)),
    });
  return (
    <section className="oncall-panel">
      <h2>{existing ? 'Edit schedule' : 'Create schedule'}</h2>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const parsed = scheduleSchema.safeParse(value);
          if (parsed.success) onSave(parsed.data);
          else setError(parsed.error.issues.map((issue) => issue.message).join('; '));
        }}
      >
        <label>
          Schedule name
          <input
            required
            maxLength={200}
            value={value.name}
            onChange={(event) => setValue({ ...value, name: event.target.value })}
          />
        </label>
        <label>
          Description
          <textarea
            maxLength={2000}
            value={value.description}
            onChange={(event) => setValue({ ...value, description: event.target.value })}
          />
        </label>
        <label>
          IANA timezone
          <input
            required
            value={value.timezone}
            onChange={(event) => setValue({ ...value, timezone: event.target.value })}
            placeholder="America/New_York"
          />
        </label>
        <label className="oncall-check">
          <input
            type="checkbox"
            checked={value.enabled}
            onChange={(event) => setValue({ ...value, enabled: event.target.checked })}
          />
          Enabled
        </label>
        <label className="oncall-check">
          <input
            type="checkbox"
            checked={value.allowSelfOverrides}
            onChange={(event) => setValue({ ...value, allowSelfOverrides: event.target.checked })}
          />
          Permit members to override only their own future covered shifts
        </label>
        <p>
          Shifts use elapsed UTC minutes. Coverage uses the schedule timezone. Viewer timezone:{' '}
          {Intl.DateTimeFormat().resolvedOptions().timeZone}.
        </p>
        {value.layers.map((item, index) => (
          <fieldset key={item.id}>
            <legend>
              Layer {index + 1}: {item.name}
            </legend>
            <Order
              label={`layer ${index + 1}`}
              index={index}
              total={value.layers.length}
              onMove={(offset) => setValue({ ...value, layers: move(value.layers, index, offset) })}
            />
            <label>
              Layer name
              <input
                required
                value={item.name}
                onChange={(event) => changeLayer(index, { name: event.target.value })}
              />
            </label>
            <DateUTC
              label="Rotation starts"
              value={item.startsAt}
              onChange={(startsAt) => changeLayer(index, { startsAt })}
            />
            <label>
              Shift duration (minutes)
              <input
                type="number"
                min={15}
                max={10080}
                value={item.shiftMinutes}
                onChange={(event) =>
                  changeLayer(index, { shiftMinutes: Number(event.target.value) })
                }
              />
            </label>
            {item.participants.map((participant, position) => (
              <div key={`${participant}-${position}`} className="oncall-row">
                <SelectRef
                  label={`Participant ${position + 1} in layer ${index + 1}`}
                  value={participant}
                  items={members}
                  onChange={(id) =>
                    changeLayer(index, {
                      participants: item.participants.map((current, i) =>
                        i === position ? id : current,
                      ),
                    })
                  }
                />
                <Order
                  label={`participant ${position + 1} in layer ${index + 1}`}
                  index={position}
                  total={item.participants.length}
                  onMove={(offset) =>
                    changeLayer(index, { participants: move(item.participants, position, offset) })
                  }
                />
                <button
                  type="button"
                  onClick={() =>
                    changeLayer(index, {
                      participants: item.participants.filter((_, i) => i !== position),
                    })
                  }
                >
                  Remove participant {position + 1}
                </button>
              </div>
            ))}
            <button
              type="button"
              disabled={item.participants.length >= 32}
              onClick={() => changeLayer(index, { participants: [...item.participants, ''] })}
            >
              Add participant to layer {index + 1}
            </button>
            <label className="oncall-check">
              <input
                type="checkbox"
                checked={!!item.coverage}
                onChange={(event) =>
                  changeLayer(index, {
                    coverage: event.target.checked
                      ? { days: [0, 1, 2, 3, 4, 5, 6], startsMinute: 0, endsMinute: 1440 }
                      : undefined,
                  })
                }
              />
              Restrict daily / weekly coverage
            </label>
            {item.coverage && (
              <CoverageEditor
                coverage={item.coverage}
                onChange={(coverage) => changeLayer(index, { coverage })}
              />
            )}
            <button
              type="button"
              disabled={value.layers.length === 1}
              onClick={() =>
                setValue({ ...value, layers: value.layers.filter((_, i) => i !== index) })
              }
            >
              Remove layer {index + 1}
            </button>
          </fieldset>
        ))}
        <button
          type="button"
          disabled={value.layers.length >= 8}
          onClick={() => setValue({ ...value, layers: [...value.layers, layer()] })}
        >
          Add layer
        </button>
        {error && <p role="alert">{error}</p>}
        <button disabled={pending}>Save schedule</button>
        <button type="button" onClick={onClose}>
          Cancel
        </button>
      </form>
    </section>
  );
}
const newStep = (): PolicyInput['steps'][number] => ({
  id: crypto.randomUUID(),
  delayMinutes: 0,
  target: { type: 'users', userIds: [] },
  webhookIntegrationIds: [],
});
export function PolicyEditor({
  existing,
  references,
  onSave,
  onClose,
  pending,
}: {
  existing?: EscalationPolicy;
  references: Refs;
  onSave: (input: PolicyInput) => void;
  onClose: () => void;
  pending: boolean;
}) {
  const [value, setValue] = useState<PolicyInput>(() =>
    existing
      ? {
          name: existing.name,
          description: existing.description,
          enabled: existing.enabled,
          steps: existing.steps,
          repeatCount: existing.repeatCount,
          repeatDelayMinutes: existing.repeatDelayMinutes,
        }
      : {
          name: '',
          description: '',
          enabled: true,
          steps: [newStep()],
          repeatCount: 0,
          repeatDelayMinutes: 30,
        },
  );
  const [error, setError] = useState('');
  const change = (index: number, changes: Partial<PolicyInput['steps'][number]>) =>
    setValue({
      ...value,
      steps: value.steps.map((step, i) => (i === index ? { ...step, ...changes } : step)),
    });
  return (
    <section className="oncall-panel">
      <h2>{existing ? 'Edit policy' : 'Create policy'}</h2>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const parsed = policySchema.safeParse(value);
          if (parsed.success) onSave(parsed.data);
          else setError(parsed.error.issues.map((issue) => issue.message).join('; '));
        }}
      >
        <label>
          Policy name
          <input
            required
            maxLength={200}
            value={value.name}
            onChange={(event) => setValue({ ...value, name: event.target.value })}
          />
        </label>
        <label>
          Description
          <textarea
            value={value.description}
            onChange={(event) => setValue({ ...value, description: event.target.value })}
          />
        </label>
        <label className="oncall-check">
          <input
            type="checkbox"
            checked={value.enabled}
            onChange={(event) => setValue({ ...value, enabled: event.target.checked })}
          />
          Enabled
        </label>
        {value.steps.map((step, index) => (
          <fieldset key={step.id}>
            <legend>Step {index + 1}</legend>
            <Order
              label={`step ${index + 1}`}
              index={index}
              total={value.steps.length}
              onMove={(offset) => setValue({ ...value, steps: move(value.steps, index, offset) })}
            />
            <label>
              Delay from previous step (minutes)
              <input
                type="number"
                min={index ? 1 : 0}
                max={1440}
                value={step.delayMinutes}
                onChange={(event) => change(index, { delayMinutes: Number(event.target.value) })}
              />
            </label>
            <label>
              Recipient target
              <select
                value={step.target.type}
                onChange={(event) => {
                  const type = event.target.value as PolicyInput['steps'][number]['target']['type'];
                  change(index, {
                    target:
                      type === 'users'
                        ? { type, userIds: [] }
                        : type === 'schedule'
                          ? { type, scheduleId: '' }
                          : { type },
                  });
                }}
              >
                {['users', 'schedule', 'commander', 'responders'].map((type) => (
                  <option key={type}>{type}</option>
                ))}
              </select>
            </label>
            {step.target.type === 'schedule' && (
              <SelectRef
                label="Recipient schedule"
                value={step.target.scheduleId}
                items={references.schedules}
                onChange={(scheduleId) =>
                  change(index, { target: { type: 'schedule', scheduleId } })
                }
              />
            )}{' '}
            {step.target.type === 'users' && (
              <fieldset>
                <legend>Explicit recipients</legend>
                {references.members.map((member) => (
                  <label className="oncall-check" key={member.id}>
                    <input
                      type="checkbox"
                      checked={
                        step.target.type === 'users' && step.target.userIds.includes(member.id)
                      }
                      onChange={(event) => {
                        if (step.target.type === 'users')
                          change(index, {
                            target: {
                              type: 'users',
                              userIds: event.target.checked
                                ? [...step.target.userIds, member.id]
                                : step.target.userIds.filter((id) => id !== member.id),
                            },
                          });
                      }}
                    />
                    {member.name}
                  </label>
                ))}
              </fieldset>
            )}
            <fieldset>
              <legend>Approved generic webhooks (optional)</legend>
              {references.integrations.map((integration) => (
                <label className="oncall-check" key={integration.id}>
                  <input
                    type="checkbox"
                    checked={step.webhookIntegrationIds.includes(integration.id)}
                    onChange={(event) =>
                      change(index, {
                        webhookIntegrationIds: event.target.checked
                          ? [...step.webhookIntegrationIds, integration.id]
                          : step.webhookIntegrationIds.filter((id) => id !== integration.id),
                      })
                    }
                  />
                  {integration.name}
                </label>
              ))}
            </fieldset>
            <button
              type="button"
              disabled={value.steps.length === 1}
              onClick={() =>
                setValue({ ...value, steps: value.steps.filter((_, i) => i !== index) })
              }
            >
              Remove step {index + 1}
            </button>
          </fieldset>
        ))}
        <button
          type="button"
          disabled={value.steps.length >= 8}
          onClick={() =>
            setValue({ ...value, steps: [...value.steps, { ...newStep(), delayMinutes: 5 }] })
          }
        >
          Add step
        </button>
        <label>
          Additional repeats (0–3)
          <input
            type="number"
            min={0}
            max={3}
            value={value.repeatCount}
            onChange={(event) => setValue({ ...value, repeatCount: Number(event.target.value) })}
          />
        </label>
        <label>
          Delay before repeat (minutes)
          <input
            type="number"
            min={1}
            max={1440}
            value={value.repeatDelayMinutes}
            onChange={(event) =>
              setValue({ ...value, repeatDelayMinutes: Number(event.target.value) })
            }
          />
        </label>
        {error && <p role="alert">{error}</p>}
        <button disabled={pending}>Save policy</button>
        <button type="button" onClick={onClose}>
          Cancel
        </button>
      </form>
    </section>
  );
}
export function RoutingEditor({
  existing,
  references,
  onSave,
  onClose,
  pending,
}: {
  existing?: RoutingRule;
  references: Refs;
  onSave: (input: RoutingInput) => void;
  onClose: () => void;
  pending: boolean;
}) {
  const [value, setValue] = useState<RoutingInput>(() =>
    existing
      ? {
          name: existing.name,
          enabled: existing.enabled,
          priority: existing.priority,
          policyId: existing.policyId,
          conditions: existing.conditions,
        }
      : { name: '', enabled: true, priority: 100, policyId: '', conditions: [] },
  );
  const [error, setError] = useState('');
  const change = (index: number, condition: RoutingInput['conditions'][number]) =>
    setValue({
      ...value,
      conditions: value.conditions.map((item, i) => (i === index ? condition : item)),
    });
  return (
    <section className="oncall-panel">
      <h2>{existing ? 'Edit route' : 'Create route'}</h2>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const parsed = routingSchema.safeParse(value);
          if (parsed.success) onSave(parsed.data);
          else setError(parsed.error.issues.map((issue) => issue.message).join('; '));
        }}
      >
        <label>
          Route name
          <input
            required
            value={value.name}
            onChange={(event) => setValue({ ...value, name: event.target.value })}
          />
        </label>
        <label>
          Priority (lower first)
          <input
            type="number"
            min={0}
            max={10000}
            value={value.priority}
            onChange={(event) => setValue({ ...value, priority: Number(event.target.value) })}
          />
        </label>
        <SelectRef
          label="Escalation policy"
          value={value.policyId}
          items={references.policies}
          onChange={(policyId) => setValue({ ...value, policyId })}
        />
        <label className="oncall-check">
          <input
            type="checkbox"
            checked={value.enabled}
            onChange={(event) => setValue({ ...value, enabled: event.target.checked })}
          />
          Enabled
        </label>
        <p>
          All conditions must match. Equal priorities use stable route ID order. Empty conditions
          match all alerts.
        </p>
        {value.conditions.map((condition, index) => (
          <fieldset key={index}>
            <legend>Condition {index + 1}</legend>
            <label>
              Routing field
              <select
                value={condition.field}
                onChange={(event) => {
                  const field = event.target.value;
                  change(
                    index,
                    field === 'timeWindow'
                      ? {
                          field,
                          timezone: 'UTC',
                          coverage: {
                            days: [0, 1, 2, 3, 4, 5, 6],
                            startsMinute: 0,
                            endsMinute: 1440,
                          },
                        }
                      : field === 'label'
                        ? { field, key: '', value: '' }
                        : field === 'hasIncident'
                          ? { field, value: true }
                          : field === 'severity'
                            ? { field, value: 'sev3' }
                            : {
                                field: field as 'sourceIntegrationId' | 'projectId' | 'serviceId',
                                value: '',
                              },
                  );
                }}
              >
                {[
                  'severity',
                  'sourceIntegrationId',
                  'label',
                  'projectId',
                  'serviceId',
                  'timeWindow',
                  'hasIncident',
                ].map((field) => (
                  <option key={field}>{field}</option>
                ))}
              </select>
            </label>
            {condition.field === 'timeWindow' ? (
              <>
                <label>
                  Window timezone
                  <input
                    value={condition.timezone}
                    onChange={(event) =>
                      change(index, { ...condition, timezone: event.target.value })
                    }
                  />
                </label>
                <CoverageEditor
                  coverage={condition.coverage}
                  onChange={(coverage) => change(index, { ...condition, coverage })}
                />
              </>
            ) : condition.field === 'hasIncident' ? (
              <label>
                Has incident
                <select
                  value={String(condition.value)}
                  onChange={(event) =>
                    change(index, { ...condition, value: event.target.value === 'true' })
                  }
                >
                  <option>true</option>
                  <option>false</option>
                </select>
              </label>
            ) : condition.field === 'sourceIntegrationId' || condition.field === 'projectId' ? (
              <SelectRef
                label="Reference"
                value={condition.value}
                items={
                  condition.field === 'projectId' ? references.projects : references.integrations
                }
                onChange={(id) => change(index, { ...condition, value: id })}
              />
            ) : condition.field === 'severity' ? (
              <label>
                Severity
                <select
                  value={condition.value}
                  onChange={(event) =>
                    change(index, {
                      ...condition,
                      value: event.target.value as AlertInput['severity'],
                    })
                  }
                >
                  {['sev1', 'sev2', 'sev3', 'sev4'].map((severity) => (
                    <option key={severity}>{severity}</option>
                  ))}
                </select>
              </label>
            ) : (
              <>
                {condition.field === 'label' && (
                  <label>
                    Safe label key
                    <input
                      value={condition.key}
                      onChange={(event) => change(index, { ...condition, key: event.target.value })}
                    />
                  </label>
                )}
                <label>
                  Equality value
                  <input
                    value={condition.value}
                    onChange={(event) => change(index, { ...condition, value: event.target.value })}
                  />
                </label>
              </>
            )}
            <button
              type="button"
              onClick={() =>
                setValue({ ...value, conditions: value.conditions.filter((_, i) => i !== index) })
              }
            >
              Remove condition {index + 1}
            </button>
          </fieldset>
        ))}
        <button
          type="button"
          disabled={value.conditions.length >= 16}
          onClick={() =>
            setValue({
              ...value,
              conditions: [...value.conditions, { field: 'severity', value: 'sev3' }],
            })
          }
        >
          Add condition
        </button>
        {error && <p role="alert">{error}</p>}
        <button disabled={pending}>Save route</button>
        <button type="button" onClick={onClose}>
          Cancel
        </button>
      </form>
    </section>
  );
}
function AlertForm({
  references,
  onSubmit,
  label,
  pending,
}: {
  references: Refs;
  onSubmit: (input: AlertInput) => void;
  label: string;
  pending: boolean;
}) {
  const [value, setValue] = useState<AlertInput>({
    operationId: crypto.randomUUID(),
    fingerprint: '',
    title: '',
    summary: '',
    severity: 'sev3',
    labels: {},
  });
  const [error, setError] = useState('');
  return (
    <form
      className="oncall-panel"
      onSubmit={(event) => {
        event.preventDefault();
        const parsed = alertInputSchema.safeParse(value);
        if (parsed.success) onSubmit(parsed.data);
        else setError(parsed.error.issues.map((issue) => issue.message).join('; '));
      }}
    >
      <label>
        Fingerprint
        <input
          required
          maxLength={160}
          value={value.fingerprint}
          onChange={(event) => setValue({ ...value, fingerprint: event.target.value })}
        />
      </label>
      <label>
        Alert title
        <input
          required
          maxLength={200}
          value={value.title}
          onChange={(event) => setValue({ ...value, title: event.target.value })}
        />
      </label>
      <label>
        Summary
        <textarea
          maxLength={4000}
          value={value.summary}
          onChange={(event) => setValue({ ...value, summary: event.target.value })}
        />
      </label>
      <label>
        Alert severity
        <select
          value={value.severity}
          onChange={(event) =>
            setValue({ ...value, severity: event.target.value as AlertInput['severity'] })
          }
        >
          {['sev1', 'sev2', 'sev3', 'sev4'].map((severity) => (
            <option key={severity}>{severity}</option>
          ))}
        </select>
      </label>
      <SelectRef
        label="Policy override"
        optional
        value={value.escalationPolicyId ?? ''}
        items={references.policies}
        onChange={(id) => setValue({ ...value, escalationPolicyId: id || undefined })}
      />
      <SelectRef
        label="Source integration"
        optional
        value={value.sourceIntegrationId ?? ''}
        items={references.integrations}
        onChange={(id) => setValue({ ...value, sourceIntegrationId: id || undefined })}
      />
      <SelectRef
        label="Project"
        optional
        value={value.projectId ?? ''}
        items={references.projects}
        onChange={(id) => setValue({ ...value, projectId: id || undefined })}
      />
      <SelectRef
        label="Existing incident"
        optional
        value={value.linkedIncidentId ?? ''}
        items={references.incidents}
        onChange={(id) => setValue({ ...value, linkedIncidentId: id || undefined })}
      />
      <label>
        Service identifier
        <input
          value={value.serviceId ?? ''}
          onChange={(event) => setValue({ ...value, serviceId: event.target.value || undefined })}
        />
      </label>
      <fieldset>
        <legend>Safe labels</legend>
        {Object.entries(value.labels).map(([key, current]) => (
          <div className="oncall-row" key={key}>
            <label>
              {key}
              <input
                value={current}
                onChange={(event) =>
                  setValue({ ...value, labels: { ...value.labels, [key]: event.target.value } })
                }
              />
            </label>
            <button
              type="button"
              onClick={() =>
                setValue({
                  ...value,
                  labels: Object.fromEntries(
                    Object.entries(value.labels).filter(([name]) => name !== key),
                  ),
                })
              }
            >
              Remove label {key}
            </button>
          </div>
        ))}
        <label>
          New label key
          <input name="labelKey" maxLength={40} />
        </label>
        <button
          type="button"
          disabled={Object.keys(value.labels).length >= 16}
          onClick={(event) => {
            const input = event.currentTarget.form?.elements.namedItem(
              'labelKey',
            ) as HTMLInputElement | null;
            if (
              input &&
              /^[a-zA-Z0-9_.-]{1,40}$/.test(input.value) &&
              !['__proto__', 'constructor', 'prototype'].includes(input.value)
            ) {
              setValue({ ...value, labels: { ...value.labels, [input.value]: '' } });
              input.value = '';
            }
          }}
        >
          Add label
        </button>
      </fieldset>
      {error && <p role="alert">{error}</p>}
      <button disabled={pending}>{label}</button>
    </form>
  );
}
export function OncallApp({
  workspaceId,
  workspaceName,
  role,
  userId,
  onLogout,
}: {
  workspaceId: string;
  workspaceName: string;
  role: string;
  userId: string;
  onLogout: () => void;
}) {
  const admin = ['owner', 'admin'].includes(role);
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<'schedules' | 'policies' | 'routing' | 'alerts' | 'metrics'>(
    'alerts',
  );
  const [page, setPage] = useState(1);
  const [refPage, setRefPage] = useState(1);
  const [historyPage, setHistoryPage] = useState(1);
  const [editor, setEditor] = useState<{
    resource: 'schedules' | 'policies' | 'routing';
    item?: Schedule | EscalationPolicy | RoutingRule;
  } | null>(null);
  const [selectedSchedule, setSelectedSchedule] = useState('');
  const [selectedAlert, setSelectedAlert] = useState('');
  const [create, setCreate] = useState(false);
  const [status, setStatus] = useState('');
  const [severity, setSeverity] = useState('');
  const [search, setSearch] = useState('');
  const [filterPolicy, setFilterPolicy] = useState('');
  const [filterIntegration, setFilterIntegration] = useState('');
  const [filterIncident, setFilterIncident] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [from, setFrom] = useState(minuteNow);
  const [to, setTo] = useState(() => new Date(Date.parse(minuteNow()) + 86400000).toISOString());
  const [connection, setConnection] = useState<ConnectionState>('connecting');
  const [online, setOnline] = useState(navigator.onLine);
  const [message, setMessage] = useState('');
  const [preview, setPreview] = useState('');
  const [override, setOverride] = useState<OverrideInput>({
    layerId: '',
    startsAt: minuteNow(),
    endsAt: new Date(Date.parse(minuteNow()) + 3600000).toISOString(),
    replacementUserId: '',
    reason: '',
  });
  const [suppression, setSuppression] = useState(() =>
    new Date(Date.parse(minuteNow()) + 3600000).toISOString(),
  );
  const [incidentId, setIncidentId] = useState('');
  const [confirmSev1, setConfirmSev1] = useState(false);
  const [confirmation, setConfirmation] = useState<{
    label: string;
    path: string;
    body?: unknown;
  } | null>(null);
  const [retry, setRetry] = useState<{ path: string; body: unknown } | null>(null);
  useEffect(() => {
    const socket = connectRealtime();
    const close = bindRealtime(socket, workspaceId, undefined, queryClient, setConnection);
    socket.connect();
    const change = () => setOnline(navigator.onLine);
    window.addEventListener('online', change);
    window.addEventListener('offline', change);
    return () => {
      close();
      socket.disconnect();
      window.removeEventListener('online', change);
      window.removeEventListener('offline', change);
    };
  }, [workspaceId, queryClient]);
  const members = useQuery({
    queryKey: ['oncall', workspaceId, 'members'],
    queryFn: () => listMembers(workspaceId),
  });
  const schedules = useQuery({
    queryKey: ['oncall', workspaceId, 'schedules'],
    queryFn: () => oncallList<Schedule>(workspaceId, 'schedules', { limit: 100 }),
    refetchInterval: 15000,
  });
  const policies = useQuery({
    queryKey: ['oncall', workspaceId, 'policies'],
    queryFn: () => oncallList<EscalationPolicy>(workspaceId, 'policies', { limit: 100 }),
    refetchInterval: 15000,
  });
  const routes = useQuery({
    queryKey: ['oncall', workspaceId, 'routing'],
    queryFn: () => oncallList<RoutingRule>(workspaceId, 'routing', { limit: 100 }),
    enabled: admin,
    refetchInterval: 15000,
  });
  const integrations = useQuery({
    queryKey: ['oncall', workspaceId, 'integrations', refPage],
    queryFn: () =>
      automationList<{ id: string; name: string; outboundEvents: string[] }>(
        workspaceId,
        'integrations',
        { page: refPage, limit: 100 },
      ),
    enabled: admin,
  });
  const incidents = useQuery({
    queryKey: ['oncall', workspaceId, 'incidents', refPage],
    queryFn: () => listIncidents(workspaceId, { page: String(refPage), limit: '100' }),
  });
  const projects = useQuery({
    queryKey: ['oncall', workspaceId, 'projects', refPage],
    queryFn: () => listProjects(workspaceId, refPage),
  });
  const alerts = useQuery({
    queryKey: [
      'oncall',
      workspaceId,
      'alerts',
      page,
      status,
      severity,
      search,
      filterPolicy,
      filterIntegration,
      filterIncident,
      dateFrom,
      dateTo,
    ],
    queryFn: () =>
      oncallList<Alert>(workspaceId, 'alerts', {
        page,
        status,
        severity,
        search,
        policyId: filterPolicy,
        integrationId: filterIntegration,
        incidentId: filterIncident,
        ...(dateFrom ? { from: dateFrom } : {}),
        ...(dateTo ? { to: dateTo } : {}),
      }),
    enabled: tab === 'alerts',
    refetchInterval: 15000,
  });
  const detail = useQuery({
    queryKey: ['oncall', workspaceId, 'alert', selectedAlert],
    queryFn: () => getAlert(workspaceId, selectedAlert),
    enabled: !!selectedAlert,
    refetchInterval: 15000,
  });
  const history = useQuery({
    queryKey: ['oncall', workspaceId, 'history', selectedAlert, historyPage],
    queryFn: () => getEscalationHistory(workspaceId, selectedAlert, historyPage),
    enabled: admin && !!selectedAlert,
    refetchInterval: 15000,
  });
  const coverage = useQuery({
    queryKey: ['oncall', workspaceId, 'coverage', selectedSchedule, from, to],
    queryFn: () => getCoverage(workspaceId, selectedSchedule, from, to),
    enabled: !!selectedSchedule && !!from && !!to,
    refetchInterval: 15000,
  });
  const current = useQuery({
    queryKey: ['oncall', workspaceId, 'current', selectedSchedule],
    queryFn: () =>
      request<{
        timezone: string;
        layerRecipients: Array<{ layerId: string; userId: string | null }>;
      }>(`${oncallPath(workspaceId)}/schedules/${selectedSchedule}/current`),
    enabled: !!selectedSchedule,
    refetchInterval: 15000,
  });
  const overrides = useQuery({
    queryKey: ['oncall', workspaceId, 'overrides', selectedSchedule, historyPage],
    queryFn: () => getOverrides(workspaceId, selectedSchedule, historyPage),
    enabled: !!selectedSchedule,
    refetchInterval: 15000,
  });
  const metrics = useQuery({
    queryKey: ['oncall', workspaceId, 'metrics'],
    queryFn: () => getOncallMetrics(workspaceId),
    enabled: admin && tab === 'metrics',
    refetchInterval: 15000,
  });
  const fallback = useQuery({
    queryKey: ['oncall', workspaceId, 'fallback'],
    queryFn: () => request<{ policyId: string | null }>(`${oncallPath(workspaceId)}/fallback`),
    enabled: admin,
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['oncall', workspaceId] });
  const command = useMutation({
    mutationFn: ({ path, body }: { path: string; body: unknown }) =>
      oncallCommand(workspaceId, path, body),
    onSuccess: async () => {
      setMessage('Saved.');
      setRetry(null);
      setConfirmation(null);
      await refresh();
    },
    onError: (error: Error) => setMessage(error.message),
  });
  const execute = (path: string, body: unknown = {}) => {
    setRetry({ path, body });
    command.mutate({ path, body });
  };
  const save = useMutation({
    mutationFn: ({
      resource,
      config,
      existing,
    }: {
      resource: string;
      config: unknown;
      existing?: { id: string; version: number };
    }) => saveOncall(workspaceId, resource, config, existing),
    onSuccess: async () => {
      setEditor(null);
      setMessage('Configuration saved.');
      await refresh();
    },
    onError: (error: Error) => setMessage(error.message),
  });
  const createAlertMutation = useMutation({
    mutationFn: (input: AlertInput) =>
      oncallCommand<{ alert: Alert }>(workspaceId, 'alerts', input),
    onSuccess: async (result) => {
      setCreate(false);
      setSelectedAlert(result.alert.id);
      setMessage('Alert accepted.');
      await refresh();
    },
    onError: (error: Error) => setMessage(error.message),
  });
  const dryRun = useMutation({
    mutationFn: (input: AlertInput) =>
      oncallCommand<{ policyId: string | null; routingRuleId: string | null }>(
        workspaceId,
        'routing/dry-run',
        input,
      ),
    onSuccess: (result) =>
      setPreview(
        `Policy: ${result.policyId ?? 'none — alert remains open without paging'}. Route: ${result.routingRuleId ?? 'fallback'}.`,
      ),
    onError: (error: Error) => setPreview(error.message),
  });
  const fallbackSave = useMutation({
    mutationFn: (id: string) =>
      request(`${oncallPath(workspaceId)}/fallback`, {
        method: 'PUT',
        body: JSON.stringify({ policyId: id || null }),
      }),
    onSuccess: refresh,
    onError: (error: Error) => setMessage(error.message),
  });
  const references: Refs = {
    members:
      members.data?.members.map((member) => ({ id: member.user._id, name: member.user.name })) ??
      [],
    schedules: schedules.data?.items ?? [],
    policies: policies.data?.items ?? [],
    integrations: integrations.data?.items ?? [],
    incidents:
      incidents.data?.items.map((incident) => ({
        id: incident.id,
        name: `#${incident.incidentNumber} ${incident.title}`,
      })) ?? [],
    projects: projects.data?.items ?? [],
  };
  const name = (id: string) =>
    references.members.find((member) => member.id === id)?.name ?? 'Unavailable member';
  const selected = schedules.data?.items.find((schedule) => schedule.id === selectedSchedule);
  const active = detail.data?.alert;
  const failures = [
    members,
    schedules,
    policies,
    integrations,
    incidents,
    projects,
    alerts,
    detail,
    history,
    coverage,
    current,
    overrides,
    metrics,
    fallback,
  ].filter((query) => query.isError);
  const alertAction = (action: string, body: Record<string, unknown> = {}) =>
    execute(`alerts/${selectedAlert}/${action}`, { operationId: crypto.randomUUID(), ...body });
  return (
    <main className="oncall-app">
      <header>
        <h1>{workspaceName}: On-Call</h1>
        <button onClick={onLogout}>Log out</button>
      </header>
      <p role="status" aria-live="polite">
        {!online
          ? 'Offline — changes require a connection.'
          : connection === 'connected'
            ? 'Live updates connected.'
            : `${connection}. REST state refreshes every 15 seconds.`}{' '}
        {message}
      </p>
      {failures.map((query, index) => (
        <p role="alert" key={index}>
          {query.error?.message}
        </p>
      ))}
      {command.isError && retry && (
        <button disabled={command.isPending} onClick={() => command.mutate(retry)}>
          Retry saved request
        </button>
      )}
      <nav aria-label="On-call sections">
        {(
          ['alerts', 'schedules', ...(admin ? ['policies', 'routing', 'metrics'] : [])] as const
        ).map((section) => (
          <button
            key={section}
            aria-pressed={tab === section}
            onClick={() => {
              setTab(section as typeof tab);
              setPage(1);
              setEditor(null);
              setSelectedAlert('');
              setSelectedSchedule('');
              setHistoryPage(1);
            }}
          >
            {section}
          </button>
        ))}
      </nav>
      {confirmation && (
        <section role="alertdialog" aria-label="Confirm on-call action" className="oncall-panel">
          <p>{confirmation.label}</p>
          <button
            disabled={command.isPending || !online}
            onClick={() => execute(confirmation.path, confirmation.body ?? {})}
          >
            Confirm
          </button>
          <button onClick={() => setConfirmation(null)}>Cancel</button>
        </section>
      )}
      {editor &&
        admin &&
        (editor.resource === 'schedules' ? (
          <ScheduleEditor
            key={editor.item?.id ?? 'new-schedule'}
            existing={editor.item as Schedule | undefined}
            members={references.members}
            pending={save.isPending}
            onClose={() => setEditor(null)}
            onSave={(config) =>
              save.mutate({ resource: 'schedules', config, existing: editor.item })
            }
          />
        ) : editor.resource === 'policies' ? (
          <PolicyEditor
            key={editor.item?.id ?? 'new-policy'}
            existing={editor.item as EscalationPolicy | undefined}
            references={{
              ...references,
              integrations: (integrations.data?.items ?? []).filter((item) =>
                item.outboundEvents.includes('escalation.advanced'),
              ),
            }}
            pending={save.isPending}
            onClose={() => setEditor(null)}
            onSave={(config) =>
              save.mutate({ resource: 'policies', config, existing: editor.item })
            }
          />
        ) : (
          <RoutingEditor
            key={editor.item?.id ?? 'new-route'}
            existing={editor.item as RoutingRule | undefined}
            references={references}
            pending={save.isPending}
            onClose={() => setEditor(null)}
            onSave={(config) => save.mutate({ resource: 'routing', config, existing: editor.item })}
          />
        ))}
      {tab === 'schedules' && (
        <section>
          <h2>Schedules</h2>
          {admin && (
            <button onClick={() => setEditor({ resource: 'schedules' })}>Create schedule</button>
          )}
          {schedules.isLoading ? (
            <p>Loading schedules…</p>
          ) : !schedules.data?.items.length ? (
            <p>No schedules yet.</p>
          ) : (
            <ul>
              {schedules.data.items.map((schedule) => (
                <li key={schedule.id}>
                  <button
                    onClick={() => {
                      setSelectedSchedule(schedule.id);
                      setHistoryPage(1);
                      setOverride({
                        ...override,
                        layerId: schedule.layers[0]?.id ?? '',
                        originalUserId: admin ? undefined : userId,
                      });
                    }}
                  >
                    {schedule.name}
                  </button>{' '}
                  — {schedule.enabled ? 'enabled' : 'disabled'}, {schedule.timezone}
                  {admin && (
                    <>
                      <button onClick={() => setEditor({ resource: 'schedules', item: schedule })}>
                        Edit {schedule.name}
                      </button>
                      <button
                        onClick={() =>
                          setConfirmation({
                            label: `Archive ${schedule.name}? Future schedule recipients will have a coverage gap.`,
                            path: `schedules/${schedule.id}/archive`,
                          })
                        }
                      >
                        Archive {schedule.name}
                      </button>
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}
          {selected && (
            <section className="oncall-panel">
              <h2>{selected.name}</h2>
              <p>{selected.description}</p>
              <h3>Current on-call</h3>
              {current.isLoading ? (
                <p>Loading current rotation…</p>
              ) : (
                current.data?.layerRecipients.map((layer) => (
                  <p key={layer.layerId}>
                    {selected.layers.find((item) => item.id === layer.layerId)?.name}:{' '}
                    {layer.userId ? name(layer.userId) : 'Coverage gap'}
                  </p>
                ))
              )}
              <DateUTC label="Forecast from" value={from} onChange={setFrom} />
              <DateUTC label="Forecast to (maximum seven days)" value={to} onChange={setTo} />
              <h3>Upcoming rotation and coverage</h3>
              {coverage.isLoading ? (
                <p>Calculating coverage…</p>
              ) : (
                <>
                  <p>
                    {coverage.data?.gaps.length
                      ? 'Warning: schedule has coverage gaps.'
                      : 'No full-schedule coverage gaps in this range.'}{' '}
                    {coverage.data?.layerGaps.length
                      ? `${coverage.data.layerGaps.length} segments have uncovered layers.`
                      : ''}
                  </p>
                  <ol className="oncall-timeline">
                    {coverage.data?.segments.map((segment) => (
                      <li key={segment.startsAt}>
                        <Times value={segment.startsAt} timezone={selected.timezone} /> →{' '}
                        <Times value={segment.endsAt} timezone={selected.timezone} />
                        <p>
                          {segment.layerRecipients
                            .map(
                              (layer) =>
                                `${selected.layers.find((item) => item.id === layer.layerId)?.name}: ${layer.userId ? name(layer.userId) : 'GAP'}${layer.overrideId ? ' (override)' : ''}`,
                            )
                            .join('; ')}
                        </p>
                      </li>
                    ))}
                  </ol>
                </>
              )}
              <h3>Overrides</h3>
              {overrides.isLoading ? (
                <p>Loading overrides…</p>
              ) : !overrides.data?.items.length ? (
                <p>No overrides.</p>
              ) : (
                <ul>
                  {overrides.data.items.map((item) => (
                    <li key={item.id}>
                      <Times value={item.startsAt} timezone={selected.timezone} /> →{' '}
                      <Times value={item.endsAt} timezone={selected.timezone} />:{' '}
                      {name(item.replacementUserId)} — {item.reason};{' '}
                      {item.cancelledAt ? 'cancelled' : 'active'}
                      {!item.cancelledAt && (admin || item.createdBy === userId) && (
                        <button
                          onClick={() =>
                            setConfirmation({
                              label: 'Cancel this override? Historical records are retained.',
                              path: `schedules/${selected.id}/overrides/${item.id}/cancel`,
                            })
                          }
                        >
                          Cancel override
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              {overrides.data && (
                <div>
                  <button
                    disabled={historyPage === 1}
                    onClick={() => setHistoryPage(historyPage - 1)}
                  >
                    Previous overrides
                  </button>
                  <button
                    disabled={historyPage >= overrides.data.pagination.pages}
                    onClick={() => setHistoryPage(historyPage + 1)}
                  >
                    Next overrides
                  </button>
                </div>
              )}
              {(admin || selected.allowSelfOverrides) && (
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    execute(`schedules/${selected.id}/overrides`, override);
                  }}
                >
                  <h3>Create {admin ? '' : 'self-'}override</h3>
                  <label>
                    Rotation layer
                    <select
                      required
                      value={override.layerId}
                      onChange={(event) =>
                        setOverride({ ...override, layerId: event.target.value })
                      }
                    >
                      {selected.layers.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <DateUTC
                    label="Override starts"
                    value={override.startsAt}
                    onChange={(startsAt) => setOverride({ ...override, startsAt })}
                  />
                  <DateUTC
                    label="Override ends"
                    value={override.endsAt}
                    onChange={(endsAt) => setOverride({ ...override, endsAt })}
                  />
                  <SelectRef
                    label="Replacement member"
                    value={override.replacementUserId}
                    items={references.members}
                    onChange={(replacementUserId) =>
                      setOverride({ ...override, replacementUserId })
                    }
                  />
                  {admin && (
                    <SelectRef
                      label="Original member (optional)"
                      optional
                      value={override.originalUserId ?? ''}
                      items={references.members}
                      onChange={(id) =>
                        setOverride({ ...override, originalUserId: id || undefined })
                      }
                    />
                  )}
                  <label>
                    Override reason
                    <input
                      required
                      maxLength={500}
                      value={override.reason}
                      onChange={(event) => setOverride({ ...override, reason: event.target.value })}
                    />
                  </label>
                  <button disabled={command.isPending || !online}>Create override</button>
                </form>
              )}
            </section>
          )}
        </section>
      )}
      {tab === 'policies' && admin && (
        <section>
          <h2>Escalation policies</h2>
          <button onClick={() => setEditor({ resource: 'policies' })}>Create policy</button>
          {policies.isLoading ? (
            <p>Loading policies…</p>
          ) : !policies.data?.items.length ? (
            <p>No policies yet.</p>
          ) : (
            <ul>
              {policies.data.items.map((policy) => (
                <li key={policy.id}>
                  {policy.name}: {policy.steps.length} steps, {policy.repeatCount} repeats,{' '}
                  {policy.enabled ? 'enabled' : 'disabled'}
                  <button onClick={() => setEditor({ resource: 'policies', item: policy })}>
                    Edit {policy.name}
                  </button>
                  <button
                    onClick={() =>
                      setConfirmation({
                        label: `Archive ${policy.name}? Accepted escalations retain their immutable version.`,
                        path: `policies/${policy.id}/archive`,
                      })
                    }
                  >
                    Archive {policy.name}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
      {tab === 'routing' && admin && (
        <section>
          <h2>Alert routing</h2>
          <button onClick={() => setEditor({ resource: 'routing' })}>Create route</button>
          <SelectRef
            label="Fallback policy"
            optional
            value={fallback.data?.policyId ?? ''}
            items={references.policies}
            onChange={(id) => fallbackSave.mutate(id)}
          />
          <p>No matching active route or fallback means the alert stays open without paging.</p>
          {routes.isLoading ? (
            <p>Loading routes…</p>
          ) : !routes.data?.items.length ? (
            <p>No routing rules.</p>
          ) : (
            <ol>
              {routes.data.items.map((rule, index) => (
                <li key={rule.id}>
                  {rule.name}, priority {rule.priority}, {rule.enabled ? 'enabled' : 'disabled'}
                  <Order
                    label={`route ${index + 1}`}
                    index={index}
                    total={routes.data.items.length}
                    onMove={(offset) =>
                      execute('routing/reorder', {
                        ids: move(routes.data.items, index, offset).map((item) => item.id),
                      })
                    }
                  />
                  <button onClick={() => setEditor({ resource: 'routing', item: rule })}>
                    Edit {rule.name}
                  </button>
                  <button
                    onClick={() =>
                      setConfirmation({
                        label: `Archive ${rule.name}?`,
                        path: `routing/${rule.id}/archive`,
                      })
                    }
                  >
                    Archive {rule.name}
                  </button>
                </li>
              ))}
            </ol>
          )}
          <h3>Dry-run routing</h3>
          <AlertForm
            references={references}
            onSubmit={(input) => dryRun.mutate(input)}
            label="Preview route"
            pending={dryRun.isPending}
          />
          <p role="status">{preview}</p>
        </section>
      )}
      {tab === 'alerts' && (
        <section>
          <h2>Active alerts</h2>
          {admin && (
            <button onClick={() => setCreate(!create)}>
              {create ? 'Close alert form' : 'Create alert'}
            </button>
          )}
          {create && admin && (
            <AlertForm
              references={references}
              onSubmit={(input) => createAlertMutation.mutate(input)}
              label="Create alert"
              pending={createAlertMutation.isPending}
            />
          )}
          <div className="oncall-filters">
            <label>
              Status
              <select
                value={status}
                onChange={(event) => {
                  setStatus(event.target.value);
                  setPage(1);
                }}
              >
                {['', 'open', 'acknowledged', 'resolved', 'suppressed'].map((value) => (
                  <option key={value} value={value}>
                    {value || 'All'}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Severity
              <select
                value={severity}
                onChange={(event) => {
                  setSeverity(event.target.value);
                  setPage(1);
                }}
              >
                {['', 'sev1', 'sev2', 'sev3', 'sev4'].map((value) => (
                  <option key={value} value={value}>
                    {value || 'All'}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Search title
              <input
                maxLength={100}
                value={search}
                onChange={(event) => {
                  setSearch(event.target.value);
                  setPage(1);
                }}
              />
            </label>
            <SelectRef
              label="Filter policy"
              optional
              value={filterPolicy}
              items={references.policies}
              onChange={(value) => {
                setFilterPolicy(value);
                setPage(1);
              }}
            />
            {admin && (
              <SelectRef
                label="Filter integration"
                optional
                value={filterIntegration}
                items={references.integrations}
                onChange={(value) => {
                  setFilterIntegration(value);
                  setPage(1);
                }}
              />
            )}
            <SelectRef
              label="Filter incident"
              optional
              value={filterIncident}
              items={references.incidents}
              onChange={(value) => {
                setFilterIncident(value);
                setPage(1);
              }}
            />
            <label>
              Received from (UTC)
              <input
                type="datetime-local"
                value={utcInput(dateFrom)}
                onChange={(event) => {
                  setDateFrom(isoInput(event.target.value));
                  setPage(1);
                }}
              />
            </label>
            <label>
              Received to (UTC)
              <input
                type="datetime-local"
                value={utcInput(dateTo)}
                onChange={(event) => {
                  setDateTo(isoInput(event.target.value));
                  setPage(1);
                }}
              />
            </label>
          </div>
          {alerts.isLoading ? (
            <p>Loading alerts…</p>
          ) : !alerts.data?.items.length ? (
            <p>No alerts match these filters.</p>
          ) : (
            <ul>
              {alerts.data.items.map((alert) => (
                <li key={alert.id}>
                  <button
                    onClick={() => {
                      setSelectedAlert(alert.id);
                      setHistoryPage(1);
                      setIncidentId(alert.linkedIncidentId ?? '');
                    }}
                  >
                    {alert.title}
                  </button>{' '}
                  — {alert.severity.toUpperCase()}, {alert.status}, {alert.occurrenceCount}{' '}
                  occurrence(s)
                </li>
              ))}
            </ul>
          )}
          <div>
            <button disabled={page === 1} onClick={() => setPage(page - 1)}>
              Previous alerts
            </button>
            <span>Page {page}</span>
            <button
              disabled={!alerts.data || page >= alerts.data.pagination.pages}
              onClick={() => setPage(page + 1)}
            >
              Next alerts
            </button>
          </div>
          {detail.isLoading && selectedAlert && <p>Loading alert details…</p>}
          {active && (
            <section className="oncall-panel">
              <h2>{active.title}</h2>
              <p>
                {active.severity.toUpperCase()} — {active.status}; {active.occurrenceCount}{' '}
                occurrences
              </p>
              <p>{active.summary}</p>
              <p>
                First received: <Times value={active.firstReceivedAt} timezone="UTC" />
              </p>
              <p>
                Last received: <Times value={active.lastReceivedAt} timezone="UTC" />
              </p>
              <p>Fingerprint: {active.fingerprint}</p>
              <p>Policy version: {active.escalationPolicyVersion ?? 'unrouted'}</p>
              <button
                disabled={
                  command.isPending || !online || !['open', 'acknowledged'].includes(active.status)
                }
                onClick={() => alertAction('acknowledge')}
              >
                Acknowledge alert
              </button>
              {admin && (
                <>
                  <button
                    disabled={command.isPending || !online}
                    onClick={() =>
                      setConfirmation({
                        label: 'Resolve this alert and cancel future escalation?',
                        path: `alerts/${active.id}/resolve`,
                        body: { operationId: crypto.randomUUID() },
                      })
                    }
                  >
                    Resolve alert
                  </button>
                  <button
                    disabled={command.isPending || !online || active.status === 'open'}
                    onClick={() =>
                      setConfirmation({
                        label: 'Reopen this alert and start a new bounded escalation cycle?',
                        path: `alerts/${active.id}/reopen`,
                        body: { operationId: crypto.randomUUID() },
                      })
                    }
                  >
                    Reopen alert
                  </button>
                  <DateUTC label="Suppress until" value={suppression} onChange={setSuppression} />
                  <button
                    disabled={command.isPending || !online}
                    onClick={() =>
                      setConfirmation({
                        label: 'Suppress this alert until the specified UTC time?',
                        path: `alerts/${active.id}/suppress`,
                        body: { operationId: crypto.randomUUID(), until: suppression },
                      })
                    }
                  >
                    Suppress alert
                  </button>
                  <SelectRef
                    label="Linked incident"
                    optional
                    value={incidentId}
                    items={references.incidents}
                    onChange={setIncidentId}
                  />
                  <button
                    disabled={command.isPending || !online}
                    onClick={() => alertAction('link', { incidentId: incidentId || null })}
                  >
                    {incidentId ? 'Link incident' : 'Unlink incident'}
                  </button>
                  {!active.linkedIncidentId && (
                    <>
                      <label className="oncall-check">
                        <input
                          type="checkbox"
                          checked={confirmSev1}
                          onChange={(event) => setConfirmSev1(event.target.checked)}
                        />
                        Confirm Sev1 incident declaration if required
                      </label>
                      <button
                        disabled={command.isPending || !online}
                        onClick={() =>
                          setConfirmation({
                            label:
                              'Declare an incident from this alert through the incident service?',
                            path: `alerts/${active.id}/declare-incident`,
                            body: { operationId: crypto.randomUUID(), confirmSev1 },
                          })
                        }
                      >
                        Declare incident
                      </button>
                    </>
                  )}
                  {active.linkedIncidentId && (
                    <button
                      disabled={command.isPending || !online}
                      onClick={() => alertAction('timeline')}
                    >
                      Add alert to incident timeline
                    </button>
                  )}
                  <h3>Escalation history</h3>
                  {history.isLoading ? (
                    <p>Loading escalation history…</p>
                  ) : (
                    <>
                      {history.data?.executions.map((execution) => (
                        <p key={execution.id}>
                          Policy version {execution.policyVersion}: {execution.status}; step{' '}
                          {execution.currentStep + 1}, repeat {execution.repeatIndex}
                        </p>
                      ))}
                      <ul>
                        {history.data?.items.map((delivery) => (
                          <li key={delivery.id}>
                            Step {(delivery.step ?? 0) + 1}: {delivery.channel} — {delivery.status},{' '}
                            {delivery.attemptCount} attempts;{' '}
                            {delivery.recipients.map(name).join(', ') || 'no recipient'}{' '}
                            {delivery.error}
                            {delivery.status === 'dead' &&
                              delivery.channel !== 'gap' &&
                              active.status === 'open' && (
                                <button
                                  disabled={command.isPending}
                                  onClick={() =>
                                    setConfirmation({
                                      label:
                                        'Retry this failed delivery? Successful delivery receipts are retained.',
                                      path: `deliveries/${delivery.id}/retry`,
                                      body: { operationId: crypto.randomUUID() },
                                    })
                                  }
                                >
                                  Retry failed delivery
                                </button>
                              )}
                          </li>
                        ))}
                      </ul>
                      {!history.data?.items.length && <p>No escalation deliveries yet.</p>}
                      <button
                        disabled={historyPage === 1}
                        onClick={() => setHistoryPage(historyPage - 1)}
                      >
                        Previous deliveries
                      </button>
                      <button
                        disabled={!history.data || historyPage >= history.data.pagination.pages}
                        onClick={() => setHistoryPage(historyPage + 1)}
                      >
                        Next deliveries
                      </button>
                    </>
                  )}
                </>
              )}
            </section>
          )}
        </section>
      )}
      {tab === 'metrics' && admin && (
        <section>
          <h2>On-call metrics</h2>
          {metrics.isLoading ? (
            <p>Loading metrics…</p>
          ) : (
            metrics.data && (
              <>
                <p>
                  Duration metrics cover alerts first received in the last 30 days, excluding
                  currently suppressed alerts and missing acknowledgement/resolution timestamps.
                </p>
                <p>
                  Mean acknowledgement: {metrics.data.acknowledgement.meanMs ?? 'no sample'} ms;
                  p50: {metrics.data.acknowledgement.p50Ms ?? 'no sample'} ms; p95:{' '}
                  {metrics.data.acknowledgement.p95Ms ?? 'no sample'} ms.
                </p>
                <p>Mean resolution: {metrics.data.resolution.meanMs ?? 'no sample'} ms.</p>
                <p>
                  Escalations: {metrics.data.escalationCount}; duplicate occurrence rate:{' '}
                  {metrics.data.duplicateOccurrenceRate ?? 'no sample'}; terminal delivery failure
                  rate: {metrics.data.deliveryFailureRate ?? 'no sample'}.
                </p>
                <h3>Open alerts by severity</h3>
                <ul>
                  {metrics.data.openBySeverity.map((row) => (
                    <li key={row._id}>
                      {row._id}: {row.count}
                    </li>
                  ))}
                </ul>
                <h3>UTC alert volume</h3>
                <ul>
                  {metrics.data.volume.map((row) => (
                    <li key={row._id}>
                      {row._id}: {row.alerts} alerts / {row.occurrences} occurrences
                    </li>
                  ))}
                </ul>
                <h3>Coverage gaps in the next 24 hours</h3>
                <ul>
                  {metrics.data.coverage.map((row) => (
                    <li key={row.scheduleId}>
                      {references.schedules.find((item) => item.id === row.scheduleId)?.name}:{' '}
                      {row.gapMinutes} minutes
                    </li>
                  ))}
                </ul>
                <h3>Page volume per responder</h3>
                <ul>
                  {metrics.data.pageVolumePerResponder.map((row) => (
                    <li key={row._id}>
                      {name(row._id)}: {row.count}
                    </li>
                  ))}
                </ul>
                <h3>Acknowledged policy steps</h3>
                <ul>
                  {metrics.data.acknowledgedSteps.map((row, index) => (
                    <li key={index}>
                      Policy {row._id.policyId ?? 'none'}, step {(row._id.step ?? 0) + 1}:{' '}
                      {row.count}
                    </li>
                  ))}
                </ul>
              </>
            )
          )}
        </section>
      )}
      {admin && (
        <aside>
          <p>
            References page {refPage}. Change pages to find additional integrations, projects, and
            incidents.
          </p>
          <button disabled={refPage === 1} onClick={() => setRefPage(refPage - 1)}>
            Previous references
          </button>
          <button
            disabled={
              refPage >=
              Math.max(
                integrations.data?.pagination.pages ?? 0,
                incidents.data?.pagination.pages ?? 0,
                projects.data?.pagination.pages ?? 0,
              )
            }
            onClick={() => setRefPage(refPage + 1)}
          >
            Next references
          </button>
        </aside>
      )}
    </main>
  );
}

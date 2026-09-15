import {
  declareIncidentSchema,
  incidentSeveritySchema,
  runbookInputSchema,
  type Incident,
  type Runbook,
  type RunbookInput,
} from '@flowryn/shared';
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';

import { declareIncident, saveRunbook } from '../incidents-api';

export type Person = { user: { _id: string; name: string }; role: string };
export type References = {
  projects: Array<{ _id: string; name: string }>;
  tasks: Array<{ _id: string; title: string }>;
};
export function Choices({
  label,
  values,
  options,
  onChange,
}: {
  label: string;
  values: string[];
  options: Array<{ id: string; name: string }>;
  onChange: (values: string[]) => void;
}) {
  return (
    <fieldset>
      <legend>{label}</legend>
      <div className="incident-choices">
        {options.map((option) => (
          <label key={option.id}>
            <input
              type="checkbox"
              checked={values.includes(option.id)}
              onChange={(event) =>
                onChange(
                  event.target.checked
                    ? [...values, option.id]
                    : values.filter((id) => id !== option.id),
                )
              }
            />
            {option.name}
          </label>
        ))}
        {!options.length && <p>No available choices.</p>}
      </div>
    </fieldset>
  );
}
export function IncidentDeclaration({
  workspaceId,
  admin,
  members,
  references,
  onDone,
}: {
  workspaceId: string;
  admin: boolean;
  members: Person[];
  references: References;
  onDone: (incident: Incident) => void;
}) {
  const [title, setTitle] = useState('');
  const [summary, setSummary] = useState('');
  const [impact, setImpact] = useState('');
  const [severity, setSeverity] = useState('sev3');
  const [commanderId, setCommander] = useState('');
  const [responderIds, setResponders] = useState<string[]>([]);
  const [linkedProjectIds, setProjects] = useState<string[]>([]);
  const [linkedTaskIds, setTasks] = useState<string[]>([]);
  const [confirmed, setConfirmed] = useState(false);
  const [validation, setValidation] = useState('');
  const mutation = useMutation({
    mutationFn: (body: ReturnType<typeof declareIncidentSchema.parse>) =>
      declareIncident(workspaceId, body),
    onSuccess: (data) => onDone(data.incident),
  });
  return (
    <form
      className="dialog-form"
      onSubmit={(event) => {
        event.preventDefault();
        const parsed = declareIncidentSchema.safeParse({
          operationId: crypto.randomUUID(),
          title,
          summary,
          impact,
          severity,
          commanderId: commanderId || null,
          responderIds,
          linkedProjectIds,
          linkedTaskIds,
          confirmSev1: confirmed,
        });
        if (!parsed.success) {
          setValidation(parsed.error.issues.map((issue) => issue.message).join('; '));
          return;
        }
        setValidation('');
        mutation.mutate(parsed.data);
      }}
    >
      <h2>Declare an incident</h2>
      <fieldset disabled={mutation.isPending || mutation.isError}>
        <label>
          Title
          <input
            required
            maxLength={200}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>
        <label>
          Summary
          <textarea
            maxLength={4000}
            value={summary}
            onChange={(event) => setSummary(event.target.value)}
          />
        </label>
        <label>
          Impact
          <textarea
            maxLength={4000}
            value={impact}
            onChange={(event) => setImpact(event.target.value)}
          />
        </label>
        <label>
          Severity
          <select
            value={severity}
            onChange={(event) => {
              setSeverity(event.target.value);
              setConfirmed(false);
            }}
          >
            {incidentSeveritySchema.options.map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
        </label>
        {severity === 'sev1' && (
          <label>
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(event) => setConfirmed(event.target.checked)}
            />
            I confirm this is a sev1 incident requiring immediate response.
          </label>
        )}
        {admin && (
          <>
            <label>
              Commander
              <select value={commanderId} onChange={(event) => setCommander(event.target.value)}>
                <option value="">Unassigned</option>
                {members.map((member) => (
                  <option key={member.user._id} value={member.user._id}>
                    {member.user.name}
                  </option>
                ))}
              </select>
            </label>
            <Choices
              label="Responders"
              values={responderIds}
              options={members.map((member) => ({ id: member.user._id, name: member.user.name }))}
              onChange={setResponders}
            />
          </>
        )}
        <Choices
          label="Linked projects"
          values={linkedProjectIds}
          options={references.projects.map((project) => ({ id: project._id, name: project.name }))}
          onChange={setProjects}
        />
        <Choices
          label="Linked tasks"
          values={linkedTaskIds}
          options={references.tasks.map((task) => ({ id: task._id, name: task.title }))}
          onChange={setTasks}
        />
        <button className="primary-button" disabled={severity === 'sev1' && !confirmed}>
          Declare incident
        </button>
      </fieldset>
      {validation && <p role="alert">{validation}</p>}
      {mutation.error && (
        <>
          <p role="alert">{mutation.error.message}</p>
          <button
            type="button"
            onClick={() => mutation.variables && mutation.mutate(mutation.variables)}
          >
            Retry same declaration
          </button>
          <button type="button" onClick={() => mutation.reset()}>
            Edit declaration
          </button>
        </>
      )}
    </form>
  );
}
export function RunbookEditor({
  workspaceId,
  book,
  userId,
  members,
  onDone,
}: {
  workspaceId: string;
  book?: Runbook;
  userId: string;
  members: Person[];
  onDone: () => void;
}) {
  const [form, setForm] = useState<RunbookInput>(
    book
      ? {
          name: book.name,
          description: book.description,
          ownerId: book.ownerId,
          status: book.status,
          steps: [...book.steps].sort((a, b) => a.position - b.position),
        }
      : { name: '', description: '', ownerId: userId, status: 'draft', steps: [] },
  );
  const mutation = useMutation({
    mutationFn: () => saveRunbook(workspaceId, runbookInputSchema.parse(form), book?.id),
    onSuccess: onDone,
  });
  const move = (index: number, direction: number) => {
    const steps = [...form.steps];
    [steps[index], steps[index + direction]] = [steps[index + direction]!, steps[index]!];
    setForm({ ...form, steps: steps.map((step, position) => ({ ...step, position })) });
  };
  return (
    <form
      className="dialog-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (
          form.status === 'archived' &&
          book?.status !== 'archived' &&
          !window.confirm('Archive this runbook? Existing snapshots remain available.')
        )
          return;
        mutation.mutate();
      }}
    >
      <h2>{book ? 'Edit runbook' : 'Create runbook'}</h2>
      <fieldset disabled={mutation.isPending}>
        <label>
          Runbook name
          <input
            required
            maxLength={200}
            value={form.name}
            onChange={(event) => setForm({ ...form, name: event.target.value })}
          />
        </label>
        <label>
          Description
          <textarea
            maxLength={4000}
            value={form.description}
            onChange={(event) => setForm({ ...form, description: event.target.value })}
          />
        </label>
        <label>
          Owner
          <select
            value={form.ownerId}
            onChange={(event) => setForm({ ...form, ownerId: event.target.value })}
          >
            {members.map((member) => (
              <option key={member.user._id} value={member.user._id}>
                {member.user.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Runbook status
          <select
            value={form.status}
            onChange={(event) =>
              setForm({ ...form, status: event.target.value as RunbookInput['status'] })
            }
          >
            <option>draft</option>
            <option>active</option>
            <option>archived</option>
          </select>
        </label>
        <ol>
          {form.steps.map((step, index) => (
            <li key={step.id}>
              <label>
                Step {index + 1} title
                <input
                  required
                  maxLength={200}
                  value={step.title}
                  onChange={(event) =>
                    setForm({
                      ...form,
                      steps: form.steps.map((item) =>
                        item.id === step.id ? { ...item, title: event.target.value } : item,
                      ),
                    })
                  }
                />
              </label>
              <label>
                Instructions
                <textarea
                  maxLength={4000}
                  value={step.instructions}
                  onChange={(event) =>
                    setForm({
                      ...form,
                      steps: form.steps.map((item) =>
                        item.id === step.id ? { ...item, instructions: event.target.value } : item,
                      ),
                    })
                  }
                />
              </label>
              <button
                type="button"
                aria-label={`Move step ${index + 1} up`}
                disabled={index === 0}
                onClick={() => move(index, -1)}
              >
                Move up
              </button>
              <button
                type="button"
                aria-label={`Move step ${index + 1} down`}
                disabled={index === form.steps.length - 1}
                onClick={() => move(index, 1)}
              >
                Move down
              </button>
              <button
                type="button"
                onClick={() => {
                  if (
                    window.confirm(
                      'Remove this runbook step? Attached incident snapshots remain intact.',
                    )
                  )
                    setForm({
                      ...form,
                      steps: form.steps
                        .filter((item) => item.id !== step.id)
                        .map((item, position) => ({ ...item, position })),
                    });
                }}
              >
                Remove step
              </button>
            </li>
          ))}
        </ol>
        <button
          type="button"
          disabled={form.steps.length >= 100}
          onClick={() =>
            setForm({
              ...form,
              steps: [
                ...form.steps,
                {
                  id: crypto.randomUUID(),
                  title: '',
                  instructions: '',
                  position: form.steps.length,
                },
              ],
            })
          }
        >
          Add step
        </button>
        <button className="primary-button">Save runbook</button>
      </fieldset>
      {mutation.error && <p role="alert">{mutation.error.message}</p>}
    </form>
  );
}

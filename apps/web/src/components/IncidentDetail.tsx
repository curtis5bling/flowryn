import {
  incidentSeveritySchema,
  incidentTransitions,
  type Incident,
  type IncidentCommand,
  type Runbook,
} from '@flowryn/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { commandIncident, incidentPresence, incidentTimeline } from '../incidents-api';

import { Choices, type Person, type References } from './IncidentForms';

export const incidentDate = (value: string | null) =>
  value
    ? new Intl.DateTimeFormat('en', {
        dateStyle: 'medium',
        timeStyle: 'short',
        timeZone: 'UTC',
      }).format(new Date(value)) + ' UTC'
    : 'Not yet';
export function IncidentDetail({
  workspaceId,
  incident,
  admin,
  userId,
  members,
  references,
  books,
}: {
  workspaceId: string;
  incident: Incident;
  admin: boolean;
  userId: string;
  members: Person[];
  references: References;
  books: Runbook[];
}) {
  const client = useQueryClient();
  const [page, setPage] = useState(1);
  const [message, setMessage] = useState('');
  const [mentions, setMentions] = useState<string[]>([]);
  const [resolution, setResolution] = useState('');
  const [title, setTitle] = useState(incident.title);
  const [summary, setSummary] = useState(incident.summary);
  const [impact, setImpact] = useState(incident.impact);
  const [severity, setSeverity] = useState(incident.severity);
  const [responders, setResponders] = useState(incident.responderIds);
  const [projects, setProjects] = useState(incident.linkedProjectIds);
  const [tasks, setTasks] = useState(incident.linkedTaskIds);
  const timeline = useQuery({
    queryKey: ['incident-timeline', workspaceId, incident.id, page],
    queryFn: () => incidentTimeline(workspaceId, incident.id, page),
    refetchInterval: 15000,
  });
  const presence = useQuery({
    queryKey: ['incident-presence', workspaceId, incident.id],
    queryFn: () => incidentPresence(workspaceId, incident.id),
    refetchInterval: 10000,
  });
  const mutation = useMutation({
    mutationFn: (body: IncidentCommand) => commandIncident(workspaceId, incident.id, body),
    onSuccess: async () => {
      setMessage('');
      for (const key of [
        'incidents',
        'incident',
        'incident-timeline',
        'incident-metrics',
        'notifications',
        'notification-count',
      ])
        await client.invalidateQueries({ queryKey: [key, workspaceId] });
    },
  });
  const act = (command: IncidentCommand['command']) =>
    mutation.mutate({ operationId: crypto.randomUUID(), command });
  const control = admin || incident.commanderId === userId;
  const readOnly = Boolean(incident.archivedAt);
  const person = (id: string | null) =>
    members.find((member) => member.user._id === id)?.user.name ??
    (id ? 'Former member' : 'Unassigned');
  return (
    <article className="incident-detail">
      <header>
        <p>{incident.incidentNumber}</p>
        <h1>{incident.title}</h1>
        <p aria-live="polite">
          <strong>{incident.severity.toUpperCase()}</strong> | {incident.status}
          {readOnly ? ' | Archived (read-only)' : ''}
        </p>
        <p>{incident.summary}</p>
        <h3>Impact</h3>
        <p>{incident.impact || 'No impact recorded.'}</p>
        <p>
          Commander: {person(incident.commanderId)} | Responders:{' '}
          {incident.responderIds.map(person).join(', ') || 'None'}
        </p>
        <p>
          Declared {incidentDate(incident.declaredAt)} | Acknowledged{' '}
          {incidentDate(incident.acknowledgedAt)} | Resolved {incidentDate(incident.resolvedAt)}
        </p>
        <p aria-live="polite">
          Viewing now:{' '}
          {presence.data?.users.map((user) => user.name).join(', ') || 'No presence available'}
        </p>
        {presence.error && (
          <p role="status">Presence unavailable; incident actions remain available.</p>
        )}
      </header>
      {mutation.error && (
        <div role="alert">
          <p>{mutation.error.message}</p>
          <button
            disabled={mutation.isPending}
            onClick={() => mutation.variables && mutation.mutate(mutation.variables)}
          >
            Retry same action
          </button>
          <button onClick={() => mutation.reset()}>Dismiss</button>
        </div>
      )}
      <fieldset disabled={readOnly || mutation.isPending || mutation.isError}>
        {control && (
          <section>
            <h2>Response controls</h2>
            {incidentTransitions[incident.status].map((status) => (
              <button
                key={status}
                disabled={status === 'resolved' && !resolution.trim()}
                onClick={() => {
                  if (
                    (status === 'resolved' || incident.status === 'resolved') &&
                    !window.confirm(
                      status === 'resolved'
                        ? 'Resolve this incident with the entered summary?'
                        : 'Reopen this resolved incident?',
                    )
                  )
                    return;
                  act({
                    action: 'transition',
                    status,
                    ...(status === 'resolved' ? { resolutionSummary: resolution } : {}),
                  });
                }}
              >
                {incident.status === 'resolved'
                  ? 'Reopen incident'
                  : status === 'investigating'
                    ? 'Acknowledge and investigate'
                    : `Move to ${status}`}
              </button>
            ))}
            {incident.status === 'monitoring' && (
              <label>
                Resolution summary
                <textarea
                  maxLength={4000}
                  value={resolution}
                  onChange={(event) => setResolution(event.target.value)}
                />
              </label>
            )}
            <label>
              Assign commander
              <select
                value={incident.commanderId ?? ''}
                onChange={(event) =>
                  act({ action: 'commander', userId: event.target.value || null })
                }
              >
                <option value="">Unassigned</option>
                {members.map((member) => (
                  <option key={member.user._id} value={member.user._id}>
                    {member.user.name}
                  </option>
                ))}
              </select>
            </label>
            <Choices
              label="Response team"
              values={responders}
              onChange={setResponders}
              options={members.map((member) => ({ id: member.user._id, name: member.user.name }))}
            />
            <button onClick={() => act({ action: 'responders', userIds: responders })}>
              Save responders
            </button>
            <details>
              <summary>Edit incident</summary>
              <label>
                Title
                <input
                  value={title}
                  maxLength={200}
                  onChange={(event) => setTitle(event.target.value)}
                />
              </label>
              <label>
                Summary
                <textarea
                  value={summary}
                  maxLength={4000}
                  onChange={(event) => setSummary(event.target.value)}
                />
              </label>
              <label>
                Impact
                <textarea
                  value={impact}
                  maxLength={4000}
                  onChange={(event) => setImpact(event.target.value)}
                />
              </label>
              <label>
                Severity
                <select
                  value={severity}
                  onChange={(event) => setSeverity(event.target.value as Incident['severity'])}
                >
                  {incidentSeveritySchema.options.map((value) => (
                    <option key={value}>{value}</option>
                  ))}
                </select>
              </label>
              <button
                disabled={!title.trim()}
                onClick={() => {
                  if (
                    severity === 'sev1' &&
                    incident.severity !== 'sev1' &&
                    !window.confirm('Escalate this incident to sev1?')
                  )
                    return;
                  act({ action: 'edit', fields: { title, summary, impact, severity } });
                }}
              >
                Save incident
              </button>
            </details>
          </section>
        )}
        <section>
          <h2>Linked work</h2>
          <ul>
            {incident.linkedProjectIds.map((id) => (
              <li key={id}>
                Project:{' '}
                {references.projects.find((project) => project._id === id)?.name ??
                  'Unavailable project'}
              </li>
            ))}
            {incident.linkedTaskIds.map((id) => (
              <li key={id}>
                Task:{' '}
                {references.tasks.find((task) => task._id === id)?.title ?? 'Unavailable task'}
              </li>
            ))}
          </ul>
          {control && (
            <details>
              <summary>Change linked work</summary>
              <Choices
                label="Projects"
                values={projects}
                onChange={setProjects}
                options={references.projects.map((project) => ({
                  id: project._id,
                  name: project.name,
                }))}
              />
              <Choices
                label="Tasks"
                values={tasks}
                onChange={setTasks}
                options={references.tasks.map((task) => ({ id: task._id, name: task.title }))}
              />
              <button
                onClick={() => act({ action: 'links', projectIds: projects, taskIds: tasks })}
              >
                Save links
              </button>
            </details>
          )}
        </section>
        <section>
          <h2>Runbook progress</h2>
          {incident.runbooks.map((book) => (
            <div key={book.runbookId}>
              <h3>
                {book.name} ({book.steps.filter((step) => step.completedAt).length}/
                {book.steps.length})
              </h3>
              <ol>
                {[...book.steps]
                  .sort((a, b) => a.position - b.position)
                  .map((step) => (
                    <li key={step.id}>
                      <label>
                        <input
                          type="checkbox"
                          checked={Boolean(step.completedAt)}
                          disabled={!control && !incident.responderIds.includes(userId)}
                          onChange={(event) =>
                            act({
                              action: 'step',
                              runbookId: book.runbookId,
                              stepId: step.id,
                              completed: event.target.checked,
                            })
                          }
                        />
                        {step.title}
                      </label>
                      <p>{step.instructions}</p>
                      {step.completedAt && (
                        <small>
                          Completed by {person(step.completedBy)} at{' '}
                          {incidentDate(step.completedAt)}
                        </small>
                      )}
                    </li>
                  ))}
              </ol>
            </div>
          ))}
          {control && (
            <label>
              Attach active runbook
              <select
                value=""
                onChange={(event) => {
                  if (event.target.value)
                    act({ action: 'attach-runbook', runbookId: event.target.value });
                }}
              >
                <option value="">Choose a runbook</option>
                {books
                  .filter(
                    (book) =>
                      book.status === 'active' &&
                      !incident.runbooks.some((attached) => attached.runbookId === book.id),
                  )
                  .map((book) => (
                    <option key={book.id} value={book.id}>
                      {book.name}
                    </option>
                  ))}
              </select>
            </label>
          )}
        </section>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            act({ action: 'timeline', message, mentionIds: mentions });
          }}
        >
          <h2>Add timeline update</h2>
          <label>
            Update
            <textarea
              required
              maxLength={4000}
              value={message}
              onChange={(event) => setMessage(event.target.value)}
            />
          </label>
          <Choices
            label="Notify mentioned members"
            values={mentions}
            onChange={setMentions}
            options={members.map((member) => ({ id: member.user._id, name: member.user.name }))}
          />
          <button disabled={!message.trim()}>Add update</button>
        </form>
        {admin && incident.status === 'resolved' && (
          <button
            onClick={() => {
              if (window.confirm('Archive this resolved incident? It will become read-only.'))
                act({ action: 'archive' });
            }}
          >
            Archive incident
          </button>
        )}
      </fieldset>
      {incident.resolutionSummary && (
        <section>
          <h2>Resolution</h2>
          <p>{incident.resolutionSummary}</p>
        </section>
      )}
      <section>
        <h2>Timeline</h2>
        {timeline.isLoading && <p role="status">Loading timeline...</p>}
        {timeline.error && (
          <p role="alert">
            {timeline.error.message}
            <button onClick={() => void timeline.refetch()}>Retry timeline</button>
          </p>
        )}
        <ol className="incident-timeline">
          {timeline.data?.items.map((event) => (
            <li key={event.id}>
              <time dateTime={event.createdAt}>{incidentDate(event.createdAt)}</time>
              <p>
                {person(event.actorId)} |{' '}
                {event.eventType.replace('incident.', '').replaceAll('_', ' ')}
              </p>
              <p>{event.message}</p>
              {event.previousValue && (
                <small>
                  {event.previousValue} | {event.nextValue}
                </small>
              )}
            </li>
          ))}
        </ol>
        <button disabled={page === 1} onClick={() => setPage(page - 1)}>
          Earlier updates
        </button>
        <button
          disabled={page >= (timeline.data?.pagination.pages ?? 1)}
          onClick={() => setPage(page + 1)}
        >
          Later updates
        </button>
        <p role="status">{timeline.data?.pagination.total ?? 0} timeline entries</p>
      </section>
    </article>
  );
}

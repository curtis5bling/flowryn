import { incidentSeveritySchema, incidentStatusSchema, type Runbook } from '@flowryn/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import { listMembers } from '../api';
import {
  archiveRunbook,
  getIncident,
  incidentMetrics,
  incidentReferences,
  listIncidents,
  listRunbooks,
} from '../incidents-api';
import { bindRealtime, connectRealtime, type ConnectionState } from '../realtime';

import { IncidentDetail, incidentDate } from './IncidentDetail';
import { IncidentDeclaration, RunbookEditor } from './IncidentForms';
import { NotificationCenter } from './WorkspaceApp';

export function IncidentApp({
  workspaceId,
  workspaceName,
  userId,
  role,
  onLogout,
}: {
  workspaceId: string;
  workspaceName: string;
  userId: string;
  role: string;
  onLogout: () => void;
}) {
  const client = useQueryClient();
  const [view, setView] = useState<'incidents' | 'declare' | 'runbooks'>('incidents');
  const [selectedId, setSelected] = useState<string>();
  const [editing, setEditing] = useState<Runbook | 'new'>();
  const [filters, setFilters] = useState<Record<string, string>>({ page: '1', archived: 'false' });
  const [bookPage, setBookPage] = useState(1);
  const [referencePage, setReferencePage] = useState(1);
  const [connection, setConnection] = useState<ConnectionState>('connecting');
  const [online, setOnline] = useState(navigator.onLine);
  const admin = role === 'owner' || role === 'admin';
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);
  useEffect(
    () =>
      bindRealtime(connectRealtime(), workspaceId, undefined, client, setConnection, selectedId),
    [workspaceId, selectedId, client],
  );
  const incidents = useQuery({
    queryKey: ['incidents', workspaceId, filters],
    queryFn: () => listIncidents(workspaceId, filters),
    refetchInterval: 15000,
  });
  const detail = useQuery({
    queryKey: ['incident', workspaceId, selectedId],
    queryFn: () => getIncident(workspaceId, selectedId!),
    enabled: Boolean(selectedId),
    refetchInterval: 15000,
  });
  const metrics = useQuery({
    queryKey: ['incident-metrics', workspaceId, filters],
    queryFn: () => incidentMetrics(workspaceId, filters),
    refetchInterval: 15000,
  });
  const members = useQuery({
    queryKey: ['members', workspaceId],
    queryFn: () => listMembers(workspaceId),
  });
  const references = useQuery({
    queryKey: ['incident-references', workspaceId, referencePage],
    queryFn: () => incidentReferences(workspaceId, referencePage),
  });
  const books = useQuery({
    queryKey: ['runbooks', workspaceId, bookPage],
    queryFn: () => listRunbooks(workspaceId, bookPage),
  });
  const archive = useMutation({
    mutationFn: (id: string) => archiveRunbook(workspaceId, id),
    onSuccess: () => client.invalidateQueries({ queryKey: ['runbooks', workspaceId] }),
  });
  const filter = (key: string, value: string) =>
    setFilters({ ...filters, [key]: value, page: '1' });
  const person = (id: string | null) =>
    members.data?.members.find((member) => member.user._id === id)?.user.name ??
    (id ? 'Former member' : 'Unassigned');
  const duration = (ms: number | null) =>
    ms === null ? 'No completed samples' : `${(ms / 60000).toFixed(1)} minutes`;
  return (
    <main className="incident-app">
      <header className="topbar">
        <div className="brand">
          <span>f</span> flowryn
        </div>
        <strong>{workspaceName}</strong>
        <NotificationCenter workspaceId={workspaceId} />
        <button onClick={onLogout}>Sign out</button>
      </header>
      <div className="incident-content">
        <nav aria-label="Incident navigation">
          <button
            onClick={() => {
              setView('incidents');
              setSelected(undefined);
            }}
          >
            Incidents
          </button>
          <button
            onClick={() => {
              setView('runbooks');
              setSelected(undefined);
            }}
          >
            Runbooks
          </button>
          <button
            className="primary-button"
            onClick={() => {
              setView('declare');
              setSelected(undefined);
            }}
          >
            Declare incident
          </button>
        </nav>
        <p role="status">
          {online
            ? `Live updates: ${connection}`
            : 'Offline - showing cached data. Reconnect before changing incidents.'}
        </p>
        {(members.error || references.error) && (
          <p role="alert">
            Member or linked-work choices unavailable.{' '}
            <button
              onClick={() => {
                void members.refetch();
                void references.refetch();
              }}
            >
              Retry choices
            </button>
          </p>
        )}
        {(view === 'declare' || selectedId) && (
          <details>
            <summary>Browse linked-work and runbook choices</summary>
            <p>
              Linked work page {referencePage}; runbook page {bookPage}. Existing selections are
              retained across pages.
            </p>
            <button
              disabled={referencePage === 1}
              onClick={() => setReferencePage(referencePage - 1)}
            >
              Previous linked-work choices
            </button>
            <button
              disabled={referencePage >= (references.data?.pages ?? 1)}
              onClick={() => setReferencePage(referencePage + 1)}
            >
              Next linked-work choices
            </button>
            <button disabled={bookPage === 1} onClick={() => setBookPage(bookPage - 1)}>
              Previous runbook choices
            </button>
            <button
              disabled={bookPage >= (books.data?.pagination.pages ?? 1)}
              onClick={() => setBookPage(bookPage + 1)}
            >
              Next runbook choices
            </button>
          </details>
        )}
        {view === 'declare' && (
          <fieldset disabled={!online}>
            <IncidentDeclaration
              workspaceId={workspaceId}
              admin={admin}
              members={members.data?.members ?? []}
              references={references.data ?? { projects: [], tasks: [] }}
              onDone={(incident) => {
                setSelected(incident.id);
                setView('incidents');
                void client.invalidateQueries({ queryKey: ['incidents', workspaceId] });
                void client.invalidateQueries({ queryKey: ['incident-metrics', workspaceId] });
              }}
            />
          </fieldset>
        )}
        {view === 'incidents' && selectedId && (
          <>
            <button onClick={() => setSelected(undefined)}>Back to incidents</button>
            {detail.isLoading && <p role="status">Loading incident...</p>}
            {detail.error && (
              <p role="alert">
                {detail.error.message}
                <button onClick={() => void detail.refetch()}>Retry incident</button>
              </p>
            )}
            {detail.data && (
              <fieldset disabled={!online}>
                <IncidentDetail
                  key={selectedId}
                  workspaceId={workspaceId}
                  incident={detail.data.incident}
                  admin={admin}
                  userId={userId}
                  members={members.data?.members ?? []}
                  references={references.data ?? { projects: [], tasks: [] }}
                  books={books.data?.items ?? []}
                />
              </fieldset>
            )}
          </>
        )}
        {view === 'incidents' && !selectedId && (
          <>
            <h1>Incident response</h1>
            <div className="incident-filters">
              <label>
                Search title
                <input
                  type="search"
                  maxLength={100}
                  value={filters.q ?? ''}
                  onChange={(event) => filter('q', event.target.value)}
                />
              </label>
              <label>
                Status
                <select
                  value={filters.status ?? ''}
                  onChange={(event) => filter('status', event.target.value)}
                >
                  <option value="">All statuses</option>
                  {incidentStatusSchema.options.map((status) => (
                    <option key={status}>{status}</option>
                  ))}
                </select>
              </label>
              <label>
                Severity
                <select
                  value={filters.severity ?? ''}
                  onChange={(event) => filter('severity', event.target.value)}
                >
                  <option value="">All severities</option>
                  {incidentSeveritySchema.options.map((severity) => (
                    <option key={severity}>{severity}</option>
                  ))}
                </select>
              </label>
              {(['commanderId', 'responderId'] as const).map((key) => (
                <label key={key}>
                  {key === 'commanderId' ? 'Commander' : 'Responder'}
                  <select
                    value={filters[key] ?? ''}
                    onChange={(event) => filter(key, event.target.value)}
                  >
                    <option value="">Anyone</option>
                    {members.data?.members.map((member) => (
                      <option key={member.user._id} value={member.user._id}>
                        {member.user.name}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
              {(['from', 'to'] as const).map((key) => (
                <label key={key}>
                  Declared {key} (UTC)
                  <input
                    type="date"
                    value={filters[key]?.slice(0, 10) ?? ''}
                    onChange={(event) =>
                      filter(
                        key,
                        event.target.value
                          ? `${event.target.value}T${key === 'from' ? '00:00:00.000' : '23:59:59.999'}Z`
                          : '',
                      )
                    }
                  />
                </label>
              ))}
              <label>
                Archive
                <select
                  value={filters.archived}
                  onChange={(event) => filter('archived', event.target.value)}
                >
                  <option value="false">Current incidents</option>
                  <option value="true">Archived only</option>
                </select>
              </label>
            </div>
            <section>
              <h2>Operational metrics</h2>
              <p>
                Metrics use the filters above and the declaration date range. Times use the first
                acknowledgement and current resolution; unresolved and reopened incidents are
                excluded from MTTR. Missing timestamps are excluded, not counted as zero.
              </p>
              {metrics.isLoading && <p role="status">Loading metrics...</p>}
              {metrics.error && (
                <p role="alert">
                  Metrics unavailable.{' '}
                  <button onClick={() => void metrics.refetch()}>Retry metrics</button>
                </p>
              )}
              {metrics.data && (
                <>
                  <div className="incident-metrics">
                    {incidentSeveritySchema.options.map((severity) => (
                      <p key={severity}>
                        <strong>
                          {metrics.data.openBySeverity.find((item) => item._id === severity)
                            ?.count ?? 0}
                        </strong>{' '}
                        open {severity.toUpperCase()}
                      </p>
                    ))}
                    <p>
                      MTTA: {duration(metrics.data.averages.meanAcknowledgeMs)} (
                      {metrics.data.averages.acknowledgedCount} samples)
                    </p>
                    <p>
                      MTTR: {duration(metrics.data.averages.meanResolveMs)} (
                      {metrics.data.averages.resolvedCount} samples)
                    </p>
                  </div>
                  <details>
                    <summary>Created and resolved over time</summary>
                    <table>
                      <caption>Daily counts (UTC), filtered declaration cohort</caption>
                      <thead>
                        <tr>
                          <th>Date</th>
                          <th>Created</th>
                          <th>Resolved</th>
                        </tr>
                      </thead>
                      <tbody>
                        {[
                          ...new Set(
                            [...metrics.data.createdOverTime, ...metrics.data.resolvedOverTime].map(
                              (item) => item._id,
                            ),
                          ),
                        ]
                          .sort()
                          .map((date) => (
                            <tr key={date}>
                              <th>{date}</th>
                              <td>
                                {metrics.data.createdOverTime.find((item) => item._id === date)
                                  ?.count ?? 0}
                              </td>
                              <td>
                                {metrics.data.resolvedOverTime.find((item) => item._id === date)
                                  ?.count ?? 0}
                              </td>
                            </tr>
                          ))}
                      </tbody>
                    </table>
                  </details>
                </>
              )}
            </section>
            {incidents.isLoading && <p role="status">Loading incidents...</p>}
            {incidents.error && (
              <p role="alert">
                {incidents.error.message}
                <button onClick={() => void incidents.refetch()}>Retry list</button>
              </p>
            )}
            {incidents.data?.items.length === 0 && <p>No incidents match these filters.</p>}
            <ul className="incident-list">
              {incidents.data?.items.map((incident) => (
                <li key={incident.id}>
                  <button onClick={() => setSelected(incident.id)}>
                    <strong>
                      {incident.incidentNumber} | {incident.title}
                    </strong>
                    <span>
                      {incident.severity.toUpperCase()} | {incident.status}{' '}
                      {incident.archivedAt ? '| Archived' : ''}
                    </span>
                    <span>
                      Commander: {person(incident.commanderId)} | Responders:{' '}
                      {incident.responderIds.map(person).join(', ') || 'None'}
                    </span>
                    <span>
                      {Math.max(
                        0,
                        Math.floor((Date.now() - Date.parse(incident.declaredAt)) / 60000),
                      )}{' '}
                      minutes since declaration | {incidentDate(incident.declaredAt)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            <button
              disabled={filters.page === '1'}
              onClick={() => setFilters({ ...filters, page: String(Number(filters.page) - 1) })}
            >
              Previous incidents
            </button>
            <button
              disabled={Number(filters.page) >= (incidents.data?.pagination.pages ?? 1)}
              onClick={() => setFilters({ ...filters, page: String(Number(filters.page) + 1) })}
            >
              Next incidents
            </button>
            <p>
              {incidents.data?.pagination.total ?? 0} incidents | Page {filters.page}
            </p>
          </>
        )}
        {view === 'runbooks' && (
          <>
            <h1>Runbooks</h1>
            {admin && <button onClick={() => setEditing('new')}>Create runbook</button>}
            {books.isLoading && <p role="status">Loading runbooks...</p>}
            {books.error && (
              <p role="alert">
                {books.error.message}
                <button onClick={() => void books.refetch()}>Retry runbooks</button>
              </p>
            )}
            {archive.error && <p role="alert">{archive.error.message}</p>}
            {!books.isLoading && !books.data?.items.length && <p>No runbooks yet.</p>}
            {books.data?.items.map((book) => (
              <section key={book.id}>
                <h2>{book.name}</h2>
                <p>
                  {book.status} | Owner: {person(book.ownerId)} | {book.steps.length} steps
                </p>
                <p>{book.description}</p>
                {admin && (
                  <>
                    <button onClick={() => setEditing(book)}>Edit {book.name}</button>
                    <button
                      disabled={!online || book.status === 'archived' || archive.isPending}
                      onClick={() => {
                        if (
                          window.confirm(
                            'Archive this runbook? Existing incident snapshots remain available.',
                          )
                        )
                          archive.mutate(book.id);
                      }}
                    >
                      Archive {book.name}
                    </button>
                  </>
                )}
              </section>
            ))}
            <button disabled={bookPage === 1} onClick={() => setBookPage(bookPage - 1)}>
              Previous runbooks
            </button>
            <button
              disabled={bookPage >= (books.data?.pagination.pages ?? 1)}
              onClick={() => setBookPage(bookPage + 1)}
            >
              Next runbooks
            </button>
            {editing && (
              <>
                <button onClick={() => setEditing(undefined)}>Close editor</button>
                <fieldset disabled={!online}>
                  <RunbookEditor
                    key={editing === 'new' ? 'new' : editing.id}
                    workspaceId={workspaceId}
                    userId={userId}
                    book={editing === 'new' ? undefined : editing}
                    members={members.data?.members ?? []}
                    onDone={() => {
                      setEditing(undefined);
                      void client.invalidateQueries({ queryKey: ['runbooks', workspaceId] });
                    }}
                  />
                </fieldset>
              </>
            )}
          </>
        )}
      </div>
    </main>
  );
}

import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import { apiUrl } from '../api';
import { getPublicStatus, subscribeStatus, unsubscribeStatus } from '../status-api';

const labels: Record<string, string> = {
  operational: 'All systems operational',
  degradedPerformance: 'Degraded performance',
  partialOutage: 'Partial outage',
  majorOutage: 'Major outage',
  maintenance: 'Under maintenance',
};
export function PublicStatusPage({ slug }: { slug: string }) {
  const [email, setEmail] = useState('');
  const unsubscribeToken = new URLSearchParams(globalThis.location?.search ?? '').get('unsubscribe');
  const status = useQuery({
    queryKey: ['public-status', slug],
    queryFn: () => getPublicStatus(slug),
    enabled: !unsubscribeToken,
    refetchInterval: 30000,
    retry: 2,
  });
  const subscription = useMutation({ mutationFn: () => subscribeStatus(slug, email), onSuccess: () => setEmail('') });
  const unsubscribe = useMutation({ mutationFn: () => unsubscribeStatus(slug, unsubscribeToken ?? '') });
  useEffect(() => {
    const description = document.querySelector<HTMLMetaElement>('meta[name="description"]');
    const previousDescription = description?.content;
    if (status.data) {
      document.title = `${status.data.page.name} status`;
      if (description) description.content = status.data.page.description.slice(0, 200);
    }
    return () => {
      document.title = 'Flowryn';
      if (description && previousDescription !== undefined) description.content = previousDescription;
    };
  }, [status.data]);
  useEffect(() => {
    if (!globalThis.EventSource || unsubscribeToken) return;
    const source = new EventSource(`${apiUrl}/api/status/${encodeURIComponent(slug)}/events`);
    source.addEventListener('change', () => void status.refetch());
    return () => source.close();
  }, [slug, unsubscribeToken]);
  if (unsubscribeToken)
    return (
      <main className="public-status">
        <section>
          <h1>Unsubscribe from status updates</h1>
          <p>Use this one-time link to stop future updates.</p>
          <button disabled={unsubscribe.isPending} onClick={() => unsubscribe.mutate()}>
            Unsubscribe
          </button>
          {unsubscribe.isSuccess ? <p role="status">Unsubscribe request processed.</p> : null}
          {unsubscribe.isError ? <p role="alert">The unsubscribe request could not be processed.</p> : null}
        </section>
      </main>
    );
  if (status.isLoading)
    return (
      <main className="public-status">
        <p role="status">Loading service health…</p>
      </main>
    );
  if (status.isError || !status.data)
    return (
      <main className="public-status">
        <h1>Status temporarily unavailable</h1>
        <button onClick={() => status.refetch()}>Try again</button>
      </main>
    );
  const data = status.data;
  const pageTime = (value: string) =>
    new Intl.DateTimeFormat(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZone: data.page.timezone,
      timeZoneName: 'short',
    }).format(new Date(value));
  return (
    <main
      className="public-status"
      style={{ '--status-accent': data.page.branding.primaryColor } as React.CSSProperties}
    >
      <header>
        <p className="eyebrow">Service status</p>
        <h1>{data.page.name}</h1>
        <p>{data.page.description}</p>
        {data.page.supportUrl ? <a href={data.page.supportUrl}>Support</a> : null}
      </header>
      <section className={`overall-status status-${data.overallStatus}`} aria-live="polite">
        <h2>{labels[data.overallStatus]}</h2>
        <p>
          Last updated{' '}
          <time dateTime={data.page.lastUpdatedAt}>
            {new Date(data.page.lastUpdatedAt).toLocaleString()}
          </time>
        </p>
      </section>
      <section>
        <h2>Components</h2>
        {data.components.length ? (
          <ul className="status-list">
            {data.components.map((component) => (
              <li key={component.id}>
                <span>
                  <strong>{component.name}</strong>
                  <small>{component.description}</small>
                </span>
                <span className={`status-pill status-${component.status}`}>
                  {labels[component.status]}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p>No public components.</p>
        )}
      </section>
      <section>
        <h2>Recent incidents</h2>
        {data.incidents.filter((incident) => incident.status === 'resolved').length ? data.incidents
          .filter((incident) => incident.status === 'resolved')
          .map((incident) => <article key={incident.id}><h3>{incident.title}</h3><p>{incident.summary}</p>{incident.updates.map((update) => <div key={update.id}><strong>{update.status}</strong> — {update.message} <time dateTime={update.publishedAt}>{new Date(update.publishedAt).toLocaleString()}</time></div>)}<p>Resolved <time dateTime={incident.resolvedAt ?? incident.publishedAt}>{new Date(incident.resolvedAt ?? incident.publishedAt).toLocaleString()}</time></p></article>) : <p>No recent incidents.</p>}
      </section>
      <section>
        <h2>Active incidents</h2>
        {data.incidents
          .filter((x) => x.status !== 'resolved')
          .map((incident) => (
            <article key={incident.id}>
              <h3>{incident.title}</h3>
              <p>{incident.summary}</p>
              {incident.updates.map((update) => (
                <div key={update.id}>
                  <strong>{update.status}</strong> — {update.message}{' '}
                  <time dateTime={update.publishedAt}>
                    {new Date(update.publishedAt).toLocaleString()}
                  </time>
                </div>
              ))}
            </article>
          ))}
      </section>
      <section>
        <h2>Scheduled maintenance</h2>
        {data.maintenance.length ? (
          data.maintenance.map((item) => (
            <article key={item.id}>
              <h3>{item.title}</h3>
              <p>{item.description}</p>
              <time dateTime={item.scheduledStartAt}>{pageTime(item.scheduledStartAt)}</time>
            </article>
          ))
        ) : (
          <p>No upcoming maintenance.</p>
        )}
      </section>
      <section>
        <h2>Get updates</h2>
        {unsubscribeToken ? <div><p>Use this one-time link to stop future updates.</p><button disabled={unsubscribe.isPending} onClick={() => unsubscribe.mutate()}>Unsubscribe</button>{unsubscribe.isSuccess ? <p role="status">Unsubscribe request processed.</p> : null}</div> : data.subscriptionsAvailable ? <form onSubmit={(event) => { event.preventDefault(); subscription.mutate(); }}><label>Email address<input type="email" required value={email} onChange={(event) => setEmail(event.target.value)} /></label><button disabled={subscription.isPending}>Subscribe</button>{subscription.isSuccess ? <p role="status">Check your email to confirm.</p> : null}</form> : <p>Subscriptions are unavailable until a delivery adapter is configured.</p>}
      </section>
    </main>
  );
}

import {
  QueryClient,
  QueryClientProvider,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';

import { createWorkspace, getCurrentUser, listWorkspaces, login, logout, register } from './api';
import { AutomationApp } from './components/AutomationApp';
import { IncidentApp } from './components/IncidentApp';
import { IntelligenceApp } from './components/IntelligenceApp';
import { OncallApp } from './components/OncallApp';
import { PublicStatusPage } from './components/PublicStatusPage';
import { ReliabilityApp } from './components/ReliabilityApp';
import { StatusAdminApp } from './components/StatusAdminApp';
import { WorkspaceApp } from './components/WorkspaceApp';
import './styles.css';

const queryClient = new QueryClient();

type AuthMode = 'login' | 'register';

function AuthShell({
  mode,
  onModeChange,
}: {
  mode: AuthMode;
  onModeChange: (mode: AuthMode) => void;
}) {
  const authQueryClient = useQueryClient();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const mutation = useMutation({
    mutationFn: () =>
      mode === 'login' ? login({ email, password }) : register({ name, email, password }),
    onSuccess: (data) => authQueryClient.setQueryData(['me'], data),
  });

  return (
    <main className="auth-page min-h-screen">
      <div className="auth-intro">
        <div className="brand">
          <span>f</span> flowryn
        </div>
        <p className="eyebrow">Intelligent work orchestration</p>
        <h1>
          Make space for <em>better</em> work.
        </h1>
        <p className="muted intro-copy">
          Turn everyday work into intelligent workflows, with every workspace and next step in view.
        </p>
      </div>
      <section className="auth-card">
        <p className="eyebrow">{mode === 'login' ? 'Welcome back' : 'Start your flow'}</p>
        <h2>{mode === 'login' ? 'Sign in to Flowryn' : 'Create your account'}</h2>
        <p className="muted">
          {mode === 'login'
            ? 'Pick up where your work left off.'
            : 'Your first workspace is ready when you are.'}
        </p>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            mutation.mutate();
          }}
        >
          {mode === 'register' && (
            <label>
              Name
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Your name"
                required
                minLength={2}
              />
            </label>
          )}
          <label>
            Email
            <input
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="you@company.com"
              required
            />
          </label>
          <label>
            Password
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="8 characters minimum"
              required
              minLength={mode === 'register' ? 8 : 1}
            />
          </label>
          {mutation.error && <p className="form-error">{mutation.error.message}</p>}
          <button className="primary-button" disabled={mutation.isPending}>
            {mutation.isPending ? 'Opening...' : mode === 'login' ? 'Sign in' : 'Create account'}{' '}
            <span aria-hidden="true">→</span>
          </button>
        </form>
        <button
          className="text-button"
          onClick={() => onModeChange(mode === 'login' ? 'register' : 'login')}
        >
          {mode === 'login'
            ? 'New to Flowryn? Create an account'
            : 'Already have an account? Sign in'}
        </button>
      </section>
    </main>
  );
}

function Onboarding({ onComplete }: { onComplete: () => void }) {
  const [workspaceName, setWorkspaceName] = useState('');
  const mutation = useMutation({
    mutationFn: () => createWorkspace(workspaceName),
    onSuccess: onComplete,
  });
  return (
    <main className="center-page">
      <div className="onboarding-card">
        <div className="brand">
          <span>f</span> flowryn
        </div>
        <p className="eyebrow">One last step</p>
        <h1>Where does your work live?</h1>
        <p className="muted">
          Create a workspace for a team, a client, or the projects you are moving forward.
        </p>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            mutation.mutate();
          }}
        >
          <label>
            Workspace name
            <input
              value={workspaceName}
              onChange={(event) => setWorkspaceName(event.target.value)}
              placeholder="e.g. Product studio"
              required
              minLength={2}
            />
          </label>
          {mutation.error && <p className="form-error">{mutation.error.message}</p>}
          <button className="primary-button" disabled={mutation.isPending}>
            {mutation.isPending ? 'Creating...' : 'Enter workspace'} <span aria-hidden="true">→</span>
          </button>
        </form>
      </div>
    </main>
  );
}

function App() {
  const me = useQuery({ queryKey: ['me'], queryFn: getCurrentUser, retry: false });
  const workspaces = useQuery({
    queryKey: ['workspaces'],
    queryFn: listWorkspaces,
    enabled: Boolean(me.data),
  });
  const initialPath = window.location.pathname + window.location.search;
  const [area, setArea] = useState<'projects' | 'incidents' | 'automation' | 'oncall' | 'status' | 'reliability' | 'intelligence'>(() => window.location.pathname.startsWith('/intelligence') ? 'intelligence' : window.location.pathname.startsWith('/incidents') ? 'incidents' : window.location.pathname.startsWith('/oncall') ? 'oncall' : window.location.pathname.startsWith('/reliability') ? 'reliability' : window.location.pathname.startsWith('/automation') ? 'automation' : window.location.pathname === '/status' ? 'status' : 'projects');
  const [sourceTarget, setSourceTarget] = useState(initialPath === '/' ? '' : initialPath);
  const [authMode, setAuthMode] = useState<AuthMode>('login');
  const [showOnboarding, setShowOnboarding] = useState(false);
  const logoutMutation = useMutation({
    mutationFn: logout,
    onSuccess: async () => {
      await queryClient.cancelQueries();
      queryClient.clear();
      queryClient.setQueryData(['me'], null);
    },
  });
  if (me.isLoading)
    return (
      <main className="center-page">
        <div className="loading-mark">f</div>
      </main>
    );
  if (!me.data) return <AuthShell mode={authMode} onModeChange={setAuthMode} />;
  if (showOnboarding || (!workspaces.isLoading && workspaces.data?.workspaces.length === 0))
    return (
      <Onboarding
        onComplete={() => {
          setShowOnboarding(false);
          void queryClient.invalidateQueries({ queryKey: ['workspaces'] });
        }}
      />
    );
  const activeWorkspace = workspaces.data?.workspaces[0];
  if (!activeWorkspace)
    return (
      <Onboarding
        onComplete={() => {
          void queryClient.invalidateQueries({ queryKey: ['workspaces'] });
        }}
      />
    );
  return (
    <>
      <nav className="area-navigation" aria-label="Workspace areas">
        <button aria-pressed={area === 'projects'} onClick={() => setArea('projects')}>
          Projects
        </button>
        <button aria-pressed={area === 'incidents'} onClick={() => setArea('incidents')}>
          Incident response
        </button>
        <button aria-pressed={area === 'automation'} onClick={() => setArea('automation')}>
          Automation
        </button>
        <button aria-pressed={area === 'oncall'} onClick={() => setArea('oncall')}>
          On-Call
        </button>
        <button aria-pressed={area === 'status'} onClick={() => setArea('status')}>Status pages</button>
        <button aria-pressed={area === 'reliability'} onClick={() => setArea('reliability')}>Reliability</button>
        <button aria-pressed={area === 'intelligence'} onClick={() => setArea('intelligence')}>Priorities</button>
      </nav>
      {area === 'intelligence' ? <IntelligenceApp workspaceId={activeWorkspace.id} role={activeWorkspace.role} onNavigate={(deepLink) => { window.history.replaceState({}, '', deepLink); setSourceTarget(deepLink); setArea(deepLink.startsWith('/intelligence') ? 'intelligence' : deepLink.startsWith('/incidents') ? 'incidents' : deepLink.startsWith('/oncall') ? 'oncall' : deepLink.startsWith('/reliability') ? 'reliability' : deepLink.startsWith('/automation') ? 'automation' : deepLink.startsWith('/status') ? 'status' : 'projects'); }} /> : area === 'reliability' ? <ReliabilityApp workspaceId={activeWorkspace.id} role={activeWorkspace.role} initialServiceId={new URL(sourceTarget || '/', window.location.origin).searchParams.get('service') ?? undefined} initialMonitorId={new URL(sourceTarget || '/', window.location.origin).searchParams.get('monitor') ?? undefined} initialSloId={new URL(sourceTarget || '/', window.location.origin).searchParams.get('slo') ?? undefined} initialRunId={new URL(sourceTarget || '/', window.location.origin).searchParams.get('run') ?? undefined} /> : area === 'status' ? <StatusAdminApp workspaceId={activeWorkspace.id} role={activeWorkspace.role} initialPageId={new URL(sourceTarget || '/', window.location.origin).searchParams.get('page') ?? undefined} initialMaintenanceId={new URL(sourceTarget || '/', window.location.origin).searchParams.get('maintenance') ?? undefined} /> : area === 'oncall' ? (
        <OncallApp
          workspaceId={activeWorkspace.id}
          workspaceName={activeWorkspace.name}
          userId={me.data.user.id}
          role={activeWorkspace.role}
          onLogout={() => logoutMutation.mutate()}
          initialAlertId={new URL(sourceTarget || '/', window.location.origin).searchParams.get('alert') ?? undefined}
          initialScheduleId={new URL(sourceTarget || '/', window.location.origin).searchParams.get('schedule') ?? undefined}
        />
      ) : area === 'automation' ? (
        <AutomationApp
          workspaceId={activeWorkspace.id}
          workspaceName={activeWorkspace.name}
          role={activeWorkspace.role}
          onLogout={() => logoutMutation.mutate()}
          initialDeadLetterId={new URL(sourceTarget || '/', window.location.origin).searchParams.get('dead') ?? undefined}
          initialRunId={new URL(sourceTarget || '/', window.location.origin).searchParams.get('run') ?? undefined}
        />
      ) : area === 'incidents' ? (
        <IncidentApp
          workspaceId={activeWorkspace.id}
          workspaceName={activeWorkspace.name}
          userId={me.data.user.id}
          role={activeWorkspace.role}
          onLogout={() => logoutMutation.mutate()}
          initialIncidentId={sourceTarget.startsWith('/incidents/') ? sourceTarget.split('/')[2]?.split('?')[0] : undefined}
        />
      ) : (
        <WorkspaceApp
          workspaceId={activeWorkspace.id}
          workspaceName={activeWorkspace.name}
          userName={me.data.user.name}
          onLogout={() => logoutMutation.mutate()}
          initialProjectId={sourceTarget.startsWith('/projects/') ? sourceTarget.split('/')[2]?.split('?')[0] : undefined}
          initialTaskId={new URL(sourceTarget || '/', window.location.origin).searchParams.get('task') ?? undefined}
        />
      )}
    </>
  );
}

const statusMatch = window.location.pathname.match(/^\/status\/([a-z0-9-]+)\/?$/);
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      {statusMatch ? <PublicStatusPage slug={statusMatch[1]!} /> : <App />}
    </QueryClientProvider>
  </StrictMode>,
);

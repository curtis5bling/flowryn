import { QueryClient, QueryClientProvider, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';

import { createWorkspace, getCurrentUser, listWorkspaces, login, logout, register } from './api';
import './styles.css';

const queryClient = new QueryClient();

type AuthMode = 'login' | 'register';

function AuthShell({ mode, onModeChange }: { mode: AuthMode; onModeChange: (mode: AuthMode) => void }) {
  const authQueryClient = useQueryClient();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const mutation = useMutation({
    mutationFn: () => mode === 'login' ? login({ email, password }) : register({ name, email, password }),
    onSuccess: (data) => authQueryClient.setQueryData(['me'], data),
  });

  return (
    <main className="auth-page min-h-screen">
      <div className="auth-intro"><div className="brand"><span>f</span> flowryn</div><p className="eyebrow">Intelligent work orchestration</p><h1>Make space for <em>better</em> work.</h1><p className="muted intro-copy">Turn everyday work into intelligent workflows, with every workspace and next step in view.</p></div>
      <section className="auth-card"><p className="eyebrow">{mode === 'login' ? 'Welcome back' : 'Start your flow'}</p><h2>{mode === 'login' ? 'Sign in to Flowryn' : 'Create your account'}</h2><p className="muted">{mode === 'login' ? 'Pick up where your work left off.' : 'Your first workspace is ready when you are.'}</p>
        <form onSubmit={(event) => { event.preventDefault(); mutation.mutate(); }}>
          {mode === 'register' && <label>Name<input value={name} onChange={(event) => setName(event.target.value)} placeholder="Your name" required minLength={2} /></label>}
          <label>Email<input type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@company.com" required /></label>
          <label>Password<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="8 characters minimum" required minLength={mode === 'register' ? 8 : 1} /></label>
          {mutation.error && <p className="form-error">{mutation.error.message}</p>}
          <button className="primary-button" disabled={mutation.isPending}>{mutation.isPending ? 'Opening...' : mode === 'login' ? 'Sign in' : 'Create account'} <span>↗</span></button>
        </form>
        <button className="text-button" onClick={() => onModeChange(mode === 'login' ? 'register' : 'login')}>{mode === 'login' ? 'New to Flowryn? Create an account' : 'Already have an account? Sign in'}</button>
      </section>
    </main>
  );
}

function Onboarding({ onComplete }: { onComplete: () => void }) {
  const [workspaceName, setWorkspaceName] = useState('');
  const mutation = useMutation({ mutationFn: () => createWorkspace(workspaceName), onSuccess: onComplete });
  return <main className="center-page"><div className="onboarding-card"><div className="brand"><span>f</span> flowryn</div><p className="eyebrow">One last step</p><h1>Where does your work live?</h1><p className="muted">Create a workspace for a team, a client, or the projects you are moving forward.</p><form onSubmit={(event) => { event.preventDefault(); mutation.mutate(); }}><label>Workspace name<input value={workspaceName} onChange={(event) => setWorkspaceName(event.target.value)} placeholder="e.g. Product studio" required minLength={2} /></label>{mutation.error && <p className="form-error">{mutation.error.message}</p>}<button className="primary-button" disabled={mutation.isPending}>{mutation.isPending ? 'Creating...' : 'Enter workspace'} <span>↗</span></button></form></div></main>;
}

function Dashboard({ user, onLogout }: { user: { name: string }; onLogout: () => void }) {
  const workspaces = useQuery({ queryKey: ['workspaces'], queryFn: listWorkspaces });
  const activeWorkspace = workspaces.data?.workspaces[0];
  return <main className="dashboard-page"><header className="topbar"><div className="brand"><span>f</span> flowryn</div><div className="topbar-actions"><span className="muted greeting">Good morning, {user.name.split(' ')[0]}</span><button className="avatar-button" onClick={onLogout} title="Sign out">{user.name.slice(0, 2).toUpperCase()}</button></div></header><section className="dashboard-content"><div className="dashboard-heading"><div><p className="eyebrow">{activeWorkspace?.name ?? 'Your workspace'}</p><h1>Make space for <em>better</em> work.</h1><p className="muted intro-copy">Your work is moving. Here is the clearest view of what matters today.</p></div><button className="primary-button compact">Open today&apos;s flow <span>↗</span></button></div><div className="metric-grid"><div><strong>16</strong><span>open tasks</span></div><div><strong>04</strong><span>in motion</span></div><div><strong className="coral">02:40</strong><span>deep work</span></div></div><div className="work-panel"><div className="panel-heading"><div><p className="eyebrow">Overview</p><h2>Active workstreams</h2></div><span className="status-pill">+18% focus</span></div>{['Product launch', 'Q4 customer review', 'Team rituals'].map((name, index) => <div className="stream" key={name}><div className="stream-label"><strong>{name}</strong><span>{[72, 46, 88][index]}%</span></div><div className="progress"><i style={{ width: `${[72, 46, 88][index]}%` }} /></div><span className="muted stream-detail">{index === 0 ? '8 tasks · 2 blockers' : index === 1 ? '5 tasks · On track' : '3 tasks · Due today'}</span></div>)}</div></section></main>;
}

function App() {
  const me = useQuery({ queryKey: ['me'], queryFn: getCurrentUser, retry: false });
  const workspaces = useQuery({ queryKey: ['workspaces'], queryFn: listWorkspaces, enabled: Boolean(me.data) });
  const [authMode, setAuthMode] = useState<AuthMode>('login');
  const [showOnboarding, setShowOnboarding] = useState(false);
  const logoutMutation = useMutation({ mutationFn: logout, onSuccess: () => queryClient.setQueryData(['me'], undefined) });
  if (me.isLoading) return <main className="center-page"><div className="loading-mark">f</div></main>;
  if (!me.data) return <AuthShell mode={authMode} onModeChange={setAuthMode} />;
  if (showOnboarding || (!workspaces.isLoading && workspaces.data?.workspaces.length === 0)) return <Onboarding onComplete={() => { setShowOnboarding(false); void queryClient.invalidateQueries({ queryKey: ['workspaces'] }); }} />;
  return <Dashboard user={me.data.user} onLogout={() => logoutMutation.mutate()} />;
}

createRoot(document.getElementById('root')!).render(<StrictMode><QueryClientProvider client={queryClient}><App /></QueryClientProvider></StrictMode>);

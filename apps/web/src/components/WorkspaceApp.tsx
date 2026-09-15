import type { AuthResponse, Project, Task, TaskPriority, TaskStatus } from '@flowryn/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import { archiveProject, createComment, createProject, createTask, deleteComment, deleteTask, listComments, listMembers, listProjectActivity, listProjects, listTasks, listNotifications, listPresence, markAllNotificationsRead, markNotificationRead, moveTask, unreadNotificationCount, updateComment, updateProject, updateTask, type TaskFilters } from '../api';
import { boardStatuses, groupTasks, isOverdue } from '../board';
import { bindRealtime, connectRealtime, type ConnectionState } from '../realtime';

const labels: Record<TaskStatus, string> = { backlog: 'Backlog', todo: 'To do', in_progress: 'In progress', review: 'Review', done: 'Done' };
const priorities: TaskPriority[] = ['low', 'medium', 'high', 'urgent'];

function ProjectForm({ workspaceId, project, onDone }: { workspaceId: string; project?: Project; onDone: () => void }) {
  const [name, setName] = useState(project?.name ?? '');
  const [description, setDescription] = useState(project?.description ?? '');
  const [color, setColor] = useState(project?.color ?? '#d7674d');
  const mutation = useMutation({ mutationFn: () => project ? updateProject(workspaceId, project.id, { name, description, color }) : createProject(workspaceId, { name, description, color }), onSuccess: onDone });
  return <form className="dialog-form" onSubmit={(event) => { event.preventDefault(); mutation.mutate(); }}><label>Project name<input value={name} onChange={(event) => setName(event.target.value)} required minLength={2} /></label><label>Description<textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={3} /></label><label>Color<input type="color" value={color} onChange={(event) => setColor(event.target.value)} /></label>{mutation.error && <p className="form-error">{mutation.error.message}</p>}<button className="primary-button" disabled={mutation.isPending}>{mutation.isPending ? 'Saving...' : project ? 'Save project' : 'Create project'}</button></form>;
}

function TaskForm({ workspaceId, projectId, task, members, onDone }: { workspaceId: string; projectId: string; task?: Task; members: Array<{ user: { _id: string; name: string }; role: string }>; onDone: () => void }) {
  const [title, setTitle] = useState(task?.title ?? '');
  const [description, setDescription] = useState(task?.description ?? '');
  const [priority, setPriority] = useState<TaskPriority>(task?.priority ?? 'medium');
  const [status, setStatus] = useState<TaskStatus>(task?.status ?? 'backlog');
  const [assigneeId, setAssigneeId] = useState(task?.assigneeId ?? '');
  const [dueDate, setDueDate] = useState(task?.dueDate?.slice(0, 10) ?? '');
  const queryClient = useQueryClient();
  const mutation = useMutation({ mutationFn: () => task ? updateTask(workspaceId, task.id, { title, description, status, priority, dueDate: dueDate ? new Date(`${dueDate}T23:59:59.000Z`).toISOString() : null, assigneeId: assigneeId || null }) : createTask(workspaceId, projectId, { title, description, status, assigneeId: assigneeId || null, priority, dueDate: dueDate ? new Date(`${dueDate}T23:59:59.000Z`).toISOString() : null }), onSuccess: async () => { await queryClient.invalidateQueries({ queryKey: ['tasks', workspaceId, projectId] }); onDone(); } });
  return <><form className="dialog-form" onSubmit={(event) => { event.preventDefault(); mutation.mutate(); }}><label>Title<input value={title} onChange={(event) => setTitle(event.target.value)} required /></label><label>Description<textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={4} /></label><div className="form-grid"><label>Priority<select value={priority} onChange={(event) => setPriority(event.target.value as TaskPriority)}>{priorities.map((item) => <option key={item}>{item}</option>)}</select></label><label>Status<select value={status} onChange={(event) => setStatus(event.target.value as TaskStatus)}>{boardStatuses.map((item) => <option key={item} value={item}>{labels[item]}</option>)}</select></label></div><div className="form-grid"><label>Assignee<select value={assigneeId} onChange={(event) => setAssigneeId(event.target.value)}><option value="">Unassigned</option>{members.map((member) => <option key={member.user._id} value={member.user._id}>{member.user.name}</option>)}</select></label><label>Due date<input type="date" value={dueDate} onChange={(event) => setDueDate(event.target.value)} /></label></div>{mutation.error && <p className="form-error">{mutation.error.message}</p>}<button className="primary-button" disabled={mutation.isPending}>{mutation.isPending ? 'Saving...' : task ? 'Save task' : 'Create task'}</button></form>{task && <CollaborationPanel workspaceId={workspaceId} projectId={projectId} taskId={task.id} />}</>;
}

function TaskCard({ task, onEdit, onMove, onDelete }: { task: Task; onEdit: () => void; onMove: (status: TaskStatus) => void; onDelete: () => void }) {
  return <article className={`task-card ${isOverdue(task.dueDate, task.status) ? 'overdue' : ''}`}><button className="task-title" onClick={onEdit}>{task.title}</button><div className="task-meta"><span className={`priority priority-${task.priority}`}>{task.priority}</span>{task.dueDate && <span>{isOverdue(task.dueDate, task.status) ? 'Overdue' : new Date(task.dueDate).toLocaleDateString()}</span>}</div><div className="task-actions"><select aria-label={`Move ${task.title}`} value={task.status} onChange={(event) => onMove(event.target.value as TaskStatus)}>{boardStatuses.map((status) => <option value={status} key={status}>{labels[status]}</option>)}</select><button className="icon-button" onClick={onDelete} title="Delete task">×</button></div></article>;
}

function ActivityFeed({ workspaceId, projectId }: { workspaceId: string; projectId: string }) {
  const activity = useQuery({ queryKey: ['activity', workspaceId, projectId], queryFn: () => listProjectActivity(workspaceId, projectId) });
  return <aside className="activity-feed"><div className="panel-heading"><h3>Activity</h3><span className="muted">Recent</span></div>{activity.isLoading && <p className="muted">Loading activity...</p>}{activity.error && <p className="form-error">Unable to load activity.</p>}{activity.data?.activities.length === 0 && <p className="muted">No activity yet.</p>}{activity.data?.activities.map((entry) => <div className="activity-item" key={entry.id}><strong>{entry.action.replace('.', ' ')}</strong><span>{new Date(entry.timestamp).toLocaleString()}</span></div>)}</aside>;
}

function CollaborationPanel({ workspaceId, projectId, taskId }: { workspaceId: string; projectId: string; taskId: string }) {
  const queryClient = useQueryClient();
  const [body, setBody] = useState('');
  const [page, setPage] = useState(1);
  const viewer = queryClient.getQueryData<AuthResponse>(['me'])?.user.id;
  const role = queryClient.getQueryData<Awaited<ReturnType<typeof listMembers>>>(['members', workspaceId])?.members.find((member) => member.user._id === viewer)?.role;
  const comments = useQuery({ queryKey: ['comments', workspaceId, taskId, page], queryFn: () => listComments(workspaceId, projectId, taskId, page) });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['comments', workspaceId, taskId] });
  const createMutation = useMutation({ mutationFn: () => createComment(workspaceId, projectId, taskId, body), onSuccess: async () => { setBody(''); await refresh(); } });
  const deleteMutation = useMutation({ mutationFn: (id: string) => deleteComment(workspaceId, id), onSuccess: refresh });
  const editMutation = useMutation({ mutationFn: ({ id, text }: { id: string; text: string }) => updateComment(workspaceId, id, text), onSuccess: refresh });
  return <section className="discussion">
    <div className="panel-heading"><h3>Discussion</h3><span className="muted">{comments.data?.pagination.total ?? 0}</span></div>
    {comments.isLoading && <p className="muted">Loading comments...</p>}
    {comments.error && <p className="form-error">Unable to load comments.</p>}
    {comments.data?.items.length === 0 && <p>No comments yet.</p>}
    {comments.data?.items.map((comment) => <article className="comment" key={comment.id}>
      <div className="comment-heading"><strong>{comment.authorId?.name ?? 'Former member'}</strong><span>{new Date(comment.createdAt).toLocaleString()}{comment.editedAt ? ' · edited' : ''}</span></div>
      <p>{comment.body}</p>
      {(comment.authorId?._id === viewer || role === 'owner' || role === 'admin') && <>
        <button className="text-button" onClick={() => { const text = window.prompt('Edit comment', comment.body); if (text?.trim()) editMutation.mutate({ id: comment.id, text }); }}>Edit</button>
        <button className="text-button danger-text" onClick={() => { if (window.confirm('Delete this comment?')) deleteMutation.mutate(comment.id); }}>Delete</button>
      </>}
    </article>)}
    <div><button disabled={page === 1} onClick={() => setPage(page - 1)}>Previous comments</button><button disabled={page >= (comments.data?.pagination.pages ?? 1)} onClick={() => setPage(page + 1)}>Next comments</button></div>
    {(createMutation.error || editMutation.error || deleteMutation.error) && <p role="alert">Unable to save comment changes. Please retry.</p>}
    <form className="comment-form" onSubmit={(event) => { event.preventDefault(); if (body.trim()) createMutation.mutate(); }}>
      <textarea value={body} onChange={(event) => setBody(event.target.value)} maxLength={2000} required placeholder="Add to the discussion..." aria-label="Comment" />
      <button className="primary-button compact" disabled={createMutation.isPending}>{createMutation.isPending ? 'Posting...' : 'Comment'}</button>
    </form>
  </section>;
}

export function NotificationCenter({ workspaceId }: { workspaceId: string }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState(1);
  const count = useQuery({ queryKey: ['notification-count', workspaceId], queryFn: () => unreadNotificationCount(workspaceId) });
  const notifications = useQuery({ queryKey: ['notifications', workspaceId, page], queryFn: () => listNotifications(workspaceId, page), enabled: open });
  const refresh = async () => {
    await Promise.all(['notification-count', 'notifications'].map((key) => queryClient.invalidateQueries({ queryKey: [key, workspaceId] })));
  };
  const mark = useMutation({ mutationFn: (id: string) => markNotificationRead(workspaceId, id), onSuccess: refresh });
  const markAll = useMutation({ mutationFn: () => markAllNotificationsRead(workspaceId), onSuccess: refresh });
  return <div className="notification-center">
    <button className="bell-button" onClick={() => setOpen(!open)} aria-label="Notifications" aria-expanded={open}>Notifications {(count.data?.count ?? 0) > 0 && <b>{count.data?.count}</b>}</button>
    {open && <div className="notification-panel">
      <div className="panel-heading"><h3>Notifications</h3><button className="text-button" disabled={markAll.isPending} onClick={() => markAll.mutate()}>Mark all read</button></div>
      {notifications.isLoading && <p>Loading notifications...</p>}
      {(notifications.error || count.error || mark.error || markAll.error) && <p role="alert">Notifications unavailable. Please retry.</p>}
      {notifications.data?.items.length === 0 && <p>No notifications yet.</p>}
      {notifications.data?.items.map((notification) => <button className={`notification-item ${notification.readAt ? '' : 'unread'}`} key={notification.id} disabled={mark.isPending} onClick={() => mark.mutate(notification.id)}><strong>{notification.title}</strong><span>{new Date(notification.createdAt).toLocaleString()}</span></button>)}
      <button disabled={page === 1} onClick={() => setPage(page - 1)}>Previous notifications</button><button disabled={page >= (notifications.data?.pagination.pages ?? 1)} onClick={() => setPage(page + 1)}>Next notifications</button>
    </div>}
  </div>;
}

export function WorkspaceApp({ workspaceId, workspaceName, userName, onLogout }: { workspaceId: string; workspaceName: string; userName: string; onLogout: () => void }) {
  const queryClient = useQueryClient();
  const [selectedProjectId, setSelectedProjectId] = useState('');
  const [dialog, setDialog] = useState<'project' | 'task' | 'edit-project' | 'edit-task' | null>(null);
  const [editingTask, setEditingTask] = useState<Task>();
  const [filters, setFilters] = useState<TaskFilters>({});
  const projects = useQuery({ queryKey: ['projects', workspaceId], queryFn: () => listProjects(workspaceId) });
  const selectedProject = projects.data?.items.find((project) => project.id === selectedProjectId) ?? projects.data?.items[0];
  const tasks = useQuery({ queryKey: ['tasks', workspaceId, selectedProject?.id, filters], queryFn: () => listTasks(workspaceId, selectedProject!.id, filters), enabled: Boolean(selectedProject?.id) });
  const members = useQuery({ queryKey: ['members', workspaceId], queryFn: () => listMembers(workspaceId) });
  const presence = useQuery({ queryKey: ['presence', workspaceId], queryFn: () => listPresence(workspaceId), refetchInterval: 10000 });
  const [connectionState, setConnectionState] = useState<ConnectionState>('connecting');
  useEffect(() => bindRealtime(connectRealtime(), workspaceId, selectedProject?.id, queryClient, setConnectionState), [workspaceId, selectedProject?.id, queryClient]);
  const moveMutation = useMutation({ mutationFn: ({ taskId, status }: { taskId: string; status: TaskStatus }) => moveTask(workspaceId, taskId, status), onMutate: async ({ taskId, status }) => { if (!selectedProject) return; const key = ['tasks', workspaceId, selectedProject.id, filters]; await queryClient.cancelQueries({ queryKey: key }); const previous = queryClient.getQueryData<{ items: Task[] }>(key); queryClient.setQueryData(key, (data: { items: Task[] } | undefined) => data ? { ...data, items: data.items.map((task) => task.id === taskId ? { ...task, status } : task) } : data); return { previous, key }; }, onError: (_error, _variables, context) => { if (context) queryClient.setQueryData(context.key, context.previous); }, onSettled: () => { if (selectedProject) void queryClient.invalidateQueries({ queryKey: ['tasks', workspaceId, selectedProject.id] }); } });
  const deleteMutation = useMutation({ mutationFn: (taskId: string) => deleteTask(workspaceId, taskId), onSuccess: () => { if (selectedProject) void queryClient.invalidateQueries({ queryKey: ['tasks', workspaceId, selectedProject.id] }); } });
  const columns = groupTasks(tasks.data?.items ?? []);
  const closeDialog = () => { setDialog(null); setEditingTask(undefined); };
  return <main className="app-page"><header className="topbar"><div className="brand"><span>f</span> flowryn</div><NotificationCenter workspaceId={workspaceId} /><div className="workspace-switcher"><span>{workspaceName}</span><button className="avatar-button" onClick={onLogout} title="Sign out">{userName.slice(0, 2).toUpperCase()}</button></div></header><section className="workspace-content"><p role="status">{connectionState === 'connected' ? 'Live updates connected' : `Live updates: ${connectionState}`}</p><p className="presence-summary">{presence.isLoading ? 'Loading online members...' : presence.error ? 'Online members unavailable' : `${presence.data?.members.length ?? 0} workspace members online`}</p><div className="workspace-heading"><div><p className="eyebrow">Workspace</p><h1>Work that <em>moves</em>.</h1><p className="muted">Projects, tasks, and the trail behind every decision.</p></div><button className="primary-button" onClick={() => setDialog('project')}>New project <span>+</span></button></div><div className="project-strip"><div className="section-heading"><h2>Projects</h2><span className="muted">{projects.data?.pagination.total ?? 0} active</span></div>{projects.isLoading && <p className="muted">Loading projects...</p>}{projects.error && <p className="form-error">Unable to load projects.</p>}{projects.data?.items.map((project) => <button className={`project-card ${selectedProject?.id === project.id ? 'selected' : ''}`} key={project.id} onClick={() => setSelectedProjectId(project.id)}><i style={{ background: project.color }} /><strong>{project.name}</strong><span>{project.taskTotal} tasks · {project.taskTotal ? Math.round(project.completedTasks / project.taskTotal * 100) : 0}% complete</span><b><span style={{ width: `${project.taskTotal ? project.completedTasks / project.taskTotal * 100 : 0}%` }} /></b></button>)}{!projects.isLoading && projects.data?.items.length === 0 && <div className="empty-state"><strong>Your first project is waiting.</strong><span>Create a project to give your work a home.</span><button className="text-button" onClick={() => setDialog('project')}>Create project →</button></div>}</div>{selectedProject && <><div className="board-heading"><div><p className="eyebrow">{selectedProject.name}</p><h2>Task board</h2></div><div className="board-actions"><button className="secondary-button" onClick={() => { if (window.confirm('Archive this project?')) void archiveProject(workspaceId, selectedProject.id).then(() => queryClient.invalidateQueries({ queryKey: ['projects', workspaceId] })); }}>Archive</button><button className="secondary-button" onClick={() => setDialog('edit-project')}>Edit project</button><button className="primary-button compact" onClick={() => setDialog('task')}>New task <span>+</span></button></div></div><div className="filter-bar"><label>Status<select value={filters.status ?? ''} onChange={(event) => setFilters({ ...filters, status: event.target.value || undefined })}><option value="">All statuses</option>{boardStatuses.map((status) => <option value={status} key={status}>{labels[status]}</option>)}</select></label><label>Priority<select value={filters.priority ?? ''} onChange={(event) => setFilters({ ...filters, priority: event.target.value || undefined })}><option value="">All priorities</option>{priorities.map((priority) => <option value={priority} key={priority}>{priority}</option>)}</select></label><label>Assignee<select value={filters.assigneeId ?? ''} onChange={(event) => setFilters({ ...filters, assigneeId: event.target.value || undefined })}><option value="">Everyone</option>{members.data?.members.map((member) => <option value={member.user._id} key={member.user._id}>{member.user.name}</option>)}</select></label><label>Due date<select value={filters.dueDate ?? ''} onChange={(event) => setFilters({ ...filters, dueDate: event.target.value || undefined })}><option value="">Any date</option><option value="overdue">Overdue</option><option value="today">Today</option><option value="upcoming">Upcoming</option></select></label></div><div className="board-layout"><div className="kanban-board">{boardStatuses.map((status) => <section className="kanban-column" key={status}><div className="column-heading"><h3>{labels[status]}</h3><span>{columns[status].length}</span></div>{tasks.isLoading && <p className="muted">Loading...</p>}{columns[status].map((task) => <TaskCard key={task.id} task={task} onEdit={() => { setEditingTask(task); setDialog('edit-task'); }} onMove={(nextStatus) => moveMutation.mutate({ taskId: task.id, status: nextStatus })} onDelete={() => { if (window.confirm(`Delete ${task.title}?`)) deleteMutation.mutate(task.id); }} />)}{!tasks.isLoading && columns[status].length === 0 && <p className="column-empty">No tasks</p>}</section>)}</div><ActivityFeed workspaceId={workspaceId} projectId={selectedProject.id} /></div></>}</section>{dialog && <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) closeDialog(); }}><section className="dialog" role="dialog" aria-modal="true"><button className="dialog-close" onClick={closeDialog} aria-label="Close">×</button><p className="eyebrow">{dialog.includes('project') ? 'Project' : 'Task'}</p><h2>{dialog === 'project' ? 'Create project' : dialog === 'edit-project' ? 'Edit project' : dialog === 'task' ? 'Create task' : 'Edit task'}</h2>{(dialog === 'project' || dialog === 'edit-project') && <ProjectForm workspaceId={workspaceId} project={dialog === 'edit-project' ? selectedProject : undefined} onDone={() => { closeDialog(); void queryClient.invalidateQueries({ queryKey: ['projects', workspaceId] }); }} />}{(dialog === 'task' || dialog === 'edit-task') && selectedProject && <TaskForm workspaceId={workspaceId} projectId={selectedProject.id} task={dialog === 'edit-task' ? editingTask : undefined} members={members.data?.members ?? []} onDone={() => { closeDialog(); void queryClient.invalidateQueries({ queryKey: ['tasks', workspaceId, selectedProject.id] }); }} />}</section></div>}</main>;
}

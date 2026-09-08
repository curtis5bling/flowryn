import type { Task, TaskStatus } from '@flowryn/shared';

export const boardStatuses: TaskStatus[] = ['backlog', 'todo', 'in_progress', 'review', 'done'];

export const groupTasks = (tasks: Task[]) => boardStatuses.reduce<Record<TaskStatus, Task[]>>((columns, status) => {
  columns[status] = tasks.filter((task) => task.status === status).sort((left, right) => left.position - right.position);
  return columns;
}, { backlog: [], todo: [], in_progress: [], review: [], done: [] });

export const isOverdue = (dueDate: string | null, status: TaskStatus) => Boolean(dueDate && status !== 'done' && new Date(dueDate).getTime() < Date.now());
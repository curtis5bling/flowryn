import { describe, expect, it } from 'vitest';

import { groupTasks, isOverdue } from './board';

describe('task board helpers', () => {
  it('groups and orders tasks by status', () => {
    const columns = groupTasks([
      { id: '1', status: 'todo', position: 2 } as never,
      { id: '2', status: 'todo', position: 1 } as never,
      { id: '3', status: 'done', position: 0 } as never,
    ]);
    expect(columns.todo.map((task) => task.id)).toEqual(['2', '1']);
    expect(columns.backlog).toEqual([]);
  });

  it('marks unfinished past-due tasks overdue but not completed tasks', () => {
    const yesterday = new Date(Date.now() - 86_400_000).toISOString();
    expect(isOverdue(yesterday, 'todo')).toBe(true);
    expect(isOverdue(yesterday, 'done')).toBe(false);
  });
});
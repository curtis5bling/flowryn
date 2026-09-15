import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from './app.js';
import { ActivityModel } from './models/Activity.js';
import { AuthSessionModel } from './models/AuthSession.js';
import { ProjectModel } from './models/Project.js';
import { TaskModel } from './models/Task.js';
import { UserModel } from './models/User.js';
import { WorkspaceModel } from './models/Workspace.js';
import { WorkspaceMemberModel } from './models/WorkspaceMember.js';

const app = createApp();
let mongo: MongoMemoryReplSet;
type Session = ReturnType<typeof request.agent>;

const register = async (agent: Session, name: string, email: string) => {
  const response = await agent
    .post('/api/auth/register')
    .send({ name, email, password: 'password123' });
  expect(response.status).toBe(201);
};
const createWorkspace = async (agent: Session) => {
  const response = await agent.post('/api/workspaces').send({ name: 'Product workspace' });
  expect(response.status).toBe(201);
  return response.body.workspace.id as string;
};
const createProject = async (agent: Session, workspaceId: string, name = 'Launch') => {
  const response = await agent
    .post(`/api/workspaces/${workspaceId}/projects`)
    .send({ name, description: 'Ship the next release', color: '#336699' });
  expect(response.status).toBe(201);
  return response.body.project.id as string;
};
const createTask = async (
  agent: Session,
  workspaceId: string,
  projectId: string,
  values: Record<string, unknown> = {},
) => {
  const response = await agent
    .post(`/api/workspaces/${workspaceId}/projects/${projectId}/tasks`)
    .send({ title: 'Write brief', ...values });
  expect(response.status).toBe(201);
  return response.body.task as { id: string; status: string; position: number };
};

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  await Promise.all(Object.values(mongoose.models).map((model) => model.init()));
}, 180000);

beforeEach(async () => {
  await Promise.all([
    ActivityModel.deleteMany({}),
    AuthSessionModel.deleteMany({}),
    TaskModel.deleteMany({}),
    ProjectModel.deleteMany({}),
    UserModel.deleteMany({}),
    WorkspaceModel.deleteMany({}),
    WorkspaceMemberModel.deleteMany({}),
  ]);
});

afterAll(async () => {
  await mongoose.disconnect();
  if (mongo) await mongo.stop();
}, 30000);

describe('projects, tasks, and activity', () => {
  it('allows owners to create, edit, archive projects and exposes task progress', async () => {
    const owner = request.agent(app);
    await register(owner, 'Owner User', 'owner@example.com');
    const workspaceId = await createWorkspace(owner);
    const projectId = await createProject(owner, workspaceId);
    const task = await createTask(owner, workspaceId, projectId, { status: 'done' });

    const listed = await owner.get(`/api/workspaces/${workspaceId}/projects`);
    expect(listed.status).toBe(200);
    expect(listed.body.items[0]).toMatchObject({ id: projectId, taskTotal: 1, completedTasks: 1 });
    const updated = await owner
      .patch(`/api/workspaces/${workspaceId}/projects/${projectId}`)
      .send({ name: 'Launch v2' });
    expect(updated.body.project.name).toBe('Launch v2');
    const archived = await owner.delete(`/api/workspaces/${workspaceId}/projects/${projectId}`);
    expect(archived.status).toBe(200);
    expect(archived.body.project.status).toBe('archived');
    expect(await ActivityModel.countDocuments({ entityId: projectId })).toBeGreaterThanOrEqual(2);
    expect(task.status).toBe('done');
  });

  it('supports task filters, status moves, ordering, and member assignment validation', async () => {
    const owner = request.agent(app);
    const member = request.agent(app);
    await register(owner, 'Owner User', 'owner@example.com');
    await register(member, 'Member User', 'member@example.com');
    const workspaceId = await createWorkspace(owner);
    const projectId = await createProject(owner, workspaceId);
    const memberUser = await UserModel.findOne({ email: 'member@example.com' });
    await owner
      .post(`/api/workspaces/${workspaceId}/members`)
      .send({ email: 'member@example.com', role: 'member' });
    await member
      .post('/api/auth/login')
      .send({ email: 'member@example.com', password: 'password123' });
    const first = await createTask(member, workspaceId, projectId, {
      priority: 'urgent',
      assigneeId: memberUser!._id.toString(),
    });
    await createTask(member, workspaceId, projectId, { priority: 'low' });
    const filtered = await member.get(
      `/api/workspaces/${workspaceId}/projects/${projectId}/tasks?priority=urgent`,
    );
    expect(filtered.body.items).toHaveLength(1);
    expect(filtered.body.items[0].id).toBe(first.id);
    const moved = await member
      .patch(`/api/workspaces/${workspaceId}/tasks/${first.id}/status`)
      .send({ status: 'in_progress' });
    expect(moved.status).toBe(200);
    expect(moved.body.task.status).toBe('in_progress');
    const reordered = await member
      .patch(`/api/workspaces/${workspaceId}/tasks/${first.id}/reorder`)
      .send({ position: 12 });
    expect(reordered.body.task.position).toBe(12);
    const unassigned = await member
      .patch(`/api/workspaces/${workspaceId}/tasks/${first.id}/assignee`)
      .send({});
    expect(unassigned.status).toBe(200);
    expect(unassigned.body.task.assigneeId).toBeNull();
    const invalidAssignee = await member
      .patch(`/api/workspaces/${workspaceId}/tasks/${first.id}/assignee`)
      .send({ assigneeId: new mongoose.Types.ObjectId().toString() });
    expect(invalidAssignee.status).toBe(400);
    await UserModel.updateOne({ email: 'member@example.com' }, { status: 'suspended' });
    const suspendedAssignee = await owner
      .patch(`/api/workspaces/${workspaceId}/tasks/${first.id}/assignee`)
      .send({ assigneeId: memberUser!._id.toString() });
    expect(suspendedAssignee.status).toBe(400);
  });

  it('enforces project permissions and blocks cross-workspace IDs', async () => {
    const ownerA = request.agent(app);
    const ownerB = request.agent(app);
    await register(ownerA, 'Owner A', 'owner-a@example.com');
    await register(ownerB, 'Owner B', 'owner-b@example.com');
    const workspaceA = await createWorkspace(ownerA);
    const workspaceB = await createWorkspace(ownerB);
    const projectA = await createProject(ownerA, workspaceA, 'Private A');
    const projectB = await createProject(ownerB, workspaceB, 'Private B');
    const taskB = await createTask(ownerB, workspaceB, projectB);
    const crossProject = await ownerB.get(`/api/workspaces/${workspaceB}/projects/${projectA}`);
    expect(crossProject.status).toBe(404);
    const crossTask = await ownerA.get(`/api/workspaces/${workspaceA}/tasks/${taskB.id}`);
    expect(crossTask.status).toBe(404);
    const crossMutation = await ownerA
      .patch(`/api/workspaces/${workspaceA}/tasks/${taskB.id}/status`)
      .send({ status: 'done' });
    expect(crossMutation.status).toBe(404);
    const missingProject = await ownerA
      .post(`/api/workspaces/${workspaceA}/projects/${new mongoose.Types.ObjectId()}/tasks`)
      .send({ title: 'Missing project task' });
    expect(missingProject.status).toBe(404);
    const invalidTask = await ownerA
      .patch(`/api/workspaces/${workspaceA}/tasks/invalid/status`)
      .send({ status: 'done' });
    expect(invalidTask.status).toBe(400);
    const crossActivity = await ownerA.get(
      `/api/workspaces/${workspaceA}/projects/${projectA}/activity`,
    );
    expect(crossActivity.status).toBe(200);
    expect(
      crossActivity.body.activities.every(
        (entry: { workspaceId: string }) => entry.workspaceId === workspaceA,
      ),
    ).toBe(true);
  });
});

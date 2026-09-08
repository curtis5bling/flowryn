import bcrypt from 'bcryptjs';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from './app.js';
import { AuthSessionModel } from './models/AuthSession.js';
import { UserModel } from './models/User.js';
import { WorkspaceModel } from './models/Workspace.js';
import { WorkspaceMemberModel } from './models/WorkspaceMember.js';

const app = createApp();
let mongo: MongoMemoryServer;

type Session = ReturnType<typeof request.agent>;

const register = async (agent: Session, name: string, email: string) => {
  const response = await agent.post('/api/auth/register').send({ name, email, password: 'password123' });
  expect(response.status).toBe(201);
  return response;
};

const createWorkspace = async (agent: Session, name: string) => {
  const response = await agent.post('/api/workspaces').send({ name });
  expect(response.status).toBe(201);
  return response.body.workspace.id as string;
};

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
}, 180000);

beforeEach(async () => {
  await Promise.all([AuthSessionModel.deleteMany({}), UserModel.deleteMany({}), WorkspaceModel.deleteMany({}), WorkspaceMemberModel.deleteMany({})]);
});

afterAll(async () => {
  await mongoose.disconnect();
  if (mongo) await mongo.stop();
});

describe('identity and workspace authorization', () => {
  it('registers, hashes the password, and returns the current user from a cookie session', async () => {
    const agent = request.agent(app);
    await register(agent, 'Ada Lovelace', 'ada@example.com');
    await createWorkspace(agent, 'Ada workspace');
    const user = await UserModel.findOne({ email: 'ada@example.com' }).select('+passwordHash');
    expect(user?.passwordHash).not.toBe('password123');
    expect(await bcrypt.compare('password123', user!.passwordHash)).toBe(true);
    const currentUser = await agent.get('/api/auth/me');
    expect(currentUser.status).toBe(200);
    expect(currentUser.body.user.email).toBe('ada@example.com');
  });

  it('rejects invalid credentials and duplicate email registration', async () => {
    const agent = request.agent(app);
    await register(agent, 'Ada Lovelace', 'ada@example.com');
    const duplicate = await request(app).post('/api/auth/register').send({ name: 'Other', email: 'ADA@example.com', password: 'password123' });
    expect(duplicate.status).toBe(409);
    const invalidLogin = await request(app).post('/api/auth/login').send({ email: 'ada@example.com', password: 'wrong-password' });
    expect(invalidLogin.status).toBe(401);
  });

  it('rotates refresh tokens and rejects the previously used refresh token', async () => {
    const agent = request.agent(app);
    await register(agent, 'Ada Lovelace', 'ada@example.com');
    const refreshCookie = agent.jar.getCookie('refreshToken', { domain: '127.0.0.1', path: '/api/auth', secure: false, script: false })?.value;
    expect(refreshCookie).toBeDefined();
    const rotated = await agent.post('/api/auth/refresh');
    expect(rotated.status).toBe(200);
    const replay = await request(app).post('/api/auth/refresh').set('Cookie', [`refreshToken=${refreshCookie}`]);
    expect(replay.status).toBe(401);
  });

  it('denies a member role from administering a workspace', async () => {
    const owner = request.agent(app);
    await register(owner, 'Owner User', 'owner@example.com');
    await register(request.agent(app), 'Member User', 'member@example.com');
    const workspaceId = await createWorkspace(owner, 'Owner workspace');
    const addMember = await owner.post(`/api/workspaces/${workspaceId}/members`).send({ email: 'member@example.com', role: 'member' });
    expect(addMember.status).toBe(201);
    const member = request.agent(app);
    await member.post('/api/auth/login').send({ email: 'member@example.com', password: 'password123' });
    const restricted = await member.post(`/api/workspaces/${workspaceId}/members`).send({ email: 'owner@example.com', role: 'admin' });
    expect(restricted.status).toBe(403);
  });

  it('denies access to a workspace when the user has no membership', async () => {
    const owner = request.agent(app);
    await register(owner, 'Owner User', 'owner@example.com');
    const outsider = request.agent(app);
    await register(outsider, 'Outsider User', 'outsider@example.com');
    const workspaceId = await createWorkspace(owner, 'Owner workspace');
    const denied = await outsider.get(`/api/workspaces/${workspaceId}`);
    expect(denied.status).toBe(403);
  });
});

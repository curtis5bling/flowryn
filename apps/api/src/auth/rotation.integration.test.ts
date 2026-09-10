import { randomUUID } from 'node:crypto';

import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';

import { createApp } from '../app.js';
import { AuthSessionModel } from '../models/AuthSession.js';
import { UserModel } from '../models/User.js';
import { RevocationIncomplete } from '../realtime/coordination.js';

import { onAuthorizationChange } from './revocation.js';
import { authenticateAccessToken, issueTokens, rotateRefreshToken, RotationUnavailable, verifyAccessToken } from './tokens.js';

let mongo: MongoMemoryServer;
const cleanup: Array<() => void> = [];
beforeAll(async () => { mongo = await MongoMemoryServer.create(); await mongoose.connect(mongo.getUri()); }, 180000);
beforeEach(async () => { await mongoose.connection.dropDatabase(); });
afterEach(() => { cleanup.splice(0).forEach((dispose) => dispose()); vi.restoreAllMocks(); });
afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
const fixture = async () => {
  const user = await UserModel.create({ name: 'Rotation', email: 'rotation@test.dev', passwordHash: 'unused' });
  return { user, tokens: await issueTokens(user.id) };
};

it('preserves the refresh hash on coordination timeout and rejects replay only after successful retry', async () => {
  const { user, tokens } = await fixture();
  const before = await AuthSessionModel.findOne({ userId: user.id }).lean();
  const coordinate = vi.fn().mockRejectedValueOnce(new RevocationIncomplete()).mockResolvedValue(undefined);
  cleanup.push(onAuthorizationChange(coordinate));
  const response = await request(createApp()).post('/api/auth/refresh').set('Cookie', `refreshToken=${tokens.refreshToken}`);
  expect(response.status).toBe(503); expect(response.headers['set-cookie']).toBeUndefined();
  const pending = await AuthSessionModel.findById(before!._id).lean();
  expect(pending?.refreshTokenHash).toBe(before?.refreshTokenHash);
  expect(pending?.revokedAt).toBeUndefined(); expect(pending?.rotationOperationId).toBeUndefined();
  await expect(authenticateAccessToken(tokens.accessToken)).rejects.toThrow();
  const replacement = await rotateRefreshToken(tokens.refreshToken);
  expect(verifyAccessToken(replacement.accessToken).jti).not.toBe(verifyAccessToken(tokens.accessToken).jti);
  await expect(authenticateAccessToken(replacement.accessToken)).resolves.toBeDefined();
  await expect(rotateRefreshToken(tokens.refreshToken)).rejects.toThrow('Invalid refresh token');
  expect(await AuthSessionModel.countDocuments()).toBe(1);
  expect((await AuthSessionModel.findById(before!._id))?.version).toBe(1);
});

it('allows only one concurrent rotation and treats an active claim as retryable', async () => {
  const { tokens } = await fixture();
  let release!: () => void;
  const coordinate = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
  cleanup.push(onAuthorizationChange(coordinate));
  const first = rotateRefreshToken(tokens.refreshToken);
  await vi.waitFor(() => expect(coordinate).toHaveBeenCalledTimes(1));
  await expect(rotateRefreshToken(tokens.refreshToken)).rejects.toBeInstanceOf(RotationUnavailable);
  expect(coordinate).toHaveBeenCalledTimes(1);
  release(); await first;
  await expect(rotateRefreshToken(tokens.refreshToken)).rejects.toThrow('Invalid refresh token');
  expect((await AuthSessionModel.findOne())?.version).toBe(1);
});

it('recovers an abandoned claim after its lease expires without consuming the refresh hash', async () => {
  const { tokens } = await fixture();
  await AuthSessionModel.updateOne({}, { rotationOperationId: randomUUID(), rotationExpiresAt: new Date(Date.now() + 30000), accessDisabled: true });
  await expect(rotateRefreshToken(tokens.refreshToken)).rejects.toBeInstanceOf(RotationUnavailable);
  await AuthSessionModel.updateOne({}, { rotationExpiresAt: new Date(0) });
  const replacement = await rotateRefreshToken(tokens.refreshToken);
  await expect(authenticateAccessToken(replacement.accessToken)).resolves.toBeDefined();
});

it('fences an expired lease owner after a later attempt has committed', async () => {
  const { tokens } = await fixture();
  let release!: () => void;
  const coordinate = vi.fn().mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; })).mockResolvedValue(undefined);
  cleanup.push(onAuthorizationChange(coordinate));
  const old = rotateRefreshToken(tokens.refreshToken);
  await vi.waitFor(() => expect(coordinate).toHaveBeenCalledTimes(1));
  await AuthSessionModel.updateOne({}, { rotationExpiresAt: new Date(0) });
  const winner = await rotateRefreshToken(tokens.refreshToken);
  const rejected = expect(old).rejects.toBeInstanceOf(RotationUnavailable);
  release(); await rejected;
  await expect(authenticateAccessToken(winner.accessToken)).resolves.toBeDefined();
  expect((await AuthSessionModel.findOne())?.version).toBe(1);
});

it('returns no credentials after a database commit failure and permits the same token to retry', async () => {
  const { tokens } = await fixture();
  const coordinate = vi.fn(async () => {}); cleanup.push(onAuthorizationChange(coordinate));
  const original = AuthSessionModel.findOneAndUpdate.bind(AuthSessionModel);
  vi.spyOn(AuthSessionModel, 'findOneAndUpdate').mockImplementationOnce(original).mockImplementationOnce(() => { throw new Error('database write failed'); });
  await expect(rotateRefreshToken(tokens.refreshToken)).rejects.toBeInstanceOf(RotationUnavailable);
  expect(coordinate).toHaveBeenCalledTimes(1);
  expect((await AuthSessionModel.findOne())?.version).toBe(0);
  const replacement = await rotateRefreshToken(tokens.refreshToken);
  await expect(authenticateAccessToken(replacement.accessToken)).resolves.toBeDefined();
});

it('confirms an ambiguous commit before returning its single replacement generation', async () => {
  const { tokens } = await fixture();
  const original = AuthSessionModel.findOneAndUpdate.bind(AuthSessionModel);
  vi.spyOn(AuthSessionModel, 'findOneAndUpdate').mockImplementationOnce(original).mockImplementationOnce((filter, update, options) => {
    const query = original(filter, update, options);
    const execute = query.exec.bind(query);
    query.exec = async () => { await execute(); throw new Error('write response lost'); };
    return query;
  });
  const replacement = await rotateRefreshToken(tokens.refreshToken);
  await expect(authenticateAccessToken(replacement.accessToken)).resolves.toBeDefined();
  await expect(rotateRefreshToken(tokens.refreshToken)).rejects.toThrow('Invalid refresh token');
  expect((await AuthSessionModel.findOne())?.version).toBe(1);
});

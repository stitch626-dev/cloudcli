import assert from 'node:assert/strict';
import test from 'node:test';

import { AppError } from '@/shared/utils.js';

import { createAuthService } from '../auth.service.js';

type AuthDependencies = Parameters<typeof createAuthService>[0];

function createDependencies(overrides: Partial<AuthDependencies> = {}): AuthDependencies {
  return {
    users: {
      hasUsers: () => false,
      createUser: (username, passwordHash) => ({ id: 1, username, password_hash: passwordHash }),
      getUserByUsername: () => undefined,
      updateLastLogin: () => undefined,
      hasCompletedOnboarding: () => true,
    },
    transaction: {
      begin: () => undefined,
      commit: () => undefined,
      rollback: () => undefined,
    },
    hashPassword: async () => 'hashed-password',
    comparePassword: async () => false,
    generateToken: () => 'signed-token',
    ...overrides,
  };
}

test('register hashes credentials and commits through injected dependencies', async () => {
  const operations: string[] = [];
  const service = createAuthService(createDependencies({
    transaction: {
      begin: () => operations.push('begin'),
      commit: () => operations.push('commit'),
      rollback: () => operations.push('rollback'),
    },
    hashPassword: async (password) => {
      operations.push(`hash:${password}`);
      return 'hash';
    },
    users: {
      hasUsers: () => false,
      createUser: (username, passwordHash) => {
        operations.push(`create:${username}:${passwordHash}`);
        return { id: 1, username, password_hash: passwordHash };
      },
      getUserByUsername: () => undefined,
      updateLastLogin: (userId) => operations.push(`login:${userId}`),
      hasCompletedOnboarding: () => false,
    },
  }));

  const result = await service.register('alice', 'secret12');

  assert.equal(result.token, 'signed-token');
  assert.deepEqual(operations, ['begin', 'hash:secret12', 'create:alice:hash', 'commit', 'login:1']);
});

test('login rejects an invalid password without issuing a token', async () => {
  let tokenIssued = false;
  const service = createAuthService(createDependencies({
    users: {
      hasUsers: () => true,
      createUser: () => { throw new Error('unused'); },
      getUserByUsername: () => ({ id: 1, username: 'alice', password_hash: 'hash' }),
      updateLastLogin: () => undefined,
      hasCompletedOnboarding: () => true,
    },
    comparePassword: async () => false,
    generateToken: () => {
      tokenIssued = true;
      return 'token';
    },
  }));

  await assert.rejects(
    service.login('alice', 'wrong-password'),
    (error: unknown) => error instanceof AppError && error.code === 'AUTH_INVALID_CREDENTIALS',
  );
  assert.equal(tokenIssued, false);
});

test('refreshSession issues a replacement token for the authenticated user', () => {
  let tokenUser: { id: number | bigint; username: string } | undefined;
  const service = createAuthService(createDependencies({
    generateToken: (user) => {
      tokenUser = user;
      return 'replacement-token';
    },
  }));

  const result = service.refreshSession({ id: 7, username: 'alice' });

  assert.deepEqual(result, { token: 'replacement-token' });
  assert.deepEqual(tokenUser, { id: 7, username: 'alice' });
});

test('authenticated bootstrap reports onboarding for the verified user only', () => {
  const dependencies = createDependencies();
  const ids: number[] = [];
  dependencies.users.hasCompletedOnboarding = (id) => { ids.push(id); return id === 7; };
  const service = createAuthService(dependencies);
  assert.deepEqual(service.getCurrentUser({ id: 7, username: 'alice' }), {
    user: { id: 7, username: 'alice' }, hasCompletedOnboarding: true,
  });
  assert.equal(service.getCurrentUser({ id: 8, username: 'bob' }).hasCompletedOnboarding, false);
  assert.deepEqual(ids, [7, 8]);
  assert.throws(() => service.getCurrentUser(undefined), /Authenticated user/);
});

test('login includes onboarding state without exposing password hashes', async () => {
  const dependencies = createDependencies();
  dependencies.users.getUserByUsername = () => ({ id: 1, username: 'alice', password_hash: 'private' });
  dependencies.users.hasCompletedOnboarding = () => false;
  dependencies.comparePassword = async () => true;
  const result = await createAuthService(dependencies).login('alice', 'password');
  assert.equal(result.hasCompletedOnboarding, false);
  assert.deepEqual(result.user, { id: 1, username: 'alice' });
});

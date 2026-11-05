/**
 * Express 4 only forwards *synchronous* throws to the error middleware, so an
 * async handler whose awaited call rejects produces an unhandledRejection —
 * which Node treats as fatal. This suite is the regression test for exactly
 * that: it was found by calling the admin endpoint while the Supabase host was
 * unreachable, and the dev server exited instead of answering 500.
 *
 * Every case answers 500, keeps the process alive, and reports no
 * unhandledRejection.
 */
import { afterEach, describe, expect, it } from 'vitest';

import type { AppDeps } from '../src/deps.js';

import { CLIENT_A, DOCUMENT, makeWorld, withServer } from './fakes/world.js';

function rejecting(message: string) {
  return async (): Promise<never> => {
    throw new Error(message);
  };
}

const rejections: unknown[] = [];
function onRejection(reason: unknown) {
  rejections.push(reason);
}

function watchRejections() {
  rejections.length = 0;
  process.on('unhandledRejection', onRejection);
}

afterEach(() => {
  process.off('unhandledRejection', onRejection);
});

/** The route answers 500, and /api/health proves the process survived it. */
async function expectRejectionServed(baseUrl: string, request: () => Promise<Response>) {
  const response = await request();
  expect(response.status).toBe(500);
  await expect(response.json()).resolves.toMatchObject({ error: 'internal_error' });
  expect((await fetch(`${baseUrl}/api/health`)).status).toBe(200);
}

describe('a rejected dependency is an HTTP answer, not a dead process', () => {
  it('admin list answers 500 when the database call rejects', async () => {
    watchRejections();
    const world = makeWorld();
    const deps: AppDeps = { ...world.deps, repo: { ...world.deps.repo, listCrmSyncDue: rejecting('supabase unreachable') } };

    await withServer(deps, (baseUrl) =>
      expectRejectionServed(baseUrl, () =>
        fetch(`${baseUrl}/api/admin/crm-sync`, { headers: { 'x-admin-key': world.env.adminApiKey } })
      )
    );

    expect(rejections).toEqual([]);
  });

  it('checkout answers 500 when the client lookup rejects', async () => {
    watchRejections();
    const world = makeWorld();
    const deps: AppDeps = {
      ...world.deps,
      repo: { ...world.deps.repo, findClientByAuthUserId: rejecting('supabase unreachable') },
    };

    await withServer(deps, (baseUrl) =>
      expectRejectionServed(baseUrl, () =>
        fetch(`${baseUrl}/api/checkout`, {
          method: 'POST',
          headers: { authorization: 'Bearer token-a', 'content-type': 'application/json' },
          body: JSON.stringify({ documentId: DOCUMENT.id }),
        })
      )
    );

    expect(rejections).toEqual([]);
  });

  it('the bearer-token middleware answers 500 when Supabase auth rejects', async () => {
    watchRejections();
    const world = makeWorld();
    const deps: AppDeps = { ...world.deps, auth: { verifyAccessToken: rejecting('auth host down') } };

    await withServer(deps, (baseUrl) =>
      expectRejectionServed(baseUrl, () =>
        fetch(`${baseUrl}/api/documents/${DOCUMENT.id}/download`, { headers: { authorization: 'Bearer token-a' } })
      )
    );

    expect(rejections).toEqual([]);
  });

  it('download answers 500 when signed-url creation rejects', async () => {
    watchRejections();
    const world = makeWorld({
      entitlements: [{ clientId: CLIENT_A.id, documentId: DOCUMENT.id, purchaseId: 'purchase-1', revokedAt: null }],
    });
    const deps: AppDeps = { ...world.deps, storage: { createDownloadUrl: rejecting('storage unreachable') } };

    await withServer(deps, (baseUrl) =>
      expectRejectionServed(baseUrl, () =>
        fetch(`${baseUrl}/api/documents/${DOCUMENT.id}/download`, { headers: { authorization: 'Bearer token-a' } })
      )
    );

    expect(rejections).toEqual([]);
  });
});

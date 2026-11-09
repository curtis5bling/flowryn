import { expect, test, type Page } from '@playwright/test';

type Role = 'owner' | 'admin' | 'member' | 'suspended' | 'removed';

const release = {
  _id: 'r1', title: 'Checkout release with a deliberately long wrapping title', version: '2026.10.16', state: 'ready',
  environmentId: 'e1', revision: 2, sequence: 1, createdAt: '2026-10-16T08:00:00.000Z',
};

async function fixture(page: Page, role: Role) {
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    let body: unknown = {};
    if (path === '/api/auth/me') body = { user: { id: 'u1', name: 'Operator', email: 'operator@example.test', status: 'active' } };
    else if (path === '/api/workspaces') body = { workspaces: [{ id: 'w1', name: 'Operations', role }] };
    else if (path.endsWith('/changes/environments')) body = { environments: [{ _id: 'e1', name: 'Production', slug: 'production', tier: 'production', active: true }] };
    else if (path.endsWith('/changes/releases/r1')) body = { release, history: [], risks: [{ score: 81, band: 'critical', factors: [{ key: 'evidence', unknown: true, explanation: 'Evidence unavailable', contribution: 10 }] }], health: [{ _id: 'h1', phase: 'pre', classification: 'unknown' }], approvals: [{ _id: 'a1', state: 'pending', decisions: [], requiredCount: 1 }], correlations: [{ _id: 'c1', sourceType: 'incident', confidence: 'medium', state: 'candidate' }] };
    else if (path.endsWith('/changes/releases')) {
      const filtered = url.searchParams.get('state');
      const cursor = url.searchParams.get('cursor');
      body = { releases: cursor ? [] : filtered && filtered !== 'ready' ? [] : [release], nextCursor: cursor ? null : 'next-page' };
    }
    else if (path.endsWith('/changes/policies')) body = { policies: [{ _id: 'p3', version: 3, name: 'Candidate policy', active: false }, { _id: 'p2', version: 2, name: 'Current policy', active: true }, { _id: 'p1', version: 1, name: 'Previous policy', active: false }] };
    else if (path.endsWith('/changes/metrics')) body = { insufficientData: false, deployments: { total: 12, changeFailureRate: 0.25 } };
    else if (path.includes('/changes/')) body = { accepted: true };
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.goto('/changes');
  await expect(page.getByRole('heading', { name: 'Releases and deployment governance' })).toBeVisible();
}

const viewports = [
  { name: 'narrow mobile', width: 375, height: 812 },
  { name: 'desktop', width: 1440, height: 1000 },
] as const;

for (const viewport of viewports) {
  test(`${viewport.name}: rendered workflows remain reachable without overflow`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await fixture(page, 'owner');
    await expect(page.getByText('1 releases on this page.')).toBeVisible();
    await page.getByLabel('Filter deployment state').selectOption('ready');
    await expect(page.getByText(release.title)).toBeVisible();
    await page.getByRole('button', { name: `Open release ${release.title}` }).click();
    await expect(page.getByText('Score 81/100 (critical)')).toBeVisible();
    await expect(page.getByText('pre: unknown')).toBeVisible();
    await expect(page.getByText(/Temporal proximity does not prove causation/)).toBeVisible();
    await expect(page.getByText(/12 deployments; change failure rate 25.0%/)).toBeVisible();
    await expect(page.getByText(/Version 2: Current policy/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Activate version 3' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Rollback version 1' })).toBeVisible();
    await page.getByRole('button', { name: 'Next page' }).click();
    await expect(page.getByText('No releases have been recorded.')).toBeVisible();

    const geometry = await page.evaluate(() => ({
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: document.documentElement.clientWidth,
      clipped: [...document.querySelectorAll('main button, main input, main select')].filter((element) => {
        const box = element.getBoundingClientRect();
        return box.left < 0 || box.right > document.documentElement.clientWidth || box.width === 0 || box.height === 0;
      }).length,
    }));
    expect(geometry.documentWidth).toBeLessThanOrEqual(geometry.viewportWidth);
    expect(geometry.clipped).toBe(0);
    const targets = await page.locator('main button, main input, main select').evaluateAll((elements) => elements.map((element) => {
      const box = element.getBoundingClientRect();
      return { name: element.getAttribute('aria-label') ?? element.textContent?.trim(), width: box.width, height: box.height };
    }));
    for (const target of targets) {
      expect(target.width, `${target.name} width`).toBeGreaterThanOrEqual(44);
      expect(target.height, `${target.name} height`).toBeGreaterThanOrEqual(44);
    }
  });
}

test('dialogs, keyboard actions, offline and reconnect states preserve focus and safety', async ({ page, context }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await fixture(page, 'owner');
  const rollback = page.getByRole('button', { name: 'Rollback version 1' });
  await rollback.focus();
  page.once('dialog', (dialog) => dialog.dismiss());
  await rollback.press('Enter');
  await expect(rollback).toBeFocused();
  page.once('dialog', (dialog) => dialog.accept());
  await rollback.press('Space');
  await expect(rollback).toBeFocused();

  await context.setOffline(true);
  await page.evaluate(() => window.dispatchEvent(new Event('offline')));
  await expect(page.getByText(/Offline. Showing cached/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create immutable policy version' })).toBeDisabled();
  await context.setOffline(false);
  await page.evaluate(() => {
    window.dispatchEvent(new Event('online'));
    (globalThis as typeof globalThis & { __m11Socket: { testDisconnect(): void } }).__m11Socket.testDisconnect();
  });
  await expect(page.getByText(/Reconnecting; REST will refresh/)).toBeVisible();
  await page.evaluate(() => (globalThis as typeof globalThis & { __m11Socket: { testReconnect(): void } }).__m11Socket.testReconnect());
  await expect(page.getByText(/Reconnecting; REST will refresh/)).toBeHidden();
});

for (const role of ['owner', 'admin', 'member', 'suspended', 'removed'] as const) {
  test(`${role} rendered role layout`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await fixture(page, role);
    const managesPolicies = role === 'owner' || role === 'admin';
    await expect(page.getByRole('heading', { name: 'Governance policy versions' })).toHaveCount(managesPolicies ? 1 : 0);
    await page.getByRole('button', { name: `Open release ${release.title}` }).click();
    const actionable = role === 'owner' || role === 'admin' || role === 'member';
    await expect(page.getByRole('button', { name: 'Approve' })).toHaveCount(actionable ? 1 : 0);
    await expect(page.getByRole('button', { name: 'Confirm' })).toHaveCount(role === 'owner' || role === 'admin' ? 1 : 0);
    await expect(page.getByText('pre: unknown')).toBeVisible();
  });
}

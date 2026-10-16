import { createHash, randomBytes } from 'node:crypto';
import { test, expect, type Request, type Response } from '@playwright/test';

test('native OAuth form preserves its Origin and returns a PKCE code without leaking Referer', async ({ page, request, baseURL }) => {
  // Never target the user's production service or read production credentials.
  expect(baseURL).toBe('http://127.0.0.1:3100');
  const origin = baseURL!;
  const redirectUri = 'https://client.example/callback';
  const scope = 'projects:read projects:write';
  const verifier = randomBytes(48).toString('base64url');
  const state = randomBytes(24).toString('base64url');
  const registered = await request.post('/register', { data: {
    client_name: 'Native form regression test', redirect_uris: [redirectUri], token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
  } });
  expect(registered.status()).toBe(201);
  const registration = await registered.json();
  const query = new URLSearchParams({ client_id: registration.client_id, redirect_uri: redirectUri, response_type: 'code',
    code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    resource: `${origin}/mcp`, scope, state });

  const cspViolations: string[] = [];
  let finish: (outcome: string) => void = () => {};
  let approval: Response | undefined;
  let callbackRequest: Request | undefined;
  let formRequestFailed = false;
  const maybeComplete = () => { if (approval?.status() === 303 && callbackRequest) finish('callback-received'); };
  await page.exposeFunction('reportOAuthCsp', (directive: string) => {
    // blockedURI may include OAuth codes. Keep only the directive name in diagnostics.
    cspViolations.push(directive);
    if (directive === 'form-action') finish('form-action-blocked-by-csp');
  });
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', event => {
      const receiver = window as unknown as { reportOAuthCsp: (directive: string) => Promise<void> };
      void receiver.reportOAuthCsp(event.effectiveDirective);
    });
  });
  page.on('response', response => {
    if (response.url() !== `${origin}/authorize` || response.request().method() !== 'POST') return;
    approval = response;
    if (response.status() !== 303) finish(`form-post-http-${response.status()}`);
    else maybeComplete();
  });
  page.on('request', req => {
    const url = new URL(req.url());
    if (url.origin !== 'https://client.example' || url.pathname !== '/callback') return;
    callbackRequest = req;
    maybeComplete();
  });
  page.on('requestfailed', req => {
    if (req.url() === `${origin}/authorize` && req.method() === 'POST') formRequestFailed = true;
  });

  // The fake client endpoint must never receive a real network request.
  await page.route(url => url.origin === 'https://client.example' && url.pathname === '/callback', route => route.fulfill({
    status: 200, contentType: 'text/html', body: '<!doctype html><title>OAuth test callback</title><p>Callback intercepted locally.</p>',
  }));
  const consent = await page.goto(`/authorize?${query}`);
  expect(consent?.status()).toBe(200);
  expect(consent?.headers()['referrer-policy']).toBe('same-origin');
  await page.getByLabel('部署者访问密钥').fill('e2e-only-owner-secret-never-use-in-production');

  let timer: ReturnType<typeof setTimeout>;
  const submitted = new Promise<string>(resolve => {
    finish = resolve;
    timer = setTimeout(() => resolve(formRequestFailed ? 'form-request-failed-before-callback' : 'native-form-did-not-complete'), 7500);
  });
  try {
    await page.getByRole('button', { name: '授权连接' }).click({ noWaitAfter: true });
    expect(await submitted, `Native OAuth form must complete; CSP directives: ${cspViolations.join(', ') || 'none'}`).toBe('callback-received');
  } finally { clearTimeout(timer!); }
  expect(await approval!.request().headerValue('origin')).toBe(origin);
  expect(approval!.request().postData()).toContain('ownerSecret=e2e-only-owner-secret-never-use-in-production');
  expect(approval!.status()).toBe(303);
  expect(approval!.headers()['referrer-policy']).toBe('no-referrer');
  expect(await callbackRequest!.headerValue('referer')).toBeNull();
  expect(callbackRequest!.method()).toBe('GET');
  expect(callbackRequest!.postData()).toBeNull();

  const callback = new URL(callbackRequest!.url());
  expect(callback.origin + callback.pathname).toBe(redirectUri);
  expect(callback.searchParams.getAll('state')).toEqual([state]);
  expect(callback.searchParams.getAll('iss')).toEqual([origin]);
  const code = callback.searchParams.get('code');
  expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(callbackRequest!.url()).not.toContain('ownerSecret');
  expect(callbackRequest!.url()).not.toContain('e2e-only-owner-secret');
  await expect(page).toHaveTitle('OAuth test callback');

  const exchanged = await request.post('/token', { form: { grant_type: 'authorization_code', code: code!, client_id: registration.client_id,
    redirect_uri: redirectUri, resource: `${origin}/mcp`, code_verifier: verifier } });
  expect(exchanged.status()).toBe(200);
  expect(exchanged.headers()['referrer-policy']).toBe('no-referrer');
  const initial = await exchanged.json();
  expect(initial.scope).toBe(scope);
  expect(initial.access_token).toEqual(expect.any(String));
  expect(initial.refresh_token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  const refreshed = await request.post('/token', { form: { grant_type: 'refresh_token', refresh_token: initial.refresh_token,
    client_id: registration.client_id, resource: `${origin}/mcp` } });
  expect(refreshed.status()).toBe(200);
  const next = await refreshed.json();
  expect(next.scope).toBe(scope);
  expect(next.access_token).toEqual(expect.any(String));
  expect(next.refresh_token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(next.refresh_token).not.toBe(initial.refresh_token);
});

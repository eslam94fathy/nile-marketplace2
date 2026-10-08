'use strict';
// Usage: npm run postman:generate [-- <output path>]
// Writes the Postman collection of every API endpoint (default docs/postman/nile-marketplace.postman_collection.json).
// Add new endpoints here when they land; keep descriptions in step with the module specs.
const fs = require('node:fs');
const path = require('node:path');

const out =
  process.argv[2] ??
  path.join(__dirname, '..', 'docs', 'postman', 'nile-marketplace.postman_collection.json');

const json = (obj) => JSON.stringify(obj, null, 2);
const lines = (s) => s.trim().split('\n');
const test = (code) => ({ listen: 'test', script: { type: 'text/javascript', exec: lines(code) } });
const url = (path, query = []) => {
  const enabled = query.filter((q) => !q.disabled);
  return {
    raw: `{{baseUrl}}${path}${enabled.length ? '?' + enabled.map((q) => `${q.key}=${q.value}`).join('&') : ''}`,
    host: ['{{baseUrl}}'],
    path: path.replace(/^\//, '').split('/'),
    ...(query.length ? { query } : {}),
  };
};
const bearer = { type: 'bearer', bearer: [{ key: 'token', value: '{{accessToken}}', type: 'string' }] };
const noauth = { type: 'noauth' };
const req = ({ name, method, path, body, auth = false, query, description, tests }) => ({
  name,
  ...(tests ? { event: [test(tests)] } : {}),
  request: {
    method,
    auth: auth ? bearer : noauth,
    header: body ? [{ key: 'Content-Type', value: 'application/json' }] : [],
    ...(body ? { body: { mode: 'raw', raw: json(body), options: { raw: { language: 'json' } } } } : {}),
    url: url(path, query),
    description,
  },
});

const expect = (status) => `pm.test('status ${status}', () => pm.response.to.have.status(${status}));`;
const saveSession = `
${expect(200)}
if (pm.response.code === 200) {
  const { data } = pm.response.json();
  pm.collectionVariables.set('accessToken', data.accessToken);
  pm.collectionVariables.set('refreshToken', data.refreshToken);
  pm.collectionVariables.set('userId', data.user.id);
}`;

const API = '/api/v1';
const collection = {
  info: {
    name: 'Nile Marketplace API (Phase 1)',
    _postman_id: 'c3a1d0e2-4f6b-4c1e-9a7d-6b2f0e8d1a01',
    description: [
      'Every endpoint built so far: health, API docs, identity auth (spec 03 §4.2–§4.9b) and identity admin (§4.10–§4.13).',
      '',
      'Variables: set `baseUrl` (default http://localhost:3000) and `mailpitUrl` (local only). Login, verify, accept-invite and refresh store `accessToken`, `refreshToken` and `userId` automatically; admin routes use the stored `accessToken`.',
      '',
      'Local first run (docker compose):',
      '1. `docker compose run --rm api node dist/seed-admin.js --email you@example.com`, then set the `email` variable to that address.',
      '2. Local helpers (Mailpit) → "Latest email" → "Extract OTP / invite token".',
      '3. Auth → "Accept invite" (sets your password and logs you in).',
      '4. Admin requests now work with the stored access token.',
      '',
      'Self-registration (customers, sellers) arrives in Phase 2, so "Verify email" and "Resend OTP" only apply to accounts created through identity\'s public API until then.',
      '',
      'Errors use the envelope { success: false, error: { code, message, details? }, correlationId }. Every request sends a fresh X-Correlation-Id (collection pre-request script); search the api/worker logs for it.',
    ].join('\n'),
    schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
  },
  auth: noauth,
  event: [
    {
      listen: 'prerequest',
      script: {
        type: 'text/javascript',
        exec: [
          '// One correlation id per request, echoed by the API and present in every log line (G26).',
          "pm.request.headers.upsert({ key: 'X-Correlation-Id', value: pm.variables.replaceIn('{{$guid}}') });",
        ],
      },
    },
  ],
  variable: [
    { key: 'baseUrl', value: 'http://localhost:3000' },
    { key: 'mailpitUrl', value: 'http://localhost:8025' },
    { key: 'email', value: 'admin@example.com' },
    { key: 'password', value: 'correct horse battery' },
    { key: 'newPassword', value: 'another long passphrase' },
    { key: 'deviceName', value: 'Postman' },
    { key: 'otp', value: '' },
    { key: 'inviteToken', value: '' },
    { key: 'accessToken', value: '' },
    { key: 'refreshToken', value: '' },
    { key: 'userId', value: '' },
    { key: 'newAdminEmail', value: 'second-admin@example.com' },
    { key: 'targetUserId', value: '' },
    { key: 'cursor', value: '' },
    { key: 'mailpitMessageId', value: '' },
  ],
  item: [
    {
      name: 'Health',
      item: [
        req({
          name: 'Liveness',
          method: 'GET',
          path: '/health/live',
          description: 'Process is up. No dependency checks, no auth, not rate limited.',
          tests: expect(200),
        }),
        req({
          name: 'Readiness',
          method: 'GET',
          path: '/health/ready',
          description:
            'Postgres, Redis and RabbitMQ, each with a timeout. 503 SERVICE_UNAVAILABLE with one detail per dependency that is down.',
        }),
      ],
    },
    {
      name: 'API docs',
      item: [
        req({
          name: 'OpenAPI document',
          method: 'GET',
          path: `${API}/docs/openapi.json`,
          description:
            'OpenAPI 3.1, generated from the DTOs. Only when API_DOCS_ENABLED=true (off in production). Swagger UI: {{baseUrl}}/api/v1/docs/',
          tests: expect(200),
        }),
      ],
    },
    {
      name: 'Auth',
      description:
        'spec 03 §4.2–§4.9b. Public routes are rate limited per IP and per email (strict-auth); refresh and logout per IP.',
      item: [
        req({
          name: 'Login',
          method: 'POST',
          path: `${API}/auth/login`,
          body: { email: '{{email}}', password: '{{password}}', deviceName: '{{deviceName}}' },
          description:
            '200 token pair. Errors: INVALID_CREDENTIALS 401 (unknown email, wrong password and invited account all get the same answer), EMAIL_NOT_VERIFIED 403, ACCOUNT_SUSPENDED 403 (only after a correct password). `deviceName` is optional (1..100); `null` is rejected.',
          tests: saveSession,
        }),
        req({
          name: 'Refresh',
          method: 'POST',
          path: `${API}/auth/refresh`,
          body: { refreshToken: '{{refreshToken}}' },
          description:
            'Rotates the refresh token (43 chars). Reusing an old token revokes the whole session family: INVALID_REFRESH_TOKEN 401. The app must not refresh concurrently.',
          tests: saveSession,
        }),
        req({
          name: 'Logout',
          method: 'POST',
          path: `${API}/auth/logout`,
          body: { refreshToken: '{{refreshToken}}' },
          description: "Ends this device's session. Always 204, even for an unknown token.",
          tests: `${expect(204)}\npm.collectionVariables.set('accessToken', '');\npm.collectionVariables.set('refreshToken', '');`,
        }),
        req({
          name: 'Accept invite',
          method: 'POST',
          path: `${API}/auth/invite/accept`,
          body: { token: '{{inviteToken}}', password: '{{password}}' },
          description:
            'Sets the password of an invited admin or delivery agent, activates the account and logs in. The token comes from the invite link (?token=…; see Local helpers). Single use. Errors: INVALID_INVITE_TOKEN 400. Password: 8+ characters, max 72 UTF-8 bytes, never trimmed.',
          tests: saveSession,
        }),
        req({
          name: 'Verify email',
          method: 'POST',
          path: `${API}/auth/email/verify`,
          body: { email: '{{email}}', otp: '{{otp}}' },
          description:
            'Activates a pending account with the 6-digit OTP and logs in. Errors: INVALID_OTP 400 (one generic code). Each wrong code counts; after OTP_MAX_ATTEMPTS even the right code fails.',
          tests: saveSession,
        }),
        req({
          name: 'Resend verification OTP',
          method: 'POST',
          path: `${API}/auth/email/resend-otp`,
          body: { email: '{{email}}' },
          description:
            'Always 200 with the same message. A new code is sent only to a pending account outside the cooldown (OTP_RESEND_COOLDOWN_SECONDS); it invalidates the previous code.',
          tests: expect(200),
        }),
        req({
          name: 'Forgot password',
          method: 'POST',
          path: `${API}/auth/password/forgot`,
          body: { email: '{{email}}' },
          description:
            'Always 200 with the same message. Sends a password-reset OTP to an active account (cooldown applies).',
          tests: expect(200),
        }),
        req({
          name: 'Reset password',
          method: 'POST',
          path: `${API}/auth/password/reset`,
          body: { email: '{{email}}', otp: '{{otp}}', newPassword: '{{newPassword}}' },
          description:
            'Sets a new password with the reset OTP and revokes every session. 204; then log in again. Errors: INVALID_OTP 400.',
          tests: expect(204),
        }),
        req({
          name: 'Change password',
          method: 'POST',
          path: `${API}/auth/password/change`,
          auth: true,
          body: {
            currentPassword: '{{password}}',
            newPassword: '{{newPassword}}',
            refreshToken: '{{refreshToken}}',
          },
          description:
            'Any logged-in role. Keeps the session of `refreshToken` and revokes all others. 204. Errors, in this order: INVALID_CURRENT_PASSWORD 400, PASSWORD_UNCHANGED 422, INVALID_REFRESH_TOKEN 401. Rate limit: IP + the account email (shared with login).',
          tests: expect(204),
        }),
      ],
    },
    {
      name: 'Admin: users',
      description: 'spec 03 §4.10–§4.13. Admin role only: 401 without a token, 403 for other roles.',
      item: [
        req({
          name: 'Invite admin',
          method: 'POST',
          path: `${API}/admin/admins`,
          auth: true,
          body: { email: '{{newAdminEmail}}' },
          description:
            '201 { id, email, role: admin, status: invited, createdAt }. The invite email is queued; the worker sends it. Errors: EMAIL_ALREADY_REGISTERED 409. The test stores the new id in `targetUserId`.',
          tests: `${expect(201)}\nif (pm.response.code === 201) pm.collectionVariables.set('targetUserId', pm.response.json().data.id);`,
        }),
        req({
          name: 'List admins',
          method: 'GET',
          path: `${API}/admin/admins`,
          auth: true,
          query: [
            { key: 'limit', value: '20' },
            { key: 'sort', value: '-createdAt' },
            {
              key: 'cursor',
              value: '{{cursor}}',
              disabled: true,
              description: 'meta.nextCursor of the previous page',
            },
            {
              key: 'status[in]',
              value: 'active,invited',
              disabled: true,
              description: 'eq | in: pending_email_verification, invited, active, suspended',
            },
            { key: 'createdAt[gte]', value: '2026-01-01', disabled: true },
            { key: 'createdAt[lte]', value: '2026-12-31T23:59:59Z', disabled: true },
          ],
          description:
            'Cursor pagination: meta { nextCursor, hasMore, limit }. Unknown fields, operators or sorts: INVALID_QUERY 400. The test stores nextCursor in `cursor`; enable the cursor param to fetch the next page.',
          tests: `${expect(200)}\nconst { meta } = pm.response.json();\nif (meta) pm.collectionVariables.set('cursor', meta.nextCursor ?? '');`,
        }),
        req({
          name: 'Resend invite',
          method: 'POST',
          path: `${API}/admin/users/{{targetUserId}}/resend-invite`,
          auth: true,
          description:
            'New invite link; the previous one stops working. 204. Errors: USER_NOT_FOUND 404, USER_NOT_INVITED 409, VALIDATION_FAILED 400 for an id that is not a UUIDv7.',
          tests: expect(204),
        }),
        req({
          name: 'Suspend user',
          method: 'POST',
          path: `${API}/admin/users/{{targetUserId}}/suspend`,
          auth: true,
          body: { reason: 'Reported for abuse' },
          description:
            'Customers and admins only (S-2); active → suspended; revokes every session. 200 { id, email, role, status }. Errors: USER_NOT_FOUND 404, USER_INVALID_STATUS_TRANSITION 409 (already suspended, not active, seller or agent), CANNOT_SUSPEND_SELF 409. `reason` 3..500 chars, kept in the audit log.',
          tests: expect(200),
        }),
        req({
          name: 'Reactivate user',
          method: 'POST',
          path: `${API}/admin/users/{{targetUserId}}/reactivate`,
          auth: true,
          description:
            'suspended → active. 200 { id, email, role, status }. Errors: USER_NOT_FOUND 404, USER_INVALID_STATUS_TRANSITION 409.',
          tests: expect(200),
        }),
      ],
    },
    {
      name: 'Local helpers (Mailpit)',
      description:
        'Local docker-compose only (EMAIL_PROVIDER=mailpit). Reads the latest email sent to {{email}} and stores its OTP or invite token. Inbox UI: {{mailpitUrl}}',
      item: [
        {
          name: 'Latest email for {{email}}',
          event: [
            test(`
${expect(200)}
const message = pm.response.json().messages?.[0];
pm.test('an email was found', () => pm.expect(message).to.be.an('object'));
if (message) {
  pm.collectionVariables.set('mailpitMessageId', message.ID);
  console.log('Latest email:', message.Subject);
}`),
          ],
          request: {
            method: 'GET',
            auth: noauth,
            header: [],
            url: {
              raw: '{{mailpitUrl}}/api/v1/search?query=to:{{email}}&limit=1',
              host: ['{{mailpitUrl}}'],
              path: ['api', 'v1', 'search'],
              query: [
                { key: 'query', value: 'to:{{email}}' },
                { key: 'limit', value: '1' },
              ],
            },
            description:
              'Mailpit search API. Change `email` to look at another inbox (e.g. the invited admin).',
          },
        },
        {
          name: 'Extract OTP / invite token',
          event: [
            test(`
${expect(200)}
const text = pm.response.json().Text || '';
const invite = /token=([A-Za-z0-9_-]{43})/.exec(text);
const otp = /\\b(\\d{6})\\b/.exec(text);
if (invite) { pm.collectionVariables.set('inviteToken', invite[1]); console.log('inviteToken stored'); }
else if (otp) { pm.collectionVariables.set('otp', otp[1]); console.log('otp stored'); }
pm.test('found an OTP or an invite token', () => pm.expect(Boolean(invite || otp)).to.be.true);`),
          ],
          request: {
            method: 'GET',
            auth: noauth,
            header: [],
            url: {
              raw: '{{mailpitUrl}}/api/v1/message/{{mailpitMessageId}}',
              host: ['{{mailpitUrl}}'],
              path: ['api', 'v1', 'message', '{{mailpitMessageId}}'],
            },
            description:
              'Stores `inviteToken` (invite emails) or `otp` (verification and password-reset emails).',
          },
        },
      ],
    },
  ],
};

fs.writeFileSync(out, JSON.stringify(collection, null, 2) + '\n');
const count = (items) => items.reduce((n, i) => n + (i.item ? count(i.item) : 1), 0);
console.log(`wrote ${out}: ${count(collection.item)} requests`);

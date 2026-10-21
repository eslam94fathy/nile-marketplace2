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
const req = ({ name, method, path, body, auth = false, query, description, tests, headers = [] }) => ({
  name,
  ...(tests ? { event: [test(tests)] } : {}),
  request: {
    method,
    auth: auth ? bearer : noauth,
    header: [...(body ? [{ key: 'Content-Type', value: 'application/json' }] : []), ...headers],
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

/** Stores `data.id` (or `data[0].id` for lists) of a response into a collection variable. */
const saveId = (variable, status = 200, from = 'data.id') => `
${expect(status)}
if (pm.response.code === ${status}) {
  const body = pm.response.json();
  const value = ${from === 'data.id' ? 'body.data && body.data.id' : `body.${from}`};
  if (value) pm.collectionVariables.set('${variable}', value);
}`;
/** A fresh key per send: a retry of the same request needs the same key, so copy it by hand to test a replay. */
const idempotencyKey = { key: 'Idempotency-Key', value: '{{$guid}}' };

const API = '/api/v1';
const collection = {
  info: {
    name: 'Nile Marketplace API (Release 1 + R2-P1…P5)',
    _postman_id: 'c3a1d0e2-4f6b-4c1e-9a7d-6b2f0e8d1a01',
    description: [
      'Every endpoint built so far: health, API docs, identity (spec 03), customers (spec 04), sellers (spec 05), catalog with seller stock (spec 06), cart (spec 08), checkout and orders with COD and Kashier (spec 09), payments and refunds (spec 10), delivery (spec 11): governorates and fees, agents, shipments and the work of delivery agents, and finance (spec 12): balances, statements, COD remittances and payouts.',
      '',
      'Variables: set `baseUrl` (default http://localhost:3000) and `mailpitUrl` (local only). Login, verify, accept-invite and refresh store `accessToken`, `refreshToken` and `userId` automatically; admin routes use the stored `accessToken`.',
      '',
      'Local first run (docker compose):',
      '1. `docker compose run --rm api node dist/seed-admin.js --email you@example.com`, then set the `email` variable to that address.',
      '2. Local helpers (Mailpit) → "Latest email" → "Extract OTP / invite token".',
      '3. Auth → "Accept invite" (sets your password and logs you in).',
      '4. Admin requests now work with the stored access token.',
      '',
      'Customer / seller flow: set `email` to a fresh address → "Register customer" (or "Register seller") → Local helpers → "Latest email" → "Extract OTP / invite token" → Auth → "Verify email" (logs you in). "Delivery" → "List governorates" stores Cairo in `governorateId` first, because addresses and pickup addresses need one.',
      '',
      'Sample delivery fees and a sample catalog for local dev: `npm run seed:dev` (none is deliverable until an admin sets fees; the catalog has a category tree with attributes and an approved demo seller with active products).',
      '',
      'Catalog flow: "Admin: catalog" → Create category → Add attribute → Add option (stores `categoryId`, `attributeId`, `optionId`). Then log in as an approved seller → "Seller: catalog" → Create product → Add variant (put option ids in `optionIds`, or `[]` in a category without attributes) → Activate. "Catalog" (public) → List products / Product detail.',
      '',
      'Cart flow: log in as a customer → "Catalog" → List products → Product detail (stores the first variant in `variantId`) → "Cart" → Add item (stores the line in `cartItemId`) → My cart → Change quantity / Remove item / Empty cart.',
      '',
      'Order flow (COD): with items in the cart and an address (`addressId`) in a deliverable governorate → "Checkout & orders" → Checkout. The first send usually answers 409 ORDER_TOTAL_CHANGED and stores the current total in `expectedTotal`; send again. It stores `orderId`, `sellerOrderId` and `orderItemId`. Log in as that seller → "Seller: orders" → Accept → Ready (or Cancel item quantities / Cancel). Ready creates the shipment and assigns it to an on-shift agent of the pickup governorate (the worker must run).',
      '',
      'Kashier flow (local, PAYMENT_GATEWAY=fake): set `paymentMethod` to kashier → Checkout (the order awaits payment; the fake payment page URL is not a real page). Pay it with `npm run dev:kashier-webhook -- {{orderId}}` (or `... failed`, or an amount to try a mismatch); the worker then places the order. "Kashier payment page" asks again for the page while the window is open. Unpaid orders are cancelled by the worker after KASHIER_PAYMENT_TTL_MINUTES. "Admin: payments" shows the payment, its webhook events and the refund queue.',
      '',
      'Delivery flow: as admin → "Admin: delivery agents & shipments" → Create agent (set `agentEmail` to a fresh address and `governorateId` to the seller\'s governorate). Set `email` to `agentEmail` → Local helpers → Latest email → Extract OTP / invite token → Auth → Accept invite (logs the agent in). "Agent" → Go on shift. After a seller marks an order ready: My shipments → Picked up → Out for delivery (stores `amountToCollect`) → Delivered, or Failed attempt. `npm run seed:dev` also creates a demo agent in Cairo.',
      '',
      'Finance flow: once an order is delivered (the worker books it in the ledger) → "Admin: finance" → List accounts (stores the first in `accountId`) → Account statement; "Entries of a seller order" uses `sellerOrderId`. "Confirm COD remittance" takes cash from `agentId`; "Record payout" pays `sellerId` (set it to the seller\'s id) with a fresh `payoutReference`. Log in as the seller → "Seller: finance", or as the agent → "Agent: finance", to see the same money from their side.',
      '',
      'Release 2 so far: the audit log (spec 20 §2), image uploads (spec 14) with product and category images (spec 06 §8), the notification centre and Web Push (spec 13 §8), the web refresh cookie (spec 03 §8), support tickets (spec 16), reviews and ratings (spec 17) and the wishlist (spec 04 §8). The live socket (spec 15) is not HTTP: see docs/realtime.md.',
      '',
      'Image flow: "Media" → Request upload (stores `mediaId`) → POST the file to the returned `upload.url` with every `upload.fields` entry first and the file last as `file` (multipart/form-data; in Postman a new request, Body → form-data) → Complete upload → poll Get media until `ready` (the worker processes it). Then attach it: "Seller: product images" → Add image, or "Admin: category images" → Set image.',
      '',
      'Support flow: log in as a customer or seller → "Support" → Open ticket (stores `ticketId`) → Messages / Post message. Log in as an admin → "Admin: support" → Queue → Reply (the first reply assigns the ticket to you) or Internal note → Resolve / Close. Attachments: upload with purpose support_attachment first, then pass the `mediaId` in `attachmentMediaIds`.',
      '',
      'Review flow: a customer with a delivered order → "Reviews" → Reviewable items (stores `orderItemId`) → Write a review (stores `reviewId`); the worker moves the product and seller ratings. Log in as the seller → "Seller: reviews" → Reply. As an admin → "Admin: reviews" → Hide / Unhide. "Catalog" → Product reviews / Review summary show the public side.',
      '',
      'Back-office flow (admin): "Admin: dashboard" shows the figures (cached for DASHBOARD_CACHE_TTL_SECONDS; generatedAt is their age). "Admin: users" → List users finds any account; "Admin: customers" → List customers (stores `customerId`) → Customer detail, then "Admin: orders" with customerId[eq]. "Admin: orders" → Cancel seller order / Cancel order (Idempotency-Key, a reason for the audit log). "Admin: products" → Product (admin view) → Block (the seller is notified and can no longer activate it) → Unblock. Every admin write appears in "Admin: audit log".',
      'Tokens are per account: log in as the admin again (Auth → Login) before the "Admin: …" folders.',
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
    { key: 'governorateId', value: '' },
    { key: 'addressId', value: '' },
    { key: 'businessName', value: 'Nile Crafts' },
    { key: 'sellerId', value: '' },
    { key: 'categoryId', value: '' },
    { key: 'attributeId', value: '' },
    { key: 'optionId', value: '' },
    { key: 'productId', value: '' },
    { key: 'productSlug', value: '' },
    { key: 'variantId', value: '' },
    { key: 'cartItemId', value: '' },
    { key: 'expectedTotal', value: '0.00' },
    { key: 'paymentMethod', value: 'cod' },
    { key: 'paymentId', value: '' },
    { key: 'refundId', value: '' },
    { key: 'orderId', value: '' },
    { key: 'sellerOrderId', value: '' },
    { key: 'orderItemId', value: '' },
    { key: 'agentEmail', value: 'agent@example.com' },
    { key: 'agentId', value: '' },
    { key: 'shipmentId', value: '' },
    { key: 'amountToCollect', value: '0.00' },
    { key: 'accountId', value: '' },
    { key: 'payoutReference', value: 'BANK-TRANSFER-001' },
    { key: 'paidAt', value: '2026-10-13T09:00:00Z' },
    { key: 'mediaId', value: '' },
    { key: 'imageId', value: '' },
    { key: 'auditEntryId', value: '' },
    { key: 'notificationId', value: '' },
    { key: 'ticketId', value: '' },
    { key: 'assigneeUserId', value: '' },
    { key: 'reviewId', value: '' },
    { key: 'customerId', value: '' },
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
          name: 'Refresh (web cookie)',
          method: 'POST',
          path: `${API}/auth/refresh`,
          headers: [{ key: 'X-Nile-Client', value: 'web' }],
          description:
            'The web transport (spec 03 §8, R-21): no body; the refresh token travels in the HttpOnly cookie that a login sent with `X-Nile-Client: web` sets (Postman keeps it in its cookie jar for the api host). The response carries the access token only and rotates the cookie. Without the header the body transport applies.',
          tests: `${expect(200)}\nif (pm.response.code === 200) pm.collectionVariables.set('accessToken', pm.response.json().data.accessToken);`,
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
          name: 'List users',
          method: 'GET',
          path: `${API}/admin/users`,
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
              key: 'role[eq]',
              value: 'customer',
              disabled: true,
              description: 'customer, seller, admin, delivery_agent',
            },
            {
              key: 'status[in]',
              value: 'active,suspended',
              disabled: true,
              description: 'eq | in: pending_email_verification, invited, active, suspended',
            },
            {
              key: 'email[like]',
              value: 'mona',
              disabled: true,
              description: 'email prefix, case-insensitive',
            },
            { key: 'createdAt[gte]', value: '2026-01-01', disabled: true },
          ],
          description:
            'spec 20 §3.3. Every role. 200 { id, email, role, status, emailVerifiedAt, lastLoginAt, createdAt }[] + meta. INVALID_QUERY 400. The test stores the first id in `targetUserId`.',
          tests: `${expect(200)}\nconst { data, meta } = pm.response.json();\nif (data && data[0]) pm.collectionVariables.set('targetUserId', data[0].id);\nif (meta) pm.collectionVariables.set('cursor', meta.nextCursor ?? '');`,
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
      name: 'Admin: customers',
      description: 'spec 20 §3.3. Admin role. Reads only, not audited.',
      item: [
        req({
          name: 'List customers',
          method: 'GET',
          path: `${API}/admin/customers`,
          auth: true,
          query: [
            { key: 'limit', value: '20' },
            { key: 'sort', value: '-createdAt' },
            { key: 'name[like]', value: 'mona', disabled: true, description: 'first or last name, contains' },
            { key: 'phone[eq]', value: '+201001234567', disabled: true, description: 'E.164' },
          ],
          description:
            '200 { id, userId, email, firstName, lastName, phone, userStatus, createdAt }[] + meta. The test stores the first id in `customerId`.',
          tests: saveId('customerId', 200, 'data[0] && body.data[0].id'),
        }),
        req({
          name: 'Customer detail',
          method: 'GET',
          path: `${API}/admin/customers/{{customerId}}`,
          auth: true,
          description:
            'The list item plus addressCount. Their orders: "Admin: orders" → List orders with customerId[eq]. CUSTOMER_NOT_FOUND 404.',
          tests: expect(200),
        }),
      ],
    },
    {
      name: 'Delivery',
      description: 'spec 11 §4.1. Public, general rate limit.',
      item: [
        req({
          name: 'List governorates',
          method: 'GET',
          path: `${API}/governorates`,
          description:
            'All 27, ordered by name (English; localize by `code`, ISO 3166-2:EG). `deliveryFee` null = not deliverable. Cached in Redis. The test stores Cairo (EG-C) in `governorateId`.',
          tests: `${expect(200)}\nconst cairo = pm.response.json().data.find((g) => g.code === 'EG-C');\nif (cairo) pm.collectionVariables.set('governorateId', cairo.id);`,
        }),
      ],
    },
    {
      name: 'Customer',
      description:
        'spec 04. Registration is public (strict-auth rate limit); everything else needs a customer token (403 for other roles).',
      item: [
        req({
          name: 'Register customer',
          method: 'POST',
          path: `${API}/auth/register/customer`,
          body: {
            email: '{{email}}',
            password: '{{password}}',
            firstName: 'Mona',
            lastName: 'Ali',
            phone: '+201001234567',
          },
          description:
            '201 { userId, email, status: pending_email_verification }. A verification OTP is emailed; no tokens until Auth → "Verify email". Errors: EMAIL_ALREADY_REGISTERED 409. Phone: Egyptian mobile in E.164 (+2010/11/12/15…).',
          tests: expect(201),
        }),
        req({ name: 'My profile', method: 'GET', path: `${API}/me`, auth: true, tests: expect(200) }),
        req({
          name: 'Update my profile',
          method: 'PATCH',
          path: `${API}/me`,
          auth: true,
          body: { firstName: 'Salma', phone: '+201111234567' },
          description: 'At least one of firstName, lastName, phone. The email cannot be changed.',
          tests: expect(200),
        }),
        req({
          name: 'List my addresses',
          method: 'GET',
          path: `${API}/me/addresses`,
          auth: true,
          description: 'No pagination (max CUSTOMER_MAX_ADDRESSES). The default first, then newest first.',
          tests: expect(200),
        }),
        req({
          name: 'Add address',
          method: 'POST',
          path: `${API}/me/addresses`,
          auth: true,
          body: {
            label: 'Home',
            recipientName: 'Mona Ali',
            recipientPhone: '+201001234567',
            governorateId: '{{governorateId}}',
            city: 'Cairo',
            area: 'Zamalek',
            street: '26th of July St',
            building: '12',
            floor: '3',
            apartment: null,
            landmark: null,
            isDefault: true,
          },
          description:
            '201. Becomes the default when isDefault=true or when there is no default yet. Errors: ADDRESS_LIMIT_REACHED 422, GOVERNORATE_NOT_FOUND 422. The test stores the id in `addressId`.',
          tests: `${expect(201)}\nif (pm.response.code === 201) pm.collectionVariables.set('addressId', pm.response.json().data.id);`,
        }),
        req({
          name: 'Get address',
          method: 'GET',
          path: `${API}/me/addresses/{{addressId}}`,
          auth: true,
          description: "ADDRESS_NOT_FOUND 404 when missing, deleted or another customer's.",
          tests: expect(200),
        }),
        req({
          name: 'Update address',
          method: 'PATCH',
          path: `${API}/me/addresses/{{addressId}}`,
          auth: true,
          body: { label: 'Work', floor: null },
          description:
            'Any subset of the fields; null clears floor / apartment / landmark. isDefault=true moves the default here; isDefault=false on the default → DEFAULT_ADDRESS_UNSET_NOT_ALLOWED 422.',
          tests: expect(200),
        }),
        req({
          name: 'Delete address',
          method: 'DELETE',
          path: `${API}/me/addresses/{{addressId}}`,
          auth: true,
          description:
            'Soft delete, 204. Deleting the default leaves no default. Past orders keep their copy.',
          tests: expect(204),
        }),
      ],
    },
    {
      name: 'Seller',
      description:
        'spec 05 §4.2–§4.3. Registration is public (strict-auth rate limit); the rest needs a seller token.',
      item: [
        req({
          name: 'Register seller',
          method: 'POST',
          path: `${API}/auth/register/seller`,
          body: {
            email: '{{email}}',
            password: '{{password}}',
            businessName: '{{businessName}}',
            contactPhone: '+201221234567',
            pickupAddress: {
              governorateId: '{{governorateId}}',
              city: 'Cairo',
              area: 'Nasr City',
              street: 'Abbas El Akkad St',
              building: '5',
              landmark: null,
            },
          },
          description:
            '201 { userId, sellerId, email, status: pending_email_verification, sellerStatus: pending_approval }. Verify the email, then an admin approves. Errors: EMAIL_ALREADY_REGISTERED 409, BUSINESS_NAME_TAKEN 409 (case-insensitive), GOVERNORATE_NOT_FOUND 422. The test stores `sellerId`.',
          tests: `${expect(201)}\nif (pm.response.code === 201) pm.collectionVariables.set('sellerId', pm.response.json().data.sellerId);`,
        }),
        req({
          name: 'My seller profile',
          method: 'GET',
          path: `${API}/seller/profile`,
          auth: true,
          description: 'Includes status, rejectionReason (after a rejection) and commissionRate.',
          tests: expect(200),
        }),
        req({
          name: 'Update my seller profile',
          method: 'PATCH',
          path: `${API}/seller/profile`,
          auth: true,
          body: { contactPhone: '+201551234567' },
          description:
            'Any status; no re-approval. pickupAddress (optional) replaces the whole address. Errors: BUSINESS_NAME_TAKEN 409, GOVERNORATE_NOT_FOUND 422.',
          tests: expect(200),
        }),
        req({
          name: 'Re-apply',
          method: 'POST',
          path: `${API}/seller/profile/reapply`,
          auth: true,
          description: 'rejected → pending_approval. Otherwise SELLER_INVALID_STATUS_TRANSITION 409.',
          tests: expect(200),
        }),
      ],
    },
    {
      name: 'Admin: sellers',
      description: 'spec 05 §4.4. Admin role only. Every decision returns the seller detail.',
      item: [
        req({
          name: 'List sellers',
          method: 'GET',
          path: `${API}/admin/sellers`,
          auth: true,
          query: [
            { key: 'limit', value: '20' },
            { key: 'sort', value: '-createdAt' },
            { key: 'status[eq]', value: 'pending_approval', description: 'eq | in' },
            { key: 'businessName[like]', value: 'nile', disabled: true },
            { key: 'pickupGovernorateId[eq]', value: '{{governorateId}}', disabled: true },
            { key: 'createdAt[gte]', value: '2026-01-01', disabled: true },
            { key: 'cursor', value: '{{cursor}}', disabled: true },
          ],
          description:
            'The approval queue by default here (status=pending_approval). Cursor pagination; INVALID_QUERY 400 for anything off the whitelist. The test stores the first id in `sellerId` and nextCursor in `cursor`.',
          tests: `${expect(200)}\nconst body = pm.response.json();\nif (body.data?.[0]) pm.collectionVariables.set('sellerId', body.data[0].id);\nif (body.meta) pm.collectionVariables.set('cursor', body.meta.nextCursor ?? '');`,
        }),
        req({
          name: 'Seller detail',
          method: 'GET',
          path: `${API}/admin/sellers/{{sellerId}}`,
          auth: true,
          description:
            'Pickup address, emailVerified, and the newest 50 status / commission history entries.',
          tests: expect(200),
        }),
        req({
          name: 'Approve',
          method: 'POST',
          path: `${API}/admin/sellers/{{sellerId}}/approve`,
          auth: true,
          description:
            'pending_approval → approved; publishes seller.approved. Errors: SELLER_EMAIL_NOT_VERIFIED 409, SELLER_INVALID_STATUS_TRANSITION 409, SELLER_NOT_FOUND 404.',
          tests: expect(200),
        }),
        req({
          name: 'Reject',
          method: 'POST',
          path: `${API}/admin/sellers/{{sellerId}}/reject`,
          auth: true,
          body: { reason: 'Please add a clearer business name' },
          description:
            'pending_approval → rejected. `reason` 3..500, shown to the seller until the next decision.',
          tests: expect(200),
        }),
        req({
          name: 'Suspend',
          method: 'POST',
          path: `${API}/admin/sellers/{{sellerId}}/suspend`,
          auth: true,
          body: { reason: 'Reported counterfeit products' },
          description:
            'approved → suspended; publishes seller.suspended (catalog hides the products). Open orders continue; login still works.',
          tests: expect(200),
        }),
        req({
          name: 'Reinstate',
          method: 'POST',
          path: `${API}/admin/sellers/{{sellerId}}/reinstate`,
          auth: true,
          body: { reason: 'Appeal accepted' },
          description:
            'suspended → approved; publishes seller.approved (previousStatus suspended). The body is optional.',
          tests: expect(200),
        }),
        req({
          name: 'Change commission rate',
          method: 'PUT',
          path: `${API}/admin/sellers/{{sellerId}}/commission-rate`,
          auth: true,
          body: { commissionRate: '0.1250' },
          description:
            'Rate string 0..1, up to 4 decimals. New checkouts only. COMMISSION_RATE_UNCHANGED 409 for the current rate.',
          tests: expect(200),
        }),
        req({
          name: 'Commission settings',
          method: 'GET',
          path: `${API}/admin/settings/commission`,
          auth: true,
          tests: expect(200),
        }),
        req({
          name: 'Change default commission',
          method: 'PUT',
          path: `${API}/admin/settings/commission`,
          auth: true,
          body: { defaultCommissionRate: '0.1000' },
          description: 'Applies to sellers who register afterwards; existing sellers keep their own rate.',
          tests: expect(200),
        }),
      ],
    },
    {
      name: 'Admin: delivery',
      description: 'spec 11 §4.3 (reference data). Admin role only.',
      item: [
        req({
          name: 'List governorates (admin)',
          method: 'GET',
          path: `${API}/admin/governorates`,
          auth: true,
          tests: expect(200),
        }),
        req({
          name: 'Set delivery fee',
          method: 'PATCH',
          path: `${API}/admin/governorates/{{governorateId}}`,
          auth: true,
          body: { deliveryFee: '50.00' },
          description:
            'Money string, or null to stop delivering there. New checkouts only; clears the cached list. GOVERNORATE_NOT_FOUND 404.',
          tests: expect(200),
        }),
        req({
          name: 'Delivery settings',
          method: 'GET',
          path: `${API}/admin/settings/delivery`,
          auth: true,
          tests: expect(200),
        }),
        req({
          name: 'Change agent fee share',
          method: 'PUT',
          path: `${API}/admin/settings/delivery`,
          auth: true,
          body: { agentFeeShareRate: '0.7000' },
          description: "The agents' share of the delivery fee (Q-34). New checkouts only.",
          tests: expect(200),
        }),
      ],
    },
    {
      name: 'Catalog',
      description:
        'spec 06 §4.1. Public, general rate limit. Only visible products: active, seller approved, not deleted.',
      item: [
        req({
          name: 'Category tree',
          method: 'GET',
          path: `${API}/categories`,
          description: 'Active categories, nested, ordered by sortOrder then name. Cached.',
          tests: saveId('categoryId', 200, 'data[0] && body.data[0].id'),
        }),
        req({
          name: 'Category attributes',
          method: 'GET',
          path: `${API}/categories/{{categoryId}}/attributes`,
          description:
            'Own and inherited attributes with their options, ancestors first. CATEGORY_NOT_FOUND 404 (missing or inactive).',
          tests: expect(200),
        }),
        req({
          name: 'List products',
          method: 'GET',
          path: `${API}/products`,
          query: [
            { key: 'limit', value: '20' },
            { key: 'q', value: 'phone', disabled: true },
            { key: 'categoryId[eq]', value: '{{categoryId}}', disabled: true },
            { key: 'price[lte]', value: '1000', disabled: true },
            { key: 'inStock[eq]', value: 'true', disabled: true },
            { key: 'rating[gte]', value: '4', disabled: true },
            { key: 'attr.color[in]', value: 'black,white', disabled: true },
            { key: 'sort', value: '-publishedAt', disabled: true },
            { key: 'cursor', value: '{{cursor}}', disabled: true },
          ],
          description:
            'Filters: categoryId[eq] (includes subcategories), price[gte|lte] (lowest variant price), inStock[eq], sellerId[eq], rating[gte] (1..5; unrated never match), attr.<code>[in] (needs categoryId; all attr filters must match the same variant; max 5). q: search text 2..100 (full text + typo tolerant). Sort: publishedAt, minPrice, rating (unrated last on -rating), relevance (with q only). Default: -relevance with q, else -publishedAt.',
          tests: saveId('productId', 200, 'data[0] && body.data[0].id'),
        }),
        req({
          name: 'Product detail',
          method: 'GET',
          path: `${API}/products/{{productId}}`,
          description:
            'By id or slug. Active variants with live stock (availableQuantity = min(sellable, 99)); attributes list only the options variants use. PRODUCT_NOT_FOUND 404 when hidden or deleted.',
          tests: `
${expect(200)}
if (pm.response.code === 200) {
  const { data } = pm.response.json();
  pm.collectionVariables.set('productSlug', data.slug);
  if (data.variants[0]) pm.collectionVariables.set('variantId', data.variants[0].id);
}`,
        }),
        req({
          name: 'Product detail by slug',
          method: 'GET',
          path: `${API}/products/{{productSlug}}`,
          tests: expect(200),
        }),
      ],
    },
    {
      name: 'Admin: catalog',
      description: 'spec 06 §4.2. Admin role only. Every change clears the cached category tree.',
      item: [
        req({
          name: 'Category tree (admin)',
          method: 'GET',
          path: `${API}/admin/categories`,
          auth: true,
          description: 'Inactive categories included, each with its own attributes and options.',
          tests: expect(200),
        }),
        req({
          name: 'Create category',
          method: 'POST',
          path: `${API}/admin/categories`,
          auth: true,
          body: { parentId: null, name: 'Kitchen', sortOrder: 0 },
          description:
            'parentId null = root; max depth 3. slug defaults to the kebab-cased name. CATEGORY_NOT_FOUND 422, CATEGORY_PARENT_INACTIVE 409, CATEGORY_MAX_DEPTH_EXCEEDED 422, CATEGORY_NAME_TAKEN 409, CATEGORY_SLUG_TAKEN 409, CATEGORY_SLUG_REQUIRED 422, CATEGORY_CHILD_LIMIT_REACHED 422.',
          tests: saveId('categoryId', 201),
        }),
        req({
          name: 'Update category',
          method: 'PATCH',
          path: `${API}/admin/categories/{{categoryId}}`,
          auth: true,
          body: { name: 'Kitchen & Dining', sortOrder: 1 },
          description:
            'name, slug, sortOrder, isActive. Deactivating needs no active child and no product (CATEGORY_IN_USE 409); activating needs an active parent (CATEGORY_PARENT_INACTIVE 409). Categories never move or get deleted.',
          tests: expect(200),
        }),
        req({
          name: 'Add attribute',
          method: 'POST',
          path: `${API}/admin/categories/{{categoryId}}/attributes`,
          auth: true,
          body: { name: 'Material', code: 'material', sortOrder: 0 },
          description:
            'Inherited by subcategories; max 5 per category including inherited ones. Only while the subtree has no product. ATTRIBUTE_CODE_CONFLICT 409, CATEGORY_HAS_PRODUCTS 409, ATTRIBUTE_LIMIT_REACHED 422.',
          tests: saveId('attributeId', 201),
        }),
        req({
          name: 'Update attribute',
          method: 'PATCH',
          path: `${API}/admin/attributes/{{attributeId}}`,
          auth: true,
          body: { name: 'Main material' },
          description: 'name, sortOrder. The code is immutable (it is the public filter key).',
          tests: expect(200),
        }),
        req({
          name: 'Add option',
          method: 'POST',
          path: `${API}/admin/attributes/{{attributeId}}/options`,
          auth: true,
          body: { value: 'Steel', code: 'steel', sortOrder: 0 },
          description: 'Max 100 per attribute. OPTION_CODE_TAKEN 409, OPTION_LIMIT_REACHED 422.',
          tests: saveId('optionId', 201),
        }),
        req({
          name: 'Update option',
          method: 'PATCH',
          path: `${API}/admin/options/{{optionId}}`,
          auth: true,
          body: { value: 'Stainless steel' },
          tests: expect(200),
        }),
        req({
          name: 'Delete option',
          method: 'DELETE',
          path: `${API}/admin/options/{{optionId}}`,
          auth: true,
          description: 'Only when no variant (deleted ones included) uses it: OPTION_IN_USE 409.',
          tests: expect(204),
        }),
        req({
          name: 'Delete attribute',
          method: 'DELETE',
          path: `${API}/admin/attributes/{{attributeId}}`,
          auth: true,
          description:
            'Deletes its options too. Only when the subtree has no product, deleted ones included: ATTRIBUTE_IN_USE 409.',
          tests: expect(204),
        }),
      ],
    },
    {
      name: 'Seller: catalog',
      description:
        "spec 06 §4.3. Seller role. Writes need an approved seller (SELLER_NOT_APPROVED 403); reads work in any status. Another seller's product or variant is not found (404).",
      item: [
        req({
          name: 'List my products',
          method: 'GET',
          path: `${API}/seller/products`,
          auth: true,
          query: [
            { key: 'limit', value: '20' },
            { key: 'status[in]', value: 'draft,active', disabled: true },
            { key: 'name[like]', value: 'phone', disabled: true },
          ],
          description:
            'Filters: status[eq|in], categoryId[eq], name[like], createdAt[gte|lte]. Sort: createdAt (default -createdAt).',
          tests: expect(200),
        }),
        req({
          name: 'Create product',
          method: 'POST',
          path: `${API}/seller/products`,
          auth: true,
          body: {
            categoryId: '{{categoryId}}',
            name: 'Steel Water Bottle',
            description: 'Keeps drinks cold for 24 hours.',
          },
          description:
            'Created as a draft with an immutable slug (name + 6 random chars). CATEGORY_NOT_FOUND 422 (missing or inactive).',
          tests: `
${expect(201)}
if (pm.response.code === 201) {
  const { data } = pm.response.json();
  pm.collectionVariables.set('productId', data.id);
  pm.collectionVariables.set('productSlug', data.slug);
}`,
        }),
        req({
          name: 'My product',
          method: 'GET',
          path: `${API}/seller/products/{{productId}}`,
          auth: true,
          description: 'With live variants, their options and stock.',
          tests: expect(200),
        }),
        req({
          name: 'Update product',
          method: 'PATCH',
          path: `${API}/seller/products/{{productId}}`,
          auth: true,
          body: { description: 'Double-walled steel; keeps drinks cold for 24 hours.' },
          description:
            'name, description, categoryId (only while the product has no variant: PRODUCT_CATEGORY_LOCKED 409).',
          tests: expect(200),
        }),
        req({
          name: 'Add variant',
          method: 'POST',
          path: `${API}/seller/products/{{productId}}/variants`,
          auth: true,
          body: {
            sku: 'BOTTLE-750',
            price: '350.00',
            compareAtPrice: null,
            optionIds: [],
            initialStock: 10,
            status: 'active',
          },
          description:
            'optionIds: exactly one option per attribute of the category (own and inherited), or [] when it has none (then a single default variant). VARIANT_OPTIONS_INVALID 422 (details), DEFAULT_VARIANT_EXISTS 409, VARIANT_COMBINATION_EXISTS 409, SKU_TAKEN 409, VARIANT_LIMIT_REACHED 422, COMPARE_AT_PRICE_INVALID 422.',
          tests: saveId('variantId', 201),
        }),
        req({
          name: 'Update variant',
          method: 'PATCH',
          path: `${API}/seller/products/{{productId}}/variants/{{variantId}}`,
          auth: true,
          body: { price: '320.00', compareAtPrice: '350.00' },
          description:
            'sku, price, compareAtPrice (null clears it), status. Options are fixed: delete the variant and add another.',
          tests: expect(200),
        }),
        req({
          name: 'Activate product',
          method: 'POST',
          path: `${API}/seller/products/{{productId}}/activate`,
          auth: true,
          description:
            'draft or inactive → active. Needs an active variant: PRODUCT_HAS_NO_ACTIVE_VARIANT 409.',
          tests: expect(200),
        }),
        req({
          name: 'Deactivate product',
          method: 'POST',
          path: `${API}/seller/products/{{productId}}/deactivate`,
          auth: true,
          description: 'active → inactive (PRODUCT_INVALID_STATUS_TRANSITION 409 otherwise).',
          tests: expect(200),
        }),
        req({
          name: 'Adjust stock',
          method: 'POST',
          path: `${API}/seller/variants/{{variantId}}/stock-adjustments`,
          auth: true,
          headers: [idempotencyKey],
          body: { delta: 5 },
          description:
            'A delta (+/-), never an absolute value (S-6). Idempotency-Key required (a fresh one per send here). STOCK_ADJUSTMENT_INVALID 422 when stock would go below 0 or below the reserved quantity.',
          tests: expect(200),
        }),
        req({
          name: 'Stock history',
          method: 'GET',
          path: `${API}/seller/variants/{{variantId}}/stock-movements`,
          auth: true,
          description: 'Newest first, cursor-paginated.',
          tests: expect(200),
        }),
        req({
          name: 'Delete variant',
          method: 'DELETE',
          path: `${API}/seller/products/{{productId}}/variants/{{variantId}}`,
          auth: true,
          description:
            'Soft delete. If it was the last active variant of an active product, the product becomes inactive.',
          tests: expect(204),
        }),
        req({
          name: 'Delete product',
          method: 'DELETE',
          path: `${API}/seller/products/{{productId}}`,
          auth: true,
          description: 'Soft delete of the product and its variants.',
          tests: expect(204),
        }),
      ],
    },
    {
      name: 'Cart',
      description:
        'spec 08 §4. Customer role only, general rate limit, no Idempotency-Key (adds are summed, so a retry adds twice). Every write returns the whole cart except the deletes (204). Prices, stock and availability are live; lines with an issue (UNAVAILABLE, OUT_OF_STOCK, INSUFFICIENT_STOCK) are shown but left out of the totals.',
      item: [
        req({
          name: 'My cart',
          method: 'GET',
          path: `${API}/cart`,
          auth: true,
          description:
            'Grouped by seller (by earliest line), lines in the order they were added. id is null until the first add; a GET never creates a cart.',
          tests: saveId('cartItemId', 200, 'data.sellers[0] && body.data.sellers[0].items[0].id'),
        }),
        req({
          name: 'Add item',
          method: 'POST',
          path: `${API}/cart/items`,
          auth: true,
          body: { variantId: '{{variantId}}', quantity: 1 },
          description:
            'quantity 1..99. An existing line of the same variant gets the quantity added (always 201). VARIANT_NOT_PURCHASABLE 422, CART_ITEM_QUANTITY_LIMIT 422 (line over 99), CART_LINE_LIMIT_REACHED 422 (CART_MAX_LINES), INSUFFICIENT_STOCK 409 (details: available).',
          tests: `
${expect(201)}
if (pm.response.code === 201) {
  const variantId = pm.collectionVariables.get('variantId');
  const line = pm.response.json().data.sellers.flatMap((group) => group.items).find((item) => item.variantId === variantId);
  if (line) pm.collectionVariables.set('cartItemId', line.id);
}`,
        }),
        req({
          name: 'Change quantity',
          method: 'PATCH',
          path: `${API}/cart/items/{{cartItemId}}`,
          auth: true,
          body: { quantity: 2 },
          description:
            'Sets the absolute quantity (1..99). CART_ITEM_NOT_FOUND 404, VARIANT_NOT_PURCHASABLE 422 (an unavailable line can only be removed), INSUFFICIENT_STOCK 409.',
          tests: expect(200),
        }),
        req({
          name: 'Remove item',
          method: 'DELETE',
          path: `${API}/cart/items/{{cartItemId}}`,
          auth: true,
          description: 'CART_ITEM_NOT_FOUND 404.',
          tests: expect(204),
        }),
        req({
          name: 'Empty cart',
          method: 'DELETE',
          path: `${API}/cart`,
          auth: true,
          description: 'Removes every line; 204 also when there is no cart yet.',
          tests: expect(204),
        }),
      ],
    },
    {
      name: 'Checkout & orders',
      description:
        'spec 09 §4.1. Customer role. Checkout (paymentMethod cod | kashier) needs an Idempotency-Key and has its own per-user rate limit, shared with "Kashier payment page". Amounts are EGP strings.',
      item: [
        req({
          name: 'Checkout',
          method: 'POST',
          path: `${API}/checkout`,
          auth: true,
          headers: [idempotencyKey],
          body: {
            addressId: '{{addressId}}',
            paymentMethod: '{{paymentMethod}}',
            expectedTotal: '{{expectedTotal}}',
          },
          description:
            'Places the cart as one order split per seller, reserves stock and empties the cart (201). COD: placed. Kashier: pending_payment, with data.kashier.checkoutUrl (null if Kashier failed: use "Kashier payment page"). CART_EMPTY 422, CART_HAS_ISSUES 409 (details: variant ids), ADDRESS_NOT_FOUND 422, GOVERNORATE_NOT_DELIVERABLE 422, ORDER_TOTAL_CHANGED 409 (details[0].value = current total; stored in expectedTotal), ORDER_PAYMENT_PENDING 409 (Kashier while you have an unpaid order; details[0].value = its id), INSUFFICIENT_STOCK 409. A repeat with the same Idempotency-Key replays the first answer.',
          tests: `
if (pm.response.code === 409 && pm.response.json().error.code === 'ORDER_TOTAL_CHANGED') {
  pm.collectionVariables.set('expectedTotal', pm.response.json().error.details[0].value);
  console.log('expectedTotal updated: send again');
  return;
}
${expect(201)}
if (pm.response.code === 201) {
  const { order } = pm.response.json().data;
  pm.collectionVariables.set('orderId', order.id);
  const first = order.sellerOrders[0];
  const { kashier } = pm.response.json().data;
  if (kashier) console.log('Kashier payment page:', kashier.checkoutUrl, 'until', kashier.expiresAt);
  if (first) {
    pm.collectionVariables.set('sellerOrderId', first.id);
    if (first.items[0]) pm.collectionVariables.set('orderItemId', first.items[0].id);
  }
}`,
        }),
        req({
          name: 'My orders',
          method: 'GET',
          path: `${API}/orders`,
          auth: true,
          query: [
            { key: 'limit', value: '20' },
            { key: 'status[in]', value: 'placed,in_progress', disabled: true },
            { key: 'createdAt[gte]', value: '2026-01-01', disabled: true },
          ],
          description: 'Newest first. itemCount = units still to deliver.',
          tests: expect(200),
        }),
        req({
          name: 'Order detail',
          method: 'GET',
          path: `${API}/orders/{{orderId}}`,
          auth: true,
          description:
            'Seller orders with items and timelines, shipping snapshot, payment status. ORDER_NOT_FOUND 404.',
          tests: expect(200),
        }),
        req({
          name: 'Kashier payment page',
          method: 'POST',
          path: `${API}/orders/{{orderId}}/payment/kashier-session`,
          auth: true,
          description:
            'The payment page of a Kashier order while it awaits payment; the same session every time. ORDER_NOT_FOUND 404, ORDER_NOT_AWAITING_PAYMENT 409 (COD, paid, or the window closed), PAYMENT_PROVIDER_UNAVAILABLE 502 (retry).',
          tests: expect(200),
        }),
        req({
          name: 'Cancel a seller order',
          method: 'POST',
          path: `${API}/orders/{{orderId}}/seller-orders/{{sellerOrderId}}/cancel`,
          auth: true,
          headers: [idempotencyKey],
          body: { note: 'Changed my mind' },
          description:
            'Only while placed (canCancel). Releases its stock; the order total drops (OR-13). SELLER_ORDER_NOT_CANCELLABLE 409, ORDER_NOT_FOUND / SELLER_ORDER_NOT_FOUND 404.',
          tests: expect(200),
        }),
      ],
    },
    {
      name: 'Seller: orders',
      description:
        'spec 09 §4.2. Seller role, any seller status (open orders continue after a suspension). No customer name, phone or address (S-11); orders awaiting payment are never shown. Each action answers with the seller order after the change.',
      item: [
        req({
          name: 'My seller orders',
          method: 'GET',
          path: `${API}/seller/orders`,
          auth: true,
          query: [
            { key: 'limit', value: '20' },
            { key: 'status[eq]', value: 'placed', disabled: true },
          ],
          tests: saveId('sellerOrderId', 200, 'data[0] && body.data[0].id'),
        }),
        req({
          name: 'Seller order detail',
          method: 'GET',
          path: `${API}/seller/orders/{{sellerOrderId}}`,
          auth: true,
          description: 'SELLER_ORDER_NOT_FOUND 404.',
          tests: saveId('orderItemId', 200, 'data.items[0] && body.data.items[0].id'),
        }),
        req({
          name: 'Accept',
          method: 'POST',
          path: `${API}/seller/orders/{{sellerOrderId}}/accept`,
          auth: true,
          description:
            'placed → accepted, also after the deadline until the timeout job ran. SELLER_ORDER_INVALID_STATUS_TRANSITION 409.',
          tests: expect(200),
        }),
        req({
          name: 'Ready for pickup',
          method: 'POST',
          path: `${API}/seller/orders/{{sellerOrderId}}/ready`,
          auth: true,
          description:
            'accepted → ready_for_pickup; publishes seller_order.ready_for_pickup (delivery creates the shipment from Phase 6).',
          tests: expect(200),
        }),
        req({
          name: 'Cancel item quantities',
          method: 'POST',
          path: `${API}/seller/orders/{{sellerOrderId}}/items/{{orderItemId}}/cancel`,
          auth: true,
          headers: [idempotencyKey],
          body: { quantity: 1, reason: 'out_of_stock' },
          description:
            'reason out_of_stock | seller_request | other (note required for other). Until picked up. Cancelling every open unit cancels the seller order. ITEM_CANCEL_QUANTITY_INVALID 422, ORDER_ITEM_NOT_FOUND 404, SELLER_ORDER_NOT_CANCELLABLE 409.',
          tests: expect(200),
        }),
        req({
          name: 'Cancel',
          method: 'POST',
          path: `${API}/seller/orders/{{sellerOrderId}}/cancel`,
          auth: true,
          headers: [idempotencyKey],
          body: { note: 'Out of stock' },
          description:
            'The whole seller order, until picked up; stock is released. SELLER_ORDER_NOT_CANCELLABLE 409.',
          tests: expect(200),
        }),
        req({
          name: 'Return received',
          method: 'POST',
          path: `${API}/seller/orders/{{sellerOrderId}}/return-received`,
          auth: true,
          headers: [idempotencyKey],
          description:
            'returning_to_seller → returned_to_seller; stock is released. SELLER_ORDER_INVALID_STATUS_TRANSITION 409.',
          tests: expect(200),
        }),
      ],
    },
    {
      name: 'Admin: orders',
      description:
        'spec 09 §4.3, §8.4. Admin role. Cancellations need an Idempotency-Key and a reason (3..500, admins only; the customer sees cancelReason admin_cancelled).',
      item: [
        req({
          name: 'List orders',
          method: 'GET',
          path: `${API}/admin/orders`,
          auth: true,
          query: [
            { key: 'limit', value: '20' },
            { key: 'status[eq]', value: 'placed', disabled: true },
            { key: 'orderNumber[eq]', value: 'NM-000000001', disabled: true },
            { key: 'customerId[eq]', value: '', disabled: true },
          ],
          tests: saveId('orderId', 200, 'data[0] && body.data[0].id'),
        }),
        req({
          name: 'Order detail (admin)',
          method: 'GET',
          path: `${API}/admin/orders/{{orderId}}`,
          auth: true,
          description:
            'Adds commission per seller order and the full status histories (actor role, actor id, reason).',
          tests: `${expect(200)}\nconst { data } = pm.response.json();\nif (data && data.sellerOrders && data.sellerOrders[0]) pm.collectionVariables.set('sellerOrderId', data.sellerOrders[0].id);`,
        }),
        req({
          name: 'Cancel seller order',
          method: 'POST',
          path: `${API}/admin/seller-orders/{{sellerOrderId}}/cancel`,
          auth: true,
          headers: [idempotencyKey],
          body: { reason: 'Fraudulent order' },
          description:
            'From placed, accepted or ready_for_pickup: releases stock, flags a refund for a paid Kashier order, writes an audit row. 200 the admin order detail. SELLER_ORDER_NOT_FOUND 404, SELLER_ORDER_NOT_CANCELLABLE 409.',
          tests: expect(200),
        }),
        req({
          name: 'Cancel order',
          method: 'POST',
          path: `${API}/admin/orders/{{orderId}}/cancel`,
          auth: true,
          headers: [idempotencyKey],
          body: { reason: 'Customer fraud report' },
          description:
            'All or nothing (OR-17): every open seller order is cancelled, or none when one is past ready_for_pickup. 200 the admin order detail. ORDER_NOT_FOUND 404, ORDER_NOT_CANCELLABLE 409 (details: the blocking sellerOrderIds; none when nothing is left to cancel).',
          tests: expect(200),
        }),
      ],
    },
    {
      name: 'Admin: products',
      description:
        'spec 20 §3.4. Admin role. Uses `productId`. A block takes the product off the shop (active → inactive) and refuses activation until unblocked; the seller may still edit it.',
      item: [
        req({
          name: 'Product (admin view)',
          method: 'GET',
          path: `${API}/admin/products/{{productId}}`,
          auth: true,
          description:
            "The seller's product detail (any status) plus sellerId, adminBlocked and adminBlockReason. PRODUCT_NOT_FOUND 404.",
          tests: expect(200),
        }),
        req({
          name: 'Block product',
          method: 'POST',
          path: `${API}/admin/products/{{productId}}/block`,
          auth: true,
          body: { reason: 'Prohibited item' },
          description:
            '`reason` 3..500, shown to the seller in their product view. The seller is notified (product_blocked). 200 the admin view. PRODUCT_NOT_FOUND 404, PRODUCT_BLOCK_INVALID_STATUS 409 (already blocked).',
          tests: expect(200),
        }),
        req({
          name: 'Unblock product',
          method: 'POST',
          path: `${API}/admin/products/{{productId}}/unblock`,
          auth: true,
          description:
            'Clears the block; the product stays inactive for the seller to activate. 200 the admin view. PRODUCT_NOT_FOUND 404, PRODUCT_BLOCK_INVALID_STATUS 409 (not blocked).',
          tests: expect(200),
        }),
      ],
    },
    {
      name: 'Admin: dashboard',
      description: 'spec 20 §3.2. Admin role. Days are Cairo business days.',
      item: [
        req({
          name: 'Dashboard',
          method: 'GET',
          path: `${API}/admin/dashboard`,
          auth: true,
          description:
            'orders (open seller orders by status, placedToday, placedLast7Days), gmv (30 days ending today: placed and delivered), topSellers (10, by delivered GMV over the same days), sellers.pendingApproval, support, finance (codOutstanding, sellerPayable, agentFeePayable), delivery. Cached for DASHBOARD_CACHE_TTL_SECONDS; generatedAt is when it was computed.',
          tests: expect(200),
        }),
      ],
    },
    {
      name: 'Admin: payments',
      description:
        'spec 10 §4.2. Admin role. R1 refunds are done by hand in the Kashier dashboard, then recorded here; the queue lists the refunds due, oldest first.',
      item: [
        req({
          name: 'Payment of an order',
          method: 'GET',
          path: `${API}/admin/orders/{{orderId}}/payment`,
          auth: true,
          description:
            'Amounts, Kashier references, refunds and webhook events (no payloads). PAYMENT_NOT_FOUND 404.',
          tests: saveId('paymentId'),
        }),
        req({
          name: 'Payment detail',
          method: 'GET',
          path: `${API}/admin/payments/{{paymentId}}`,
          auth: true,
          tests: expect(200),
        }),
        req({
          name: 'Refund queue',
          method: 'GET',
          path: `${API}/admin/payments/refunds`,
          auth: true,
          query: [
            { key: 'status[eq]', value: 'pending_manual' },
            { key: 'limit', value: '20' },
            { key: 'reason[in]', value: 'seller_order_cancelled,late_payment_after_expiry', disabled: true },
          ],
          tests: saveId('refundId', 200, 'data[0] && body.data[0].id'),
        }),
        req({
          name: 'Record a refund',
          method: 'POST',
          path: `${API}/admin/payments/refunds/{{refundId}}/record`,
          auth: true,
          headers: [idempotencyKey],
          body: { providerRefundRef: 'KASHIER-REFUND-REF' },
          description:
            'After refunding in the Kashier dashboard. The payment becomes partially_refunded_manually or refunded_manually. REFUND_NOT_FOUND 404, REFUND_ALREADY_RECORDED 409.',
          tests: expect(200),
        }),
      ],
    },
    {
      name: 'Admin: delivery agents & shipments',
      description: 'spec 11 §4.3 (agents, shipments). Admin role only.',
      item: [
        req({
          name: 'Create agent',
          method: 'POST',
          path: `${API}/admin/delivery-agents`,
          auth: true,
          body: {
            email: '{{agentEmail}}',
            fullName: 'Karim Hassan',
            phone: '+201101234567',
            homeGovernorateId: '{{governorateId}}',
          },
          description:
            'An active agent, off shift, with an invited login: the invite is emailed (Mailpit locally). EMAIL_ALREADY_REGISTERED 409, GOVERNORATE_NOT_FOUND 422. Stores agentId.',
          tests: saveId('agentId', 201),
        }),
        req({
          name: 'List agents',
          method: 'GET',
          path: `${API}/admin/delivery-agents`,
          auth: true,
          query: [
            { key: 'limit', value: '20' },
            { key: 'status[eq]', value: 'active', disabled: true },
            { key: 'onShift[eq]', value: 'true', disabled: true },
            { key: 'homeGovernorateId[eq]', value: '{{governorateId}}', disabled: true },
            { key: 'fullName[like]', value: 'Karim', disabled: true },
            { key: 'sort', value: '-createdAt', disabled: true },
            { key: 'cursor', value: '{{cursor}}', disabled: true },
          ],
          tests: expect(200),
        }),
        req({
          name: 'Agent detail',
          method: 'GET',
          path: `${API}/admin/delivery-agents/{{agentId}}`,
          auth: true,
          description: 'AGENT_NOT_FOUND 404.',
          tests: expect(200),
        }),
        req({
          name: 'Update agent',
          method: 'PATCH',
          path: `${API}/admin/delivery-agents/{{agentId}}`,
          auth: true,
          body: { fullName: 'Karim M. Hassan' },
          description: 'Any of fullName, phone, homeGovernorateId. GOVERNORATE_NOT_FOUND 422.',
          tests: expect(200),
        }),
        req({
          name: 'Deactivate agent',
          method: 'POST',
          path: `${API}/admin/delivery-agents/{{agentId}}/deactivate`,
          auth: true,
          description:
            'Off shift, no new work, an active login suspended. AGENT_HAS_ACTIVE_SHIPMENTS 409 (reassign them first), AGENT_INVALID_STATUS_TRANSITION 409.',
          tests: expect(200),
        }),
        req({
          name: 'Activate agent',
          method: 'POST',
          path: `${API}/admin/delivery-agents/{{agentId}}/activate`,
          auth: true,
          description: 'A suspended login is reactivated. AGENT_INVALID_STATUS_TRANSITION 409.',
          tests: expect(200),
        }),
        req({
          name: 'List shipments',
          method: 'GET',
          path: `${API}/admin/shipments`,
          auth: true,
          query: [
            { key: 'limit', value: '20' },
            { key: 'status[in]', value: 'unassigned,assigned', disabled: true },
            { key: 'agentId[eq]', value: '{{agentId}}', disabled: true },
            { key: 'orderId[eq]', value: '{{orderId}}', disabled: true },
            { key: 'sort', value: '-createdAt', disabled: true },
            { key: 'cursor', value: '{{cursor}}', disabled: true },
          ],
          description: 'Stores the first shipment in shipmentId.',
          tests: saveId('shipmentId', 200, 'data[0] && body.data[0].id'),
        }),
        req({
          name: 'Shipment detail',
          method: 'GET',
          path: `${API}/admin/shipments/{{shipmentId}}`,
          auth: true,
          description: 'With its attempts and status history. SHIPMENT_NOT_FOUND 404.',
          tests: expect(200),
        }),
        req({
          name: 'Assign shipment',
          method: 'POST',
          path: `${API}/admin/shipments/{{shipmentId}}/assign`,
          auth: true,
          body: { agentId: '{{agentId}}' },
          description:
            'Assign or reassign before pickup, to any active agent (shift and governorate may be overridden). AGENT_NOT_FOUND 422, AGENT_INACTIVE 409, SHIPMENT_NOT_ASSIGNABLE 409, SHIPMENT_ALREADY_ASSIGNED_TO_AGENT 409.',
          tests: expect(200),
        }),
      ],
    },
    {
      name: 'Agent',
      description:
        'spec 11 §4.2. Log in as the agent first (accept the invite from Mailpit). Every request but "My agent profile" needs an active agent (403 AGENT_INACTIVE).',
      item: [
        req({
          name: 'My agent profile',
          method: 'GET',
          path: `${API}/agent/profile`,
          auth: true,
          tests: expect(200),
        }),
        req({
          name: 'Go on shift',
          method: 'PATCH',
          path: `${API}/agent/availability`,
          auth: true,
          body: { onShift: true },
          description:
            'On shift, new shipments picked up in your home governorate are assigned to you. Going off shift keeps current ones.',
          tests: expect(200),
        }),
        req({
          name: 'My shipments',
          method: 'GET',
          path: `${API}/agent/shipments`,
          auth: true,
          query: [
            { key: 'limit', value: '20' },
            { key: 'status[in]', value: 'delivered,returned_to_seller,cancelled', disabled: true },
            { key: 'sort', value: 'createdAt', disabled: true },
            { key: 'cursor', value: '{{cursor}}', disabled: true },
          ],
          description:
            'Without a status filter the active ones, oldest first; enable status[in] for the history. Stores the first one in shipmentId.',
          tests: saveId('shipmentId', 200, 'data[0] && body.data[0].id'),
        }),
        req({
          name: 'Shipment',
          method: 'GET',
          path: `${API}/agent/shipments/{{shipmentId}}`,
          auth: true,
          description: 'SHIPMENT_NOT_FOUND 404, also for a shipment of another agent.',
          tests: expect(200),
        }),
        req({
          name: 'Picked up',
          method: 'POST',
          path: `${API}/agent/shipments/{{shipmentId}}/picked-up`,
          auth: true,
          description: 'assigned → picked_up. SHIPMENT_INVALID_STATUS_TRANSITION 409.',
          tests: expect(200),
        }),
        req({
          name: 'Out for delivery',
          method: 'POST',
          path: `${API}/agent/shipments/{{shipmentId}}/out-for-delivery`,
          auth: true,
          description:
            'picked_up or delivery_failed → out_for_delivery. The first COD parcel of a checkout to go out carries the delivery fee: amountToCollect = items + fee. Stores it in amountToCollect.',
          tests: [
            expect(200),
            "if (pm.response.code === 200) pm.collectionVariables.set('amountToCollect', pm.response.json().data.amountToCollect);",
          ].join('\n'),
        }),
        req({
          name: 'Delivered',
          method: 'POST',
          path: `${API}/agent/shipments/{{shipmentId}}/delivered`,
          auth: true,
          headers: [idempotencyKey],
          body: { codCollectedAmount: '{{amountToCollect}}' },
          description:
            'COD: codCollectedAmount must equal amountToCollect (COD_AMOUNT_MISMATCH / COD_AMOUNT_REQUIRED 422). Kashier: send no body (COD_AMOUNT_NOT_ALLOWED 422).',
          tests: expect(200),
        }),
        req({
          name: 'Failed attempt',
          method: 'POST',
          path: `${API}/agent/shipments/{{shipmentId}}/failed-attempt`,
          auth: true,
          headers: [idempotencyKey],
          body: { reason: 'customer_unreachable', note: 'No answer at the door' },
          description:
            'reason: customer_unreachable | customer_refused | wrong_address | customer_rescheduled. Refused or the 3rd attempt → returning_to_seller (the seller confirms the return in "Seller: orders"); otherwise delivery_failed, and the fee moves to the next parcel going out.',
          tests: expect(200),
        }),
        req({
          name: 'Returned (cancelled after pickup)',
          method: 'POST',
          path: `${API}/agent/shipments/{{shipmentId}}/returned`,
          auth: true,
          headers: [idempotencyKey],
          description:
            'Only for a parcel whose seller order was cancelled after you picked it up: you handed it back to the seller. SHIPMENT_INVALID_STATUS_TRANSITION 409 otherwise.',
          tests: expect(200),
        }),
        req({
          name: 'Go off shift',
          method: 'PATCH',
          path: `${API}/agent/availability`,
          auth: true,
          body: { onShift: false },
          tests: expect(200),
        }),
      ],
    },
    {
      name: 'Admin: finance',
      description:
        'spec 12 §4.1. Admin role. Balances and statements come from the ledger, booked by the worker when a seller order is delivered and when an order closes. Remittances and payouts need an Idempotency-Key.',
      item: [
        req({
          name: 'List accounts',
          method: 'GET',
          path: `${API}/admin/finance/accounts`,
          auth: true,
          query: [
            { key: 'limit', value: '20' },
            { key: 'accountType[in]', value: 'seller_payable,agent_cod_cash', disabled: true },
            { key: 'ownerId[eq]', value: '{{sellerId}}', disabled: true },
            { key: 'balance[gt]', value: '0', disabled: true },
            { key: 'sort', value: '-balance', disabled: true },
            { key: 'cursor', value: '{{cursor}}', disabled: true },
          ],
          description:
            "With the owner's name (seller business name / agent name; null for the platform accounts). Default sort -balance; platform_delivery_revenue may be negative. Stores the first in accountId.",
          tests: saveId('accountId', 200, 'data[0] && body.data[0].id'),
        }),
        req({
          name: 'Account detail',
          method: 'GET',
          path: `${API}/admin/finance/accounts/{{accountId}}`,
          auth: true,
          description: 'ACCOUNT_NOT_FOUND 404.',
          tests: expect(200),
        }),
        req({
          name: 'Account statement',
          method: 'GET',
          path: `${API}/admin/finance/accounts/{{accountId}}/entries`,
          auth: true,
          query: [
            { key: 'limit', value: '20' },
            { key: 'entryType[in]', value: 'seller_net_earned,seller_payout', disabled: true },
            { key: 'createdAt[gte]', value: '2026-10-01T00:00:00Z', disabled: true },
            { key: 'sort', value: '-createdAt', disabled: true },
            { key: 'cursor', value: '{{cursor}}', disabled: true },
          ],
          description: 'Every entry with its balanceAfter, newest first. ACCOUNT_NOT_FOUND 404.',
          tests: expect(200),
        }),
        req({
          name: 'Entries of a seller order',
          method: 'GET',
          path: `${API}/admin/finance/entries`,
          auth: true,
          query: [
            { key: 'referenceType', value: 'seller_order' },
            { key: 'referenceId', value: '{{sellerOrderId}}' },
          ],
          description:
            'Every money movement of one reference (seller_order, order, cod_remittance, payout), with its accountId. Both parameters required (INVALID_QUERY 400); not paginated.',
          tests: expect(200),
        }),
        req({
          name: 'Confirm COD remittance',
          method: 'POST',
          path: `${API}/admin/finance/cod-remittances`,
          auth: true,
          headers: [idempotencyKey],
          body: { agentId: '{{agentId}}', amount: '100.00', note: 'Handed in at the hub' },
          description:
            'Cash the agent handed in; debits their COD cash. AGENT_NOT_FOUND 422, REMITTANCE_EXCEEDS_BALANCE 422 (also when the agent holds no cash yet).',
          tests: expect(201),
        }),
        req({
          name: 'List COD remittances',
          method: 'GET',
          path: `${API}/admin/finance/cod-remittances`,
          auth: true,
          query: [
            { key: 'limit', value: '20' },
            { key: 'agentId[eq]', value: '{{agentId}}', disabled: true },
            { key: 'cursor', value: '{{cursor}}', disabled: true },
          ],
          tests: expect(200),
        }),
        req({
          name: 'Record payout',
          method: 'POST',
          path: `${API}/admin/finance/payouts`,
          auth: true,
          headers: [idempotencyKey],
          body: {
            payeeType: 'seller',
            payeeId: '{{sellerId}}',
            amount: '50.00',
            externalReference: '{{payoutReference}}',
            paidAt: '{{paidAt}}',
          },
          description:
            'A transfer made outside the system (payeeType seller or agent; an agent is paid their fee shares). paidAt needs a time zone and may not be in the future. PAYEE_NOT_FOUND 422, PAYOUT_EXCEEDS_BALANCE 422, PAID_AT_IN_FUTURE 422, PAYOUT_ALREADY_RECORDED 409 (same externalReference for this payee: change payoutReference).',
          tests: expect(201),
        }),
        req({
          name: 'List payouts',
          method: 'GET',
          path: `${API}/admin/finance/payouts`,
          auth: true,
          query: [
            { key: 'limit', value: '20' },
            { key: 'payeeType[eq]', value: 'seller', disabled: true },
            { key: 'payeeId[eq]', value: '{{sellerId}}', disabled: true },
            { key: 'cursor', value: '{{cursor}}', disabled: true },
          ],
          tests: expect(200),
        }),
      ],
    },
    {
      name: 'Seller: finance',
      description: 'spec 12 §4.2. Log in as the seller first. Read-only; works in any seller status.',
      item: [
        req({
          name: 'My balance',
          method: 'GET',
          path: `${API}/seller/finance/balance`,
          auth: true,
          description: 'What the platform owes you; "0.00" and updatedAt null before your first delivery.',
          tests: expect(200),
        }),
        req({
          name: 'My statement',
          method: 'GET',
          path: `${API}/seller/finance/entries`,
          auth: true,
          query: [
            { key: 'limit', value: '20' },
            { key: 'entryType[eq]', value: 'seller_payout', disabled: true },
            { key: 'cursor', value: '{{cursor}}', disabled: true },
          ],
          tests: expect(200),
        }),
        req({
          name: 'My payouts',
          method: 'GET',
          path: `${API}/seller/finance/payouts`,
          auth: true,
          query: [
            { key: 'limit', value: '20' },
            { key: 'cursor', value: '{{cursor}}', disabled: true },
          ],
          tests: expect(200),
        }),
      ],
    },
    {
      name: 'Agent: finance',
      description: 'spec 12 §4.3. Log in as the agent first. Read-only; works for an inactive agent too.',
      item: [
        req({
          name: 'My balances',
          method: 'GET',
          path: `${API}/agent/finance/balances`,
          auth: true,
          description:
            'feePayable: fee shares the platform owes you. codCashHeld: platform cash you still hold.',
          tests: expect(200),
        }),
        req({
          name: 'My statement (fee or cod)',
          method: 'GET',
          path: `${API}/agent/finance/entries`,
          auth: true,
          query: [
            { key: 'account', value: 'cod' },
            { key: 'limit', value: '20' },
            { key: 'cursor', value: '{{cursor}}', disabled: true },
          ],
          description:
            'account is required: fee (your fee shares) or cod (cash collected and handed in). INVALID_QUERY 400.',
          tests: expect(200),
        }),
        req({
          name: 'My remittances',
          method: 'GET',
          path: `${API}/agent/finance/remittances`,
          auth: true,
          query: [
            { key: 'limit', value: '20' },
            { key: 'cursor', value: '{{cursor}}', disabled: true },
          ],
          tests: expect(200),
        }),
      ],
    },
    {
      name: 'Admin: audit log',
      description: 'spec 20 §2. Every admin write leaves an append-only row; reads are not audited.',
      item: [
        req({
          name: 'List entries',
          method: 'GET',
          path: `${API}/admin/audit-log`,
          auth: true,
          query: [
            { key: 'limit', value: '20' },
            { key: 'action[eq]', value: 'support_ticket.assigned', disabled: true },
            { key: 'targetType[eq]', value: 'support_ticket', disabled: true },
            { key: 'targetId[eq]', value: '{{ticketId}}', disabled: true },
            { key: 'actorUserId[eq]', value: '{{userId}}', disabled: true },
            { key: 'createdAt[gte]', value: '2026-10-01', disabled: true },
            { key: 'cursor', value: '{{cursor}}', disabled: true },
          ],
          description: 'Newest first. Stores the first entry in `auditEntryId`.',
          tests: saveId('auditEntryId', 200, 'data[0] && body.data[0].id'),
        }),
        req({
          name: 'Entry',
          method: 'GET',
          path: `${API}/admin/audit-log/{{auditEntryId}}`,
          auth: true,
          description: 'AUDIT_ENTRY_NOT_FOUND 404.',
          tests: expect(200),
        }),
      ],
    },
    {
      name: 'Media',
      description:
        'spec 14. Customers, sellers and admins; rate class `upload` per user. Purposes: product_image (sellers), category_image (admins), review_image (customers), support_attachment (all three, private), return_photo (customers, private).',
      item: [
        req({
          name: 'Request upload',
          method: 'POST',
          path: `${API}/media/uploads`,
          auth: true,
          body: { purpose: 'product_image', contentType: 'image/png', sizeBytes: 120000 },
          description:
            '201 { media, upload: { url, fields, expiresAt } }: POST the file straight to storage with that form. Stores `mediaId`. Errors: MEDIA_PURPOSE_NOT_ALLOWED 403, MEDIA_OPEN_UPLOAD_LIMIT_REACHED 422.',
          tests: saveId('mediaId', 201, 'data && body.data.media.id'),
        }),
        req({
          name: 'Complete upload',
          method: 'POST',
          path: `${API}/media/uploads/{{mediaId}}/complete`,
          auth: true,
          description:
            '202 processing (200 when already processing or ready). Errors: MEDIA_UPLOAD_MISSING 409 (the file is not in storage yet), MEDIA_UPLOAD_INVALID 422, MEDIA_INVALID_STATUS 409.',
        }),
        req({
          name: 'Get media',
          method: 'GET',
          path: `${API}/media/{{mediaId}}`,
          auth: true,
          description:
            'Your upload: poll until status is ready (with image URLs) or failed. MEDIA_NOT_FOUND 404.',
          tests: expect(200),
        }),
      ],
    },
    {
      name: 'Seller: product images',
      description:
        'spec 06 §8. Up to 8 per product, from your own ready product_image uploads. Log in as the seller first.',
      item: [
        req({
          name: 'Add image',
          method: 'POST',
          path: `${API}/seller/products/{{productId}}/images`,
          auth: true,
          body: { mediaId: '{{mediaId}}', variantId: null, altText: 'Front view' },
          description:
            'Answers every image of the product. Optional `position` (0..7; past the end appends) and `variantId` (an image of one variant). Stores the last image in `imageId`. Errors: MEDIA_NOT_ATTACHABLE 422, the 8-image limit 422.',
          tests: saveId('imageId', 201, 'data[body.data.length - 1] && body.data[body.data.length - 1].id'),
        }),
        req({
          name: 'Update image',
          method: 'PATCH',
          path: `${API}/seller/products/{{productId}}/images/{{imageId}}`,
          auth: true,
          body: { altText: 'Side view' },
          description: '`variantId` and / or `altText`; at least one.',
          tests: expect(200),
        }),
        req({
          name: 'Reorder images',
          method: 'PUT',
          path: `${API}/seller/products/{{productId}}/images/order`,
          auth: true,
          body: { imageIds: ['{{imageId}}'] },
          description: 'Every image id of the product, once each, in the new order.',
          tests: expect(200),
        }),
        req({
          name: 'Remove image',
          method: 'DELETE',
          path: `${API}/seller/products/{{productId}}/images/{{imageId}}`,
          auth: true,
          tests: expect(204),
        }),
      ],
    },
    {
      name: 'Admin: category images',
      description: "spec 06 §8. Any admin may use any admin's ready category_image upload (ME-2). Audited.",
      item: [
        req({
          name: 'Set image',
          method: 'PUT',
          path: `${API}/admin/categories/{{categoryId}}/image`,
          auth: true,
          body: { mediaId: '{{mediaId}}', altText: 'Kitchen' },
          description: 'Setting the same image again changes only the alt text.',
          tests: expect(200),
        }),
        req({
          name: 'Remove image',
          method: 'DELETE',
          path: `${API}/admin/categories/{{categoryId}}/image`,
          auth: true,
          description: 'A category without an image is a no-op.',
          tests: expect(204),
        }),
      ],
    },
    {
      name: 'Notifications & push',
      description:
        'spec 13 §8. Any signed-in role. In-app rows are kept 90 days; preferences affect push only. Web Push needs a browser (pushManager.subscribe); the requests below show the shapes.',
      item: [
        req({
          name: 'My notifications',
          method: 'GET',
          path: `${API}/me/notifications`,
          auth: true,
          query: [
            { key: 'limit', value: '20' },
            { key: 'read[eq]', value: 'false', disabled: true },
            { key: 'category[in]', value: 'orders,support', disabled: true },
            { key: 'cursor', value: '{{cursor}}', disabled: true },
          ],
          description: 'Newest first. Stores the first in `notificationId`.',
          tests: saveId('notificationId', 200, 'data[0] && body.data[0].id'),
        }),
        req({
          name: 'Unread count',
          method: 'GET',
          path: `${API}/me/notifications/unread-count`,
          auth: true,
          description: 'Counted up to 100 (show "99+").',
          tests: expect(200),
        }),
        req({
          name: 'Mark read',
          method: 'POST',
          path: `${API}/me/notifications/{{notificationId}}/read`,
          auth: true,
          description: 'Idempotent. NOTIFICATION_NOT_FOUND 404.',
          tests: expect(204),
        }),
        req({
          name: 'Mark all read',
          method: 'POST',
          path: `${API}/me/notifications/read-all`,
          auth: true,
          tests: expect(204),
        }),
        req({
          name: 'Push preferences',
          method: 'GET',
          path: `${API}/me/notification-preferences`,
          auth: true,
          description: 'All four categories with defaults filled in (promotions off).',
          tests: expect(200),
        }),
        req({
          name: 'Change push preferences',
          method: 'PUT',
          path: `${API}/me/notification-preferences`,
          auth: true,
          body: { preferences: [{ category: 'support', pushEnabled: false }] },
          description: 'Only the listed categories change.',
          tests: expect(200),
        }),
        req({
          name: 'Push config',
          method: 'GET',
          path: `${API}/push/config`,
          auth: true,
          description: 'The VAPID public key for pushManager.subscribe.',
          tests: expect(200),
        }),
        req({
          name: 'Register push subscription',
          method: 'POST',
          path: `${API}/me/push-subscriptions`,
          auth: true,
          body: {
            endpoint: 'https://fcm.googleapis.com/fcm/send/example-endpoint',
            expirationTime: null,
            keys: {
              p256dh:
                'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM',
              auth: 'tBHItJI5svbpez7KI4CCXg',
            },
          },
          description:
            '`PushSubscription.toJSON()` as the browser gives it. A host outside the allow-list: PUSH_ENDPOINT_NOT_ALLOWED 422. 10 per user; the 11th replaces the oldest.',
          tests: expect(201),
        }),
        req({
          name: 'Unregister push subscription',
          method: 'POST',
          path: `${API}/me/push-subscriptions/unregister`,
          auth: true,
          body: { endpoint: 'https://fcm.googleapis.com/fcm/send/example-endpoint' },
          description: 'Before logout. Always 204.',
          tests: expect(204),
        }),
      ],
    },
    {
      name: 'Support',
      description:
        'spec 16 §4.1. Customers and sellers, their own tickets. Opening and posting need an Idempotency-Key and are in rate class support-message. Admins appear as "Nile Support".',
      item: [
        req({
          name: 'Open ticket',
          method: 'POST',
          path: `${API}/support/tickets`,
          auth: true,
          headers: [idempotencyKey],
          body: {
            category: 'order',
            subject: 'Where is my parcel?',
            body: 'It has been a week since I ordered.',
            orderId: '{{orderId}}',
            attachmentMediaIds: [],
          },
          description:
            'Customers may link `orderId` and optionally one `sellerOrderId` of it; sellers send `sellerOrderId` only (an `orderId` from a seller is 400). Remove the link fields for a general question. `seller_onboarding` is for sellers. Up to 3 private images (purpose support_attachment). Stores `ticketId`. Errors (422): SUPPORT_CATEGORY_NOT_ALLOWED, ORDER_NOT_FOUND, SELLER_ORDER_NOT_FOUND, SUPPORT_OPEN_TICKET_LIMIT_REACHED, MEDIA_NOT_ATTACHABLE.',
          tests: saveId('ticketId', 201),
        }),
        req({
          name: 'My tickets',
          method: 'GET',
          path: `${API}/support/tickets`,
          auth: true,
          query: [
            { key: 'limit', value: '20' },
            { key: 'status[in]', value: 'open,awaiting_admin,awaiting_user', disabled: true },
            { key: 'category[eq]', value: 'order', disabled: true },
            { key: 'sort', value: '-lastMessageAt', disabled: true },
            { key: 'cursor', value: '{{cursor}}', disabled: true },
          ],
          description: 'Latest activity first; `hasUnread` marks a reply you have not read.',
          tests: expect(200),
        }),
        req({
          name: 'Ticket',
          method: 'GET',
          path: `${API}/support/tickets/{{ticketId}}`,
          auth: true,
          description: "SUPPORT_TICKET_NOT_FOUND 404 (also for another user's ticket).",
          tests: expect(200),
        }),
        req({
          name: 'Messages',
          method: 'GET',
          path: `${API}/support/tickets/{{ticketId}}/messages`,
          auth: true,
          query: [
            { key: 'limit', value: '20' },
            { key: 'cursor', value: '{{cursor}}', disabled: true },
          ],
          description:
            "Newest first (reverse to show). Attachment URLs are short-lived: refetch, don't store.",
          tests: expect(200),
        }),
        req({
          name: 'Post message',
          method: 'POST',
          path: `${API}/support/tickets/{{ticketId}}/messages`,
          auth: true,
          headers: [idempotencyKey],
          body: { body: 'Any news?', attachmentMediaIds: [] },
          description: 'Reopens a resolved ticket. SUPPORT_TICKET_CLOSED 409: open a new ticket.',
          tests: expect(201),
        }),
        req({
          name: 'Mark read',
          method: 'POST',
          path: `${API}/support/tickets/{{ticketId}}/read`,
          auth: true,
          tests: expect(204),
        }),
      ],
    },
    {
      name: 'Admin: support',
      description:
        'spec 16 §4.2. Every ticket, for any admin. Assign, resolve and close are audited; replies and notes are not.',
      item: [
        req({
          name: 'Queue',
          method: 'GET',
          path: `${API}/admin/support/tickets`,
          auth: true,
          query: [
            { key: 'limit', value: '20' },
            { key: 'status[in]', value: 'open,awaiting_admin', disabled: true },
            { key: 'assigned[eq]', value: 'false', disabled: true },
            { key: 'assignedAdminId[eq]', value: '{{userId}}', disabled: true },
            { key: 'slaBreached[eq]', value: 'true', disabled: true },
            { key: 'openerRole[eq]', value: 'seller', disabled: true },
            { key: 'sort', value: 'awaitingAdminSince', disabled: true },
            { key: 'cursor', value: '{{cursor}}', disabled: true },
          ],
          description:
            'Latest activity first. `sort=awaitingAdminSince` is the oldest-waiting queue (waiting tickets only). `assigned` with `assignedAdminId` is INVALID_QUERY. Stores the first in `ticketId`.',
          tests: saveId('ticketId', 200, 'data[0] && body.data[0].id'),
        }),
        req({
          name: 'Ticket',
          method: 'GET',
          path: `${API}/admin/support/tickets/{{ticketId}}`,
          auth: true,
          description: 'With the opener (name, email), the assignee and the SLA fields.',
          tests: expect(200),
        }),
        req({
          name: 'Messages (notes included)',
          method: 'GET',
          path: `${API}/admin/support/tickets/{{ticketId}}/messages`,
          auth: true,
          query: [
            { key: 'limit', value: '20' },
            { key: 'cursor', value: '{{cursor}}', disabled: true },
          ],
          tests: expect(200),
        }),
        req({
          name: 'Reply',
          method: 'POST',
          path: `${API}/admin/support/tickets/{{ticketId}}/messages`,
          auth: true,
          headers: [idempotencyKey],
          body: { body: 'We are looking into it.', attachmentMediaIds: [] },
          description:
            'Waits for the user afterwards; the first reply on an unassigned ticket assigns it to you. SUPPORT_TICKET_CLOSED 409.',
          tests: expect(201),
        }),
        req({
          name: 'Internal note',
          method: 'POST',
          path: `${API}/admin/support/tickets/{{ticketId}}/messages`,
          auth: true,
          headers: [idempotencyKey],
          body: { body: 'Courier says delivered; checking.', internal: true },
          description: 'Never shown to the user; no status change; allowed on a closed ticket.',
          tests: expect(201),
        }),
        req({
          name: 'Assign',
          method: 'POST',
          path: `${API}/admin/support/tickets/{{ticketId}}/assign`,
          auth: true,
          body: { adminUserId: '{{assigneeUserId}}' },
          description:
            "An active admin's user id, or null to unassign. The current assignee again changes nothing. SUPPORT_ASSIGNEE_INVALID 422, SUPPORT_TICKET_CLOSED 409.",
          tests: expect(200),
        }),
        req({
          name: 'Resolve',
          method: 'POST',
          path: `${API}/admin/support/tickets/{{ticketId}}/resolve`,
          auth: true,
          description:
            'The user can reopen it by writing; closed automatically after SUPPORT_AUTO_CLOSE_AFTER_HOURS. SUPPORT_TICKET_INVALID_STATUS_TRANSITION 409.',
          tests: expect(200),
        }),
        req({
          name: 'Close',
          method: 'POST',
          path: `${API}/admin/support/tickets/{{ticketId}}/close`,
          auth: true,
          description: 'For good (spam, duplicates). SUPPORT_TICKET_INVALID_STATUS_TRANSITION 409.',
          tests: expect(200),
        }),
        req({
          name: 'Mark read',
          method: 'POST',
          path: `${API}/admin/support/tickets/{{ticketId}}/read`,
          auth: true,
          tests: expect(204),
        }),
      ],
    },
    {
      name: 'Reviews',
      description:
        'spec 17 §4.2. Customers review products they received: one live review per product, within REVIEW_WINDOW_DAYS of delivery; edit within REVIEW_EDIT_WINDOW_DAYS. Images: upload with purpose review_image first.',
      item: [
        req({
          name: 'Reviewable items',
          method: 'GET',
          path: `${API}/me/reviewable-items`,
          auth: true,
          query: [
            { key: 'limit', value: '20' },
            { key: 'cursor', value: '{{cursor}}', disabled: true },
          ],
          description:
            'Delivered items still in the window, products already reviewed left out, newest delivery first. Stores the first in `orderItemId`.',
          tests: saveId('orderItemId', 200, 'data[0] && body.data[0].orderItemId'),
        }),
        req({
          name: 'Write a review',
          method: 'POST',
          path: `${API}/reviews`,
          auth: true,
          body: {
            orderItemId: '{{orderItemId}}',
            rating: 5,
            title: 'Great',
            body: 'Works as described.',
            imageMediaIds: [],
          },
          description:
            'Published at once. Stores `reviewId`. Errors: REVIEW_NOT_ALLOWED 422, REVIEW_WINDOW_CLOSED 422, REVIEW_ALREADY_EXISTS 409, MEDIA_NOT_ATTACHABLE 422.',
          tests: saveId('reviewId', 201),
        }),
        req({
          name: 'My reviews',
          method: 'GET',
          path: `${API}/me/reviews`,
          auth: true,
          query: [
            { key: 'limit', value: '20' },
            { key: 'cursor', value: '{{cursor}}', disabled: true },
          ],
          description: 'Newest first; hidden ones included (status hidden, no reason).',
          tests: expect(200),
        }),
        req({
          name: 'My review',
          method: 'GET',
          path: `${API}/me/reviews/{{reviewId}}`,
          auth: true,
          tests: expect(200),
        }),
        req({
          name: 'Edit my review',
          method: 'PATCH',
          path: `${API}/me/reviews/{{reviewId}}`,
          auth: true,
          body: { rating: 4, body: 'Still good after a month.' },
          description: 'At least one field; imageMediaIds replaces the list. REVIEW_EDIT_WINDOW_CLOSED 422.',
          tests: expect(200),
        }),
        req({
          name: 'Delete my review',
          method: 'DELETE',
          path: `${API}/me/reviews/{{reviewId}}`,
          auth: true,
          description: 'The product can be reviewed again while its window is open.',
          tests: expect(204),
        }),
        req({
          name: 'Product reviews (public)',
          method: 'GET',
          path: `${API}/products/{{productId}}/reviews`,
          query: [
            { key: 'limit', value: '20' },
            { key: 'rating[in]', value: '4,5', disabled: true },
            { key: 'hasImages[eq]', value: 'true', disabled: true },
            { key: 'sort', value: '-rating', disabled: true },
            { key: 'cursor', value: '{{cursor}}', disabled: true },
          ],
          description: 'Published reviews of a visible product (PRODUCT_NOT_FOUND 404). No token needed.',
          tests: expect(200),
        }),
        req({
          name: 'Review summary (public)',
          method: 'GET',
          path: `${API}/products/{{productId}}/reviews/summary`,
          description: 'Average, count and distribution, from the stored aggregate.',
          tests: expect(200),
        }),
      ],
    },
    {
      name: 'Seller: reviews',
      description: 'spec 17 §4.3. Reading works in any seller status; replying needs an approved seller.',
      item: [
        req({
          name: 'Reviews of my products',
          method: 'GET',
          path: `${API}/seller/reviews`,
          auth: true,
          query: [
            { key: 'limit', value: '20' },
            { key: 'replied[eq]', value: 'false', disabled: true },
            { key: 'productId[eq]', value: '{{productId}}', disabled: true },
            { key: 'rating[in]', value: '1,2', disabled: true },
            { key: 'cursor', value: '{{cursor}}', disabled: true },
          ],
          description: 'Stores the first in `reviewId`.',
          tests: saveId('reviewId', 200, 'data[0] && body.data[0].id'),
        }),
        req({
          name: 'Reply',
          method: 'POST',
          path: `${API}/seller/reviews/{{reviewId}}/reply`,
          auth: true,
          body: { body: 'Thank you for the review!' },
          description: 'Once, final. SELLER_NOT_APPROVED 403, REVIEW_HIDDEN 409, REVIEW_ALREADY_REPLIED 409.',
          tests: expect(201),
        }),
      ],
    },
    {
      name: 'Admin: reviews',
      description: 'spec 17 §4.4. Hiding a review removes it from the ratings; every action is audited.',
      item: [
        req({
          name: 'List reviews',
          method: 'GET',
          path: `${API}/admin/reviews`,
          auth: true,
          query: [
            { key: 'limit', value: '20' },
            { key: 'status[eq]', value: 'hidden', disabled: true },
            { key: 'rating[lte]', value: '2', disabled: true },
            { key: 'productId[eq]', value: '{{productId}}', disabled: true },
            { key: 'cursor', value: '{{cursor}}', disabled: true },
          ],
          description: 'Stores the first in `reviewId`.',
          tests: saveId('reviewId', 200, 'data[0] && body.data[0].id'),
        }),
        req({
          name: 'Review',
          method: 'GET',
          path: `${API}/admin/reviews/{{reviewId}}`,
          auth: true,
          tests: expect(200),
        }),
        req({
          name: 'Hide review',
          method: 'POST',
          path: `${API}/admin/reviews/{{reviewId}}/hide`,
          auth: true,
          body: { reason: 'Abusive language' },
          description: 'REVIEW_INVALID_STATUS_TRANSITION 409 when already hidden.',
          tests: expect(200),
        }),
        req({
          name: 'Unhide review',
          method: 'POST',
          path: `${API}/admin/reviews/{{reviewId}}/unhide`,
          auth: true,
          tests: expect(200),
        }),
        req({
          name: 'Hide reply',
          method: 'POST',
          path: `${API}/admin/reviews/{{reviewId}}/reply/hide`,
          auth: true,
          body: { reason: 'Rude reply' },
          description: 'REVIEW_REPLY_NOT_FOUND 404 without a reply.',
          tests: expect(200),
        }),
        req({
          name: 'Unhide reply',
          method: 'POST',
          path: `${API}/admin/reviews/{{reviewId}}/reply/unhide`,
          auth: true,
          tests: expect(200),
        }),
      ],
    },
    {
      name: 'Wishlist',
      description: 'spec 04 §8. Customers; products, not variants; WISHLIST_MAX_ITEMS per customer.',
      item: [
        req({
          name: 'My wishlist',
          method: 'GET',
          path: `${API}/me/wishlist`,
          auth: true,
          query: [
            { key: 'limit', value: '20' },
            { key: 'cursor', value: '{{cursor}}', disabled: true },
          ],
          description:
            'Newest first, with product cards; products no longer visible stay with available: false.',
          tests: expect(200),
        }),
        req({
          name: 'Wishlisted product ids',
          method: 'GET',
          path: `${API}/me/wishlist/product-ids`,
          auth: true,
          tests: expect(200),
        }),
        req({
          name: 'Add product',
          method: 'PUT',
          path: `${API}/me/wishlist/{{productId}}`,
          auth: true,
          description: 'Idempotent. PRODUCT_NOT_FOUND 422 (not visible), WISHLIST_LIMIT_REACHED 422.',
          tests: expect(204),
        }),
        req({
          name: 'Remove product',
          method: 'DELETE',
          path: `${API}/me/wishlist/{{productId}}`,
          auth: true,
          description: 'Always 204.',
          tests: expect(204),
        }),
      ],
    },
    {
      name: 'Sellers (public)',
      description: 'spec 05 §8.2.',
      item: [
        req({
          name: 'Seller page',
          method: 'GET',
          path: `${API}/sellers/{{sellerId}}`,
          description:
            'An approved seller: name, rating, member since. SELLER_NOT_FOUND 404 otherwise. No token needed.',
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

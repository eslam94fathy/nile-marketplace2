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
    name: 'Nile Marketplace API (Phases 1–5)',
    _postman_id: 'c3a1d0e2-4f6b-4c1e-9a7d-6b2f0e8d1a01',
    description: [
      'Every endpoint built so far: health, API docs, identity (spec 03), customers (spec 04), sellers (spec 05), catalog with seller stock (spec 06), cart (spec 08), checkout and orders with COD and Kashier (spec 09), payments and refunds (spec 10) and delivery reference data (spec 11 §4.1, §4.3).',
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
      'Order flow (COD): with items in the cart and an address (`addressId`) in a deliverable governorate → "Checkout & orders" → Checkout. The first send usually answers 409 ORDER_TOTAL_CHANGED and stores the current total in `expectedTotal`; send again. It stores `orderId`, `sellerOrderId` and `orderItemId`. Log in as that seller → "Seller: orders" → Accept → Ready (or Cancel item quantities / Cancel). Shipment steps arrive with delivery (Phase 6).',
      '',
      'Kashier flow (local, PAYMENT_GATEWAY=fake): set `paymentMethod` to kashier → Checkout (the order awaits payment; the fake payment page URL is not a real page). Pay it with `npm run dev:kashier-webhook -- {{orderId}}` (or `... failed`, or an amount to try a mismatch); the worker then places the order. "Kashier payment page" asks again for the page while the window is open. Unpaid orders are cancelled by the worker after KASHIER_PAYMENT_TTL_MINUTES. "Admin: payments" shows the payment, its webhook events and the refund queue.',
      '',
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
            { key: 'attr.color[in]', value: 'black,white', disabled: true },
            { key: 'sort', value: '-publishedAt', disabled: true },
            { key: 'cursor', value: '{{cursor}}', disabled: true },
          ],
          description:
            'Filters: categoryId[eq] (includes subcategories), price[gte|lte] (lowest variant price), inStock[eq], sellerId[eq], attr.<code>[in] (needs categoryId; all attr filters must match the same variant; max 5). q: search text 2..100 (full text + typo tolerant). Sort: publishedAt, minPrice, relevance (with q only). Default: -relevance with q, else -publishedAt.',
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
            'Places the cart as one order split per seller, reserves stock and empties the cart (201). COD: placed. Kashier: pending_payment, with data.kashier.checkoutUrl (null if Kashier failed: use "Kashier payment page"). CART_EMPTY 422, CART_HAS_ISSUES 409 (details: variant ids), ADDRESS_NOT_FOUND 422, GOVERNORATE_NOT_DELIVERABLE 422, ORDER_TOTAL_CHANGED 409 (details[0].value = current total; stored in expectedTotal), INSUFFICIENT_STOCK 409. A repeat with the same Idempotency-Key replays the first answer.',
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
      description: 'spec 09 §4.3. Admin role. No admin cancellation in R1 (S-9).',
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

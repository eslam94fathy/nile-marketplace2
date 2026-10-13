/* eslint-disable no-console -- k6 scripts log through console; this is not application code. */
// k6 load test (plan §10, P8-Q13). Traffic mix of CLAUDE.md §15: ~95 % catalog reads, cart and COD
// checkout bursts, account lists. Data from `npm run perf:seed` (test/load/.data/perf-data.json).
//
// P8: a local baseline on docker-compose (test/load/README.md). P9: the same script against staging at
// production sizes, where the thresholds below are the pass criteria.
//
//   docker run --rm -v "$PWD/test/load:/load" -w /load grafana/k6:2.3.0 run scenarios.js \
//     -e BASE_URL=http://host.docker.internal:3000 -e RATE=300 -e DURATION=10m
import { check } from 'k6';
import exec from 'k6/execution';
import http from 'k6/http';
import { SharedArray } from 'k6/data';

const BASE_URL = `${__ENV.BASE_URL || 'http://host.docker.internal:3000'}/api/v1`;
// Total requests per second at full mix (CLAUDE.md §15: 300 req/s peak).
const RATE = Number(__ENV.RATE || 300);
const DURATION = __ENV.DURATION || '10m';

const data = JSON.parse(open('./.data/perf-data.json'));
const customers = new SharedArray('customers', () => data.customers);
const sellers = new SharedArray('sellers', () => data.sellers);
const variantIds = new SharedArray('variantIds', () => data.variantIds);
const productSlugs = new SharedArray('productSlugs', () => data.productSlugs);
const leafCategoryIds = new SharedArray('leafCategoryIds', () => data.leafCategoryIds);
const searchTerms = new SharedArray('searchTerms', () => data.searchTerms);

const pick = (list) => list[Math.floor(Math.random() * list.length)];
const auth = (token) => ({ Authorization: `Bearer ${token}` });
// Share of RATE per read scenario; the checkout flow runs on its own rate (3 requests per iteration).
const DEFAULT_SHARE = { list: 0.37, search: 0.2, filter: 0.15, detail: 0.17, reference: 0.05, account: 0.04 };
// Override one share for an experiment, e.g. -e SHARE_SEARCH=0 to measure everything but search.
const SHARE = Object.fromEntries(
  Object.entries(DEFAULT_SHARE).map(([key, share]) => [
    key,
    Number(__ENV[`SHARE_${key.toUpperCase()}`] ?? share),
  ]),
);
const CHECKOUTS_PER_SECOND = Number(__ENV.CHECKOUTS_PER_SECOND || 2.5);

function readScenario(exec_, share) {
  const rate = Math.round(RATE * share);
  return {
    executor: 'constant-arrival-rate',
    exec: exec_,
    rate,
    timeUnit: '1s',
    duration: DURATION,
    preAllocatedVUs: Math.max(5, rate),
    maxVUs: Math.max(5, rate * 5),
  };
}

export const options = {
  discardResponseBodies: false,
  scenarios: {
    // A share of 0 leaves the scenario out.
    ...Object.fromEntries(
      Object.entries(SHARE)
        .filter(([, share]) => share > 0)
        .map(([name, share]) => [name, readScenario(name, share)]),
    ),
    checkout: {
      executor: 'constant-arrival-rate',
      exec: 'checkout',
      rate: Math.round(CHECKOUTS_PER_SECOND * 10),
      timeUnit: '10s',
      duration: DURATION,
      preAllocatedVUs: 20,
      maxVUs: 100,
    },
  },
  // P9 pass criteria (P8-Q13); in the local baseline they are reported, not required.
  thresholds: {
    'http_req_duration{kind:read}': ['p(95)<300'],
    'http_req_duration{kind:checkout}': ['p(95)<500'],
    http_req_failed: ['rate<0.001'],
  },
  summaryTrendStats: ['avg', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

const ok = (res, name) =>
  check(res, { [`${name} 2xx`]: (r) => r.status >= 200 && r.status < 300 }) ||
  console.warn(`${name}: ${res.status} ${String(res.body).slice(0, 200)}`);

const read = (path, name, headers = {}) =>
  http.get(`${BASE_URL}${path}`, { headers, tags: { name, kind: 'read' } });

/** The checkout needs the delivery fee of the customers' governorate (Cairo, perf:seed). */
export function setup() {
  const res = http.get(`${BASE_URL}/governorates`);
  const cairo = res.json('data').find((g) => g.code === 'EG-C');
  return { feeCents: toCents(cairo.deliveryFee) };
}

export function list() {
  const sort = Math.random() < 0.2 ? '&sort=minPrice' : '';
  const first = read(`/products?limit=20${sort}`, 'products_list');
  ok(first, 'products_list');
  const cursor = first.status === 200 ? first.json('meta.nextCursor') : null;
  if (cursor && Math.random() < 0.3) {
    ok(read(`/products?limit=20${sort}&cursor=${cursor}`, 'products_list_page2'), 'products_list_page2');
  }
}

export function search() {
  ok(
    read(`/products?limit=20&q=${encodeURIComponent(pick(searchTerms))}`, 'products_search'),
    'products_search',
  );
}

export function filter() {
  const size = pick(['s', 'm', 'l']);
  const price = Math.random() < 0.5 ? '&price[gte]=100&price[lte]=600' : '';
  ok(
    read(
      `/products?limit=20&categoryId=${pick(leafCategoryIds)}&attr.size[in]=${size}${price}`,
      'products_filter',
    ),
    'products_filter',
  );
}

export function detail() {
  ok(read(`/products/${pick(productSlugs)}`, 'product_detail'), 'product_detail');
}

export function reference() {
  if (Math.random() < 0.5) ok(read('/categories', 'categories'), 'categories');
  else ok(read('/governorates', 'governorates'), 'governorates');
}

export function account() {
  const roll = Math.random();
  if (roll < 0.5) {
    ok(read('/orders?limit=20', 'my_orders', auth(pick(customers).token)), 'my_orders');
  } else if (roll < 0.8) {
    ok(read('/seller/orders?limit=20', 'seller_orders', auth(pick(sellers))), 'seller_orders');
  } else if (roll < 0.9) {
    ok(read('/seller/finance/entries?limit=20', 'seller_entries', auth(pick(sellers))), 'seller_entries');
  } else if (roll < 0.95) {
    ok(read('/admin/orders?limit=20', 'admin_orders', auth(data.admin)), 'admin_orders');
  } else {
    ok(read('/admin/finance/accounts?limit=20', 'admin_accounts', auth(data.admin)), 'admin_accounts');
  }
}

/**
 * Add a line, read the cart, check out with COD (Idempotency-Key, expectedTotal = items + fee).
 * Customers rotate per iteration, so one customer never checks out twice at the same time.
 */
export function checkout(ctx) {
  const customer = customers[exec.scenario.iterationInTest % customers.length];
  const headers = { ...auth(customer.token), 'Content-Type': 'application/json' };
  const tags = { kind: 'checkout' };

  const added = http.post(
    `${BASE_URL}/cart/items`,
    JSON.stringify({ variantId: pick(variantIds), quantity: 1 }),
    {
      headers,
      tags: { ...tags, name: 'cart_add' },
    },
  );
  if (!ok(added, 'cart_add')) return;
  const cart = http.get(`${BASE_URL}/cart`, { headers, tags: { ...tags, name: 'cart_get' } });
  if (!ok(cart, 'cart_get')) return;
  const expectedTotal = fromCents(toCents(cart.json('data.itemsTotal')) + ctx.feeCents);
  const placed = http.post(
    `${BASE_URL}/checkout`,
    JSON.stringify({ addressId: customer.addressId, paymentMethod: 'cod', expectedTotal }),
    { headers: { ...headers, 'Idempotency-Key': uuid() }, tags: { ...tags, name: 'checkout' } },
  );
  ok(placed, 'checkout');
}

// Money as integer piastres (no floating-point sums, CLAUDE.md §6.2).
function toCents(money) {
  const [pounds, piastres = '0'] = String(money).split('.');
  return Number(pounds) * 100 + Number(piastres.padEnd(2, '0'));
}
function fromCents(cents) {
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
}
function uuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

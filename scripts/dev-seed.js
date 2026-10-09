'use strict';
// Usage: npm run seed:dev
// Local development only: sets sample delivery fees so checkout has deliverable governorates
// (the migration seeds every fee as NULL on purpose, spec 11 DE-2 / P2-Q4). Real fees are set by an
// admin through PATCH /admin/governorates/:id. Re-running is safe: it sets the same values again.
const knex = require('knex');
const { Redis } = require('ioredis');

/** Sample fees in EGP, keyed by ISO 3166-2:EG code. Every other governorate stays non-deliverable. */
const SAMPLE_FEES = {
  'EG-C': '50.00', // Cairo
  'EG-GZ': '50.00', // Giza
  'EG-KB': '55.00', // Qalyubia
  'EG-ALX': '65.00', // Alexandria
};
// Must match GOVERNORATES_CACHE_KEY in src/app/delivery/constants.ts.
const GOVERNORATES_CACHE_KEY = 'v1:delivery:governorates';

function requireEnv(key) {
  const value = process.env[key];
  if (!value) {
    console.error(`dev-seed: ${key} is not set (run with --env-file=.env; see npm run dev:env)`);
    process.exit(1);
  }
  return value;
}

async function main() {
  if (requireEnv('NODE_ENV') !== 'development') {
    console.error('dev-seed: refusing to run outside NODE_ENV=development');
    process.exit(1);
  }
  const db = knex({ client: 'pg', connection: requireEnv('DATABASE_URL') });
  const redis = new Redis(requireEnv('REDIS_URL'), {
    keyPrefix: requireEnv('REDIS_KEY_PREFIX'),
    lazyConnect: true,
  });
  try {
    for (const [code, fee] of Object.entries(SAMPLE_FEES)) {
      const updated = await db('governorates')
        .where({ code })
        .update({ delivery_fee: fee, updated_at: db.fn.now() });
      if (updated !== 1) throw new Error(`governorate ${code} not found: run the migrations first`);
    }
    await redis.connect();
    await redis.del(GOVERNORATES_CACHE_KEY);
    console.log(`dev-seed: delivery fees set for ${Object.keys(SAMPLE_FEES).join(', ')}`);
  } finally {
    await db.destroy();
    redis.disconnect();
  }
}

main().catch((error) => {
  console.error('dev-seed failed:', error.message);
  process.exit(1);
});

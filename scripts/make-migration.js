'use strict';
// Usage: npm run migrate:make -- <snake_case_name>
// Creates src/migrations/<UTC timestamp>_<name>.ts with an up/down raw-SQL template (CLAUDE.md §6.1).
const fs = require('node:fs');
const path = require('node:path');

const name = process.argv[2];
if (!name || !/^[a-z0-9]+(_[a-z0-9]+)*$/.test(name)) {
  console.error('Usage: npm run migrate:make -- <snake_case_name>');
  process.exit(1);
}
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const file = path.join(__dirname, '..', 'src', 'migrations', `${stamp}_${name}.ts`);
const template = `import { type Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.raw(\`
  \`);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(\`
  \`);
}
`;
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, template, { flag: 'wx' });
console.log(`Created ${path.relative(process.cwd(), file)}`);

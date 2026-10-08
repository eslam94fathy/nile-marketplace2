'use strict';
// Usage: npm run migrate:make -- <snake_case_name>
// Creates src/migrations/<UTC timestamp>_<name>.ts with an up/down raw-SQL template (CLAUDE.md §6.1)
// and registers it in src/migrations/index.ts (migrations are listed explicitly, in order).
const fs = require('node:fs');
const path = require('node:path');

const name = process.argv[2];
if (!name || !/^[a-z0-9]+(_[a-z0-9]+)*$/.test(name)) {
  console.error('Usage: npm run migrate:make -- <snake_case_name>');
  process.exit(1);
}

const dir = path.join(__dirname, '..', 'src', 'migrations');
const indexFile = path.join(dir, 'index.ts');
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const migrationName = `${stamp}_${name}`;
const file = path.join(dir, `${migrationName}.ts`);

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

const IMPORT_MARKER = '// <migration-imports>';
const LIST_MARKER = '  // <migration-list>';
const index = fs.readFileSync(indexFile, 'utf8');
if (!index.includes(IMPORT_MARKER) || !index.includes(LIST_MARKER)) {
  console.error('src/migrations/index.ts is missing its <migration-imports>/<migration-list> markers');
  process.exit(1);
}
const updatedIndex = index
  .replace(IMPORT_MARKER, `import * as m${stamp} from './${migrationName}';\n${IMPORT_MARKER}`)
  .replace(LIST_MARKER, `  { name: '${migrationName}', module: m${stamp} },\n${LIST_MARKER}`);

fs.writeFileSync(file, template, { flag: 'wx' });
fs.writeFileSync(indexFile, updatedIndex);
console.log(`Created ${path.relative(process.cwd(), file)} and registered it in src/migrations/index.ts`);

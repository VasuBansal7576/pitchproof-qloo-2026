import { readFile } from 'node:fs/promises';

export async function applyMigrations(db: D1Database): Promise<void> {
  const directory = new URL('../../drizzle/', import.meta.url);
  const journal = JSON.parse(await readFile(new URL('meta/_journal.json', directory), 'utf8')) as { entries: { tag: string }[] };
  for (const { tag } of journal.entries) {
    const migration = await readFile(new URL(`${tag}.sql`, directory), 'utf8');
    for (const statement of migration.split('--> statement-breakpoint').filter(statement => statement.trim())) {
      await db.exec(statement.replace(/\s+/g, ' ').trim());
    }
  }
}

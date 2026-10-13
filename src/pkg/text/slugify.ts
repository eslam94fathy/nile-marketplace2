/**
 * Kebab-case slug from free text: lower-cased, accents stripped, every run of characters outside
 * `[a-z0-9]` becomes one `-`, trimmed of leading/trailing dashes, cut to `maxLength` without a
 * trailing dash. Returns '' when nothing usable is left (the caller decides the fallback).
 * The result matches `^[a-z0-9]+(?:-[a-z0-9]+)*$` whenever it is non-empty.
 */
export function slugify(text: string, maxLength: number): string {
  if (!Number.isInteger(maxLength) || maxLength < 1) throw new RangeError('maxLength must be >= 1');
  const slug = text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug.slice(0, maxLength).replace(/-+$/, '');
}

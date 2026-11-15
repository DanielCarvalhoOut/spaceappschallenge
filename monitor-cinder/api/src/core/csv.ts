/** Text cell for CSV export: quotes when needed and neutralizes spreadsheet formulas (=, +, -, @, tab). */
export function sanitizeCsvCell(val: unknown): string {
  if (val === null || val === undefined) return '';
  const str = String(val).replace(/[\r\n]+/g, ' ');
  if (/^[=+\-@\t\r]/.test(str)) {
    return `"'${str.replace(/"/g, '""')}"`;
  }
  if (str.includes(',') || str.includes('"')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/** Numeric cell: finite numbers as plain text (never quoted, so negative coordinates stay numbers), else empty. */
export const csvNumber = (v: number | null | undefined): string => (typeof v === 'number' && Number.isFinite(v) ? String(v) : '');

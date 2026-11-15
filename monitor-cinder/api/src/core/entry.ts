import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/**
 * True when this module is the script that was started (`tsx src/jobs/x.ts`).
 * Comparing `file://${argv[1]}` breaks on Windows (C:\… vs file:///C:/…) and with symlinks,
 * so both sides are normalized through pathToFileURL(realpath).
 */
export function isMain(importMetaUrl: string): boolean {
  const script = process.argv[1];
  if (!script) return false;
  try {
    return pathToFileURL(realpathSync(script)).href === importMetaUrl;
  } catch {
    return false;
  }
}

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.resolve(__dirname, '../.env');

if (fs.existsSync(envPath)) {
  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx <= 0) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim().replace(/^['"]|['"]$/g, '');
    if (process.env[key] === undefined) {
      process.env[key] = val;
    }
  }
}

const ConfigSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  HOST: z.string().default('0.0.0.0'),
  CORS_ORIGIN: z.string().default('*'),
  DATABASE_URL: z.string().default('postgresql://cinder:cinder@localhost:5432/cinder'),
  // empty (as in .env.example) means "no key": the app then serves only the cached FIRMS index
  FIRMS_MAP_KEY: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.string().regex(/^[0-9a-f]{32}$/i, 'FIRMS_MAP_KEY must be a 32-char hex string').optional()
  ),
  GOIAS_BBOX: z.string().default('-53.25,-19.50,-45.90,-12.39'),
});

export type AppConfig = z.infer<typeof ConfigSchema> & {
  bbox: [number, number, number, number];
  dataDir: string;
  outDir: string;
};

function parseConfig(): AppConfig {
  const parsed = ConfigSchema.parse(process.env);
  const parts = parsed.GOIAS_BBOX.split(',').map(Number);
  const bbox: [number, number, number, number] =
    parts.length === 4 && parts.every((n) => Number.isFinite(n))
      ? [parts[0]!, parts[1]!, parts[2]!, parts[3]!]
      : [-53.25, -19.5, -45.9, -12.39];

  const dataDir = path.resolve(__dirname, '../data');
  // CINDER_OUT_DIR lets tests write elsewhere; the pitch numbers always come from the default out/ folder.
  const outDir = process.env.CINDER_OUT_DIR ? path.resolve(process.env.CINDER_OUT_DIR) : path.resolve(__dirname, '../out');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(outDir, { recursive: true });

  return {
    ...parsed,
    bbox,
    dataDir,
    outDir,
  };
}

export const config: AppConfig = parseConfig();

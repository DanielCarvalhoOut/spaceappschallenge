import pg from 'pg';
import { config } from '../config.js';
import { logger } from '../core/logger.js';

const { Pool } = pg;

let poolInstance: pg.Pool | null = null;
let pgAvailable: boolean | null = null;

export function getPool(): pg.Pool {
  if (!poolInstance) {
    poolInstance = new Pool({
      connectionString: config.DATABASE_URL,
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 1500,
    });
    poolInstance.on('error', (err) => {
      logger.debug({ err: err.message }, 'PostgreSQL pool background error');
    });
  }
  return poolInstance;
}

export async function isPostgresAvailable(): Promise<boolean> {
  if (pgAvailable !== null) return pgAvailable;
  try {
    const pool = getPool();
    const res = await pool.query('SELECT 1 AS ok');
    pgAvailable = res.rowCount === 1;
  } catch {
    pgAvailable = false;
  }
  return pgAvailable;
}

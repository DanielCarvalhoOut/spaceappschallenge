/**
 * Progress of the background FIRMS history load (job:build-cell-index started by the server when there is no
 * PostGIS history and no cell index yet). Read by /api/meta so the front can show "loading n of N".
 */
export interface HistoryStatus {
  phase: 'idle' | 'building' | 'ready' | 'failed';
  done: number;
  total: number;
  startedAt: string | null;
  error: string | null;
}

export const historyStatus: HistoryStatus = { phase: 'idle', done: 0, total: 0, startedAt: null, error: null };

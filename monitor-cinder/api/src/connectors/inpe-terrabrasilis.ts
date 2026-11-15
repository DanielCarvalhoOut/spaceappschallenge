import { logger } from '../core/logger.js';
import type { SourceConnector } from '../core/types.js';

export interface TerraBrasilisQuery {
  layer: 'prodes' | 'deter';
  bbox: [number, number, number, number];
}

export interface TerraBrasilisRecord {
  layer: 'prodes' | 'deter';
  year: number;
  areaKm2: number;
  municipalityName?: string;
}

export class InpeTerraBrasilisConnector implements SourceConnector<TerraBrasilisQuery, TerraBrasilisRecord> {
  public readonly id = 'inpe_terrabrasilis' as const;
  public readonly license = 'INPE — TerraBrasilis PRODES & DETER Cerrado (OGC WFS Público)';

  public async *fetch(query: TerraBrasilisQuery, signal: AbortSignal): AsyncIterable<TerraBrasilisRecord> {
    const typeName =
      query.layer === 'prodes' ? 'prodes-cerrado-nb:yearly_deforestation' : 'deter-cerrado-nb:deter_cerrado';
    const bboxStr = `${query.bbox.join(',')},EPSG:4326`;
    const url = `https://terrabrasilis.dpi.inpe.br/geoserver/ows?service=WFS&version=2.0.0&request=GetFeature&typeNames=${typeName}&outputFormat=application/json&count=200&bbox=${bboxStr}`;
    logger.info({ source: this.id, layer: query.layer }, 'Fetching INPE TerraBrasilis WFS');
    const res = await fetch(url, { signal, headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`TerraBrasilis WFS HTTP ${res.status}`);
    const json = (await res.json()) as { features?: Array<{ properties?: Record<string, unknown> }> };
    for (const f of json.features ?? []) {
      const p = f.properties ?? {};
      const year = Number(p['year'] ?? p['ano'] ?? 2024);
      const areaKm2 = Number(p['area_km'] ?? p['areakm'] ?? p['area_km2'] ?? 0);
      if (Number.isFinite(year) && Number.isFinite(areaKm2)) {
        yield {
          layer: query.layer,
          year,
          areaKm2,
          municipalityName: typeof p['municipio'] === 'string' ? p['municipio'] : undefined,
        };
      }
    }
  }
}

export const inpeTerraBrasilisConnector = new InpeTerraBrasilisConnector();

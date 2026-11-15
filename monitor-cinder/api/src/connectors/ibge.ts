import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { config } from '../config.js';
import { logger } from '../core/logger.js';
import type { SourceConnector } from '../core/types.js';

export interface IbgeMunicipalityRecord {
  ibgeCode: string;
  name: string;
  microregion: string;
  intermediateRegion: string;
  centroidLat: number;
  centroidLon: number;
  bbox: [number, number, number, number]; // [west, south, east, north]
  geometry: {
    type: 'Polygon' | 'MultiPolygon';
    coordinates: unknown;
  };
}

const MeshFeatureSchema = z.object({
  type: z.literal('Feature'),
  properties: z.object({
    codarea: z.union([z.string(), z.number()]).transform((v) => String(v)),
  }),
  geometry: z.object({
    type: z.enum(['Polygon', 'MultiPolygon']),
    coordinates: z.array(z.unknown()),
  }),
});

const MeshCollectionSchema = z.object({
  type: z.literal('FeatureCollection'),
  features: z.array(MeshFeatureSchema),
});

function computeBboxAndCentroid(geom: { type: 'Polygon' | 'MultiPolygon'; coordinates: unknown }): {
  bbox: [number, number, number, number];
  centroidLat: number;
  centroidLon: number;
} {
  let minLon = 180;
  let maxLon = -180;
  let minLat = 90;
  let maxLat = -90;
  let sumLon = 0;
  let sumLat = 0;
  let count = 0;

  const visitRing = (ring: unknown) => {
    if (!Array.isArray(ring)) return;
    for (const pt of ring) {
      if (Array.isArray(pt) && typeof pt[0] === 'number' && typeof pt[1] === 'number') {
        const lon = pt[0];
        const lat = pt[1];
        if (lon < minLon) minLon = lon;
        if (lon > maxLon) maxLon = lon;
        if (lat < minLat) minLat = lat;
        if (lat > maxLat) maxLat = lat;
        sumLon += lon;
        sumLat += lat;
        count++;
      }
    }
  };

  if (geom.type === 'Polygon' && Array.isArray(geom.coordinates)) {
    for (const ring of geom.coordinates) visitRing(ring);
  } else if (geom.type === 'MultiPolygon' && Array.isArray(geom.coordinates)) {
    for (const poly of geom.coordinates) {
      if (Array.isArray(poly)) {
        for (const ring of poly) visitRing(ring);
      }
    }
  }

  if (count === 0) {
    return { bbox: [-50.5, -17.0, -49.0, -16.0], centroidLat: -16.68, centroidLon: -49.25 };
  }

  return {
    bbox: [minLon, minLat, maxLon, maxLat],
    centroidLat: Math.round((sumLat / count) * 10000) / 10000,
    centroidLon: Math.round((sumLon / count) * 10000) / 10000,
  };
}

/**
 * Point-in-polygon check (ray casting) for assigning FIRMS hotspots to municipalities.
 */
export function pointInMunicipality(
  lat: number,
  lon: number,
  muni: Pick<IbgeMunicipalityRecord, 'bbox' | 'geometry'>
): boolean {
  const [west, south, east, north] = muni.bbox;
  if (lon < west || lon > east || lat < south || lat > north) return false;

  const inRing = (ring: number[][]): boolean => {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i]![0]!;
      const yi = ring[i]![1]!;
      const xj = ring[j]![0]!;
      const yj = ring[j]![1]!;
      const intersect = yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi + 1e-12) + xi;
      if (intersect) inside = !inside;
    }
    return inside;
  };

  const inPolygon = (rings: number[][][]): boolean => {
    if (!rings.length || !inRing(rings[0]!)) return false;
    for (let k = 1; k < rings.length; k++) {
      if (inRing(rings[k]!)) return false;
    }
    return true;
  };

  if (muni.geometry.type === 'Polygon') {
    return inPolygon(muni.geometry.coordinates as number[][][]);
  }
  const polys = muni.geometry.coordinates as number[][][][];
  for (const poly of polys) {
    if (inPolygon(poly)) return true;
  }
  return false;
}

export class IbgeConnector implements SourceConnector<{ uf: string }, IbgeMunicipalityRecord> {
  public readonly id = 'ibge' as const;
  public readonly license = 'IBGE — Malha Municipal Digital e API de Localidades (Domínio Público / CC-BY)';
  private cachedMeshJson: unknown | null = null;
  private cachedMunicipalities: Map<string, IbgeMunicipalityRecord> | null = null;

  public async *fetch(query: { uf: string }, signal: AbortSignal): AsyncIterable<IbgeMunicipalityRecord> {
    const map = await this.loadMunicipalities(query.uf, signal);
    for (const m of map.values()) {
      yield m;
    }
  }

  public async getMeshFeatureCollection(uf = '52'): Promise<unknown> {
    if (this.cachedMeshJson) return this.cachedMeshJson;
    await this.loadMunicipalities(uf);
    return this.cachedMeshJson;
  }

  public async loadMunicipalities(
    uf = '52',
    signal?: AbortSignal
  ): Promise<Map<string, IbgeMunicipalityRecord>> {
    if (this.cachedMunicipalities) return this.cachedMunicipalities;

    const cacheFile = path.join(config.dataDir, `ibge_uf_${uf}.json`);
    if (fs.existsSync(cacheFile)) {
      try {
        const raw = JSON.parse(fs.readFileSync(cacheFile, 'utf8')) as {
          mesh: unknown;
          items: IbgeMunicipalityRecord[];
        };
        if (raw && Array.isArray(raw.items) && raw.items.length > 0) {
          this.cachedMeshJson = raw.mesh;
          this.cachedMunicipalities = new Map(raw.items.map((it) => [it.ibgeCode, it]));
          return this.cachedMunicipalities;
        }
      } catch {
        // Re-fetch below
      }
    }

    const meshUrl = `https://servicodados.ibge.gov.br/api/v3/malhas/estados/${uf}?intrarregiao=municipio&formato=application/vnd.geo+json&qualidade=minima`;
    const namesUrl = `https://servicodados.ibge.gov.br/api/v1/localidades/estados/${uf}/municipios?view=nivelado`;

    logger.info({ uf }, 'Fetching IBGE municipal mesh and names');
    const [meshRes, namesRes] = await Promise.all([
      fetch(meshUrl, { signal, headers: { Accept: 'application/json' } }),
      fetch(namesUrl, { signal, headers: { Accept: 'application/json' } }),
    ]);

    if (!meshRes.ok || !namesRes.ok) {
      throw new Error(`IBGE HTTP error: mesh=${meshRes.status}, names=${namesRes.status}`);
    }

    const meshRaw: unknown = await meshRes.json();
    const namesRaw: unknown = await namesRes.json();
    const parsedMesh = MeshCollectionSchema.parse(meshRaw);

    const namesMap = new Map<string, { name: string; micro: string; inter: string }>();
    if (Array.isArray(namesRaw)) {
      for (const item of namesRaw) {
        if (item && typeof item === 'object') {
          const rec = item as Record<string, unknown>;
          const id = String(rec['municipio-id'] ?? rec['id'] ?? '');
          const name = String(rec['municipio-nome'] ?? rec['nome'] ?? id);
          const micro = String(rec['microrregiao-nome'] ?? '');
          const inter = String(rec['regiao-intermediaria-nome'] ?? '');
          if (/^\d{7}$/.test(id)) {
            namesMap.set(id, { name, micro, inter });
          }
        }
      }
    }

    const items: IbgeMunicipalityRecord[] = [];
    for (const feat of parsedMesh.features) {
      const code = feat.properties.codarea;
      if (!/^\d{7}$/.test(code)) continue;
      const info = namesMap.get(code) ?? { name: code, micro: '', inter: '' };
      const { bbox, centroidLat, centroidLon } = computeBboxAndCentroid(feat.geometry);
      items.push({
        ibgeCode: code,
        name: info.name,
        microregion: info.micro,
        intermediateRegion: info.inter,
        centroidLat,
        centroidLon,
        bbox,
        geometry: feat.geometry,
      });
    }

    this.cachedMeshJson = parsedMesh;
    this.cachedMunicipalities = new Map(items.map((it) => [it.ibgeCode, it]));

    try {
      fs.writeFileSync(cacheFile, JSON.stringify({ mesh: parsedMesh, items }), 'utf8');
    } catch {
      // Ignore write error if read-only
    }

    return this.cachedMunicipalities;
  }
}

export const ibgeConnector = new IbgeConnector();

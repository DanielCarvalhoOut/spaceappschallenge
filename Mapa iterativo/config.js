/*
 * Monitor Cinder front-end configuration.
 * If you change apiBase, also add the same origin to connect-src in index.html (Content-Security-Policy).
 * Never put keys here: the FIRMS MAP_KEY lives only in the backend .env.
 */
window.CINDER_CONFIG = Object.freeze({
  apiBase: 'http://localhost:8787',
  uf: '52',
  ufName: 'Goiás',
  bbox: Object.freeze({ west: -53.3, south: -19.55, east: -45.85, north: -12.35 }), // same box the API validates
  ibgeMeshUrl: 'https://servicodados.ibge.gov.br/api/v3/malhas/estados/52?intrarregiao=municipio&formato=application/vnd.geo+json&qualidade=minima',
  ibgeBrazilMeshUrl: 'https://servicodados.ibge.gov.br/api/v3/malhas/paises/BR?intrarregiao=UF&formato=application/vnd.geo+json&qualidade=minima',
  ibgeNamesUrl: 'https://servicodados.ibge.gov.br/api/v1/localidades/estados/52/municipios?view=nivelado',
  firstYear: 2001,
  lastYear: 2025,
  defaultYear: 2024,
  defaultMonth: 9,
  requestTimeoutMs: 20000,
  apiProbeTimeoutMs: 20000,
});

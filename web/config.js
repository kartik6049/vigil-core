// Deployment settings. The Pages workflow rewrites API_BASE from the repository variable API_BASE_URL.
export const CONFIG = {
  API_BASE: 'http://localhost:3000',
  // India boundary GeoJSON, served from this site. See web/data/README.md for where to get it.
  INDIA_GEOJSON: 'data/india.geojson',
};

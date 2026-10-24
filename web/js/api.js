import { CONFIG } from '../config.js';

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** Thin fetch wrapper: adds the bearer token, unwraps { error: { code, message } }, signs out on 401. */
export function createApi({ getToken, onUnauthorized }) {
  async function request(method, path, body) {
    const headers = { Accept: 'application/json' };
    const token = getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    let res;
    try {
      res = await fetch(CONFIG.API_BASE + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new ApiError(0, 'network_error', 'Cannot reach the API. Free hosting sleeps when idle, so try again in a minute.');
    }
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      if (res.status === 401 && path !== '/auth/login') onUnauthorized();
      throw new ApiError(res.status, data?.error?.code ?? 'error', data?.error?.message ?? res.statusText);
    }
    return data;
  }

  return {
    get: (path) => request('GET', path),
    post: (path, body = {}) => request('POST', path, body),
    patch: (path, body) => request('PATCH', path, body),
  };
}

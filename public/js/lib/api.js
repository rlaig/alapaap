'use strict';

const Api = (() => {
  let token = null;

  function setToken(t) { token = t; }
  function getToken() { return token; }
  function clearToken() { token = null; }

  async function request(method, url, body = null) {
    const opts = {
      method,
      headers: { 'Content-Type': 'application/json' },
    };
    if (token) {
      opts.headers['Authorization'] = `Bearer ${token}`;
    }
    if (body) {
      opts.body = JSON.stringify(body);
    }

    const res = await fetch(url, opts);
    const data = await res.json().catch(() => null);

    if (res.status === 401) {
      clearToken();
      if (typeof App !== 'undefined') App.showLogin();
      throw new Error('Session expired');
    }

    if (!res.ok) {
      throw new Error(data?.error || `HTTP ${res.status}`);
    }

    return data;
  }

  return {
    setToken,
    getToken,
    clearToken,
    get: (url) => request('GET', url),
    post: (url, body) => request('POST', url, body),
    put: (url, body) => request('PUT', url, body),
    patch: (url, body) => request('PATCH', url, body),
    delete: (url, body) => request('DELETE', url, body),
  };
})();

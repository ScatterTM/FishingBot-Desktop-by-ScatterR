'use strict';

// Calls the local admin API the same way the old desktop app did: log in with the
// admin password, keep the session cookie, then call the action. Origin must match
// the host, so it is sent explicitly (Node's fetch does not send it by default).

class AdminClient {
  constructor(server) {
    this.server = server;
  }

  async request(pathname, body, cookie = '') {
    const headers = { 'Content-Type': 'application/json', Origin: this.server.base };
    if (cookie) headers.Cookie = cookie;
    let res;
    try {
      res = await fetch(this.server.base + pathname, {
        method: 'POST',
        headers,
        body: JSON.stringify(body || {}),
        signal: AbortSignal.timeout(15000),
      });
    } catch {
      throw new Error('The server is not running. Start it from the hub first.');
    }
    let data = {};
    try {
      data = await res.json();
    } catch {
      /* not JSON */
    }
    const cookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    return {
      ok: res.ok && data.ok !== false,
      status: res.status,
      error: data.error || (res.ok ? '' : `HTTP ${res.status}`),
      body: data,
      cookie: cookies.map((item) => item.split(';')[0]).join('; '),
      setCookies: cookies,
    };
  }

  // Returns { cookie, setCookies }: the header for follow-up calls and the raw Set-Cookie lines.
  async login(password) {
    const reply = await this.request('/local/admin/login', { password });
    if (!reply.ok) throw new Error(reply.error || 'The admin password was not accepted.');
    return { cookie: reply.cookie, setCookies: reply.setCookies };
  }

  // First start: creates the admin password and returns the Set-Cookie lines of the new session.
  async setup(password) {
    const reply = await this.request('/local/admin/setup', { password });
    if (!reply.ok) throw new Error(reply.error || 'The admin password could not be created.');
    return reply.setCookies;
  }

  async call(action, body, password) {
    const { cookie } = await this.login(password);
    const reply = await this.request(`/local/admin/${action}`, body, cookie);
    if (!reply.ok) throw new Error(reply.error || 'The server refused the request.');
    return reply.body;
  }
}

module.exports = { AdminClient };

// Request/response compatibility helpers for the local server. The api/ handlers
// use req.query, req.body,
// res.status().json(), res.send(). These helpers add exactly those to Node's
// own request and response objects, so the handlers run unchanged.

const MAX_BODY_BYTES = 20 * 1024 * 1024;

function queryFrom(url) {
  const query = {};
  for (const key of new Set(url.searchParams.keys())) {
    const values = url.searchParams.getAll(key);
    query[key] = values.length > 1 ? values : values[0];
  }
  return query;
}

function readBody(req) {
  if (req.method === 'GET' || req.method === 'HEAD') return Promise.resolve({});
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('Request body too large.'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const type = String(req.headers['content-type'] || '');
      if (!raw) return resolve({});
      if (type.includes('application/json')) {
        try { return resolve(JSON.parse(raw)); } catch (_e) { return resolve({}); }
      }
      if (type.includes('application/x-www-form-urlencoded')) {
        return resolve(Object.fromEntries(new URLSearchParams(raw)));
      }
      return resolve(raw);
    });
    req.on('error', reject);
  });
}

function attachResponse(res) {
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (data) => {
    if (!res.getHeader('Content-Type')) res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(data));
    return res;
  };
  res.send = (body) => {
    if (body === undefined || body === null) {
      res.end();
      return res;
    }
    if (typeof body === 'object' && !Buffer.isBuffer(body)) return res.json(body);
    const text = String(body);
    if (!res.getHeader('Content-Type')) {
      const isHtml = text.trimStart().startsWith('<');
      res.setHeader('Content-Type', isHtml ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8');
    }
    res.end(text);
    return res;
  };
  res.redirect = (location, code = 302) => {
    res.statusCode = code;
    res.setHeader('Location', location);
    res.end();
    return res;
  };
  return res;
}

// Adds req.query and req.body, and the response helpers, then returns req/res.
export async function prepareApiRequest(req, res, url, extraQuery = {}) {
  req.query = { ...queryFrom(url), ...extraQuery };
  req.body = await readBody(req);
  attachResponse(res);
  return { req, res };
}

export function sendPlain(res, status, text) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.end(text);
}

export function sendHtml(res, status, html) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(html);
}

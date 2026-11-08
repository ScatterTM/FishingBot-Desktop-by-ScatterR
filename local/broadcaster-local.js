// Runs the broadcaster tools for the streamer who operates this PC. The request comes from the
// Control Centre, which is protected by the local admin session. The connected Twitch channel is
// the only channel it can manage, so the separate broadcaster website sign-in is not used here.
import { API } from './routes.js';
import { LOCAL_OWNER } from '../lib/broadcaster-admin.js';

export async function runLocalBroadcasterAction({ method, body, channel }) {
  const handler = API['broadcaster-tools'];
  const login = String(channel || '').trim().toLowerCase();
  if (!login) return { status: 409, body: { ok: false, error: 'Connect the streamer Twitch account first.' } };

  const req = { method, body: body || {}, headers: {}, query: {}, cookies: {} };
  req[LOCAL_OWNER] = login;

  let status = 500;
  let payload = { ok: false, error: 'The broadcaster tools did not respond.' };
  const res = {
    [LOCAL_OWNER]: true,
    status(code) { status = code; return res; },
    json(value) { payload = value; return res; },
    end() { return res; },
    setHeader() { return res; }
  };
  await handler(req, res);
  return { status, body: payload.error ? { ok: false, ...payload } : { ok: true, ...payload } };
}

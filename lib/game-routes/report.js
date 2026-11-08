import { getSessionUser } from '../session.js';

// "Report a problem" and "Submit an idea" are both emailed to the Fishing Hub
// inbox. Nothing is written to the database. The optional PNG only travels as an
// email attachment and is never kept on the website. Contents are not logged.
// The rate limit lives in server memory and stores no personal data.
const REPORT_TO = 'fishingsyshub@gmail.com';
const MAX_TITLE = 100;
const MAX_DESCRIPTION = 2000;
const MAX_PNG_BYTES = 2 * 1024 * 1024;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const PER_HOUR = 5;
const HOUR_MS = 60 * 60 * 1000;
const recentSubmissions = new Map();

const KINDS = {
  report: { label: 'Problem report', subject: 'report' },
  idea: { label: 'Idea', subject: 'idea' }
};

function clientKey(req) {
  const forwarded = String(req.headers?.['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || req.socket?.remoteAddress || 'unknown';
}

// Reports and ideas each have their own hourly allowance per visitor.
function overLimit(key) {
  const now = Date.now();
  if (recentSubmissions.size > 5000) {
    for (const [k, entry] of recentSubmissions) if (entry.resetAt <= now) recentSubmissions.delete(k);
  }
  const entry = recentSubmissions.get(key);
  if (!entry || entry.resetAt <= now) {
    recentSubmissions.set(key, { count: 1, resetAt: now + HOUR_MS });
    return false;
  }
  if (entry.count >= PER_HOUR) return true;
  entry.count += 1;
  return false;
}

// Returns { bytes } for a valid PNG, { bytes: null } when none was sent, or { error }.
function readPng(value) {
  if (value === undefined || value === null || value === '') return { bytes: null };
  const raw = String(value).replace(/^data:image\/png;base64,/, '');
  const bytes = Buffer.from(raw, 'base64');
  const pngError = { error: 'The screenshot must be a PNG file up to 2 MB.' };
  if (!bytes.length || bytes.length > MAX_PNG_BYTES) return pngError;
  if (!PNG_SIGNATURE.every((b, i) => bytes[i] === b)) return pngError;
  return { bytes };
}

export async function reportHandler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed.' });

  const body = req.body || {};
  const kind = body.kind === 'idea' ? 'idea' : 'report';
  const { label, subject } = KINDS[kind];

  if (overLimit(`${kind}:${clientKey(req)}`)) {
    return res.status(429).json({ error: `You have sent several ${subject}s recently. Please try again later.` });
  }

  const title = String(body.title ?? '').replace(/\s+/g, ' ').trim();
  const description = String(body.description ?? '').replace(/\r\n/g, '\n').trim();
  if (!title || title.length > MAX_TITLE) {
    return res.status(400).json({ error: 'Enter a title (up to 100 characters).' });
  }
  if (!description || description.length > MAX_DESCRIPTION) {
    return res.status(400).json({ error: 'Enter a description (up to 2000 characters).' });
  }

  const png = readPng(body.png);
  if (png.error) return res.status(400).json({ error: png.error });

  const anonymous = body.anonymous === true;
  const sessionUser = getSessionUser(req);
  const login = sessionUser?.login ? String(sessionUser.login).replace(/^@/, '') : '';
  const sender = anonymous ? 'Anonymous' : (login ? `@${login}` : 'Not logged in');

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.error('[Feedback] RESEND_API_KEY is not set; nothing was sent.');
    return res.status(503).json({ error: 'Reports are not set up yet. Please try again later.' });
  }
  const from = process.env.REPORT_FROM_EMAIL || 'Fishing Hub Reports <onboarding@resend.dev>';

  const sentAt = new Date();
  const text = [
    `Sent: ${sentAt.toUTCString()} (${sentAt.toISOString()})`,
    `Type: ${label}`,
    `Sent by: ${sender}`,
    '',
    'Title:',
    title,
    '',
    'Description:',
    description,
    '',
    png.bytes ? 'Screenshot: attached as screenshot.png' : 'Screenshot: none'
  ].join('\n');

  const payload = {
    from,
    to: [REPORT_TO],
    subject: `[Fishing Hub ${subject}] ${title.slice(0, MAX_TITLE)}`,
    text
  };
  if (png.bytes) payload.attachments = [{ filename: 'screenshot.png', content: png.bytes.toString('base64') }];

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15000)
    });
    if (!response.ok) {
      console.error(`[Feedback] the email provider refused the ${subject} (HTTP ${response.status}).`);
      return res.status(502).json({ error: 'It could not be sent. Please try again later.' });
    }
  } catch (error) {
    console.error('[Feedback] the email provider could not be reached:', error?.name || 'error');
    return res.status(502).json({ error: 'It could not be sent. Please try again later.' });
  }

  return res.status(200).json({
    success: true,
    message: kind === 'idea' ? 'Thanks, your idea was sent.' : 'Thanks, your report was sent.'
  });
}

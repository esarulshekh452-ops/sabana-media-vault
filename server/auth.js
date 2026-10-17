import crypto from 'node:crypto';

const COOKIE_NAME = 'sg_media_session';
const SESSION_SECONDS = 4 * 60 * 60;

function timingSafeTextEqual(a, b) {
  const left = Buffer.from(String(a ?? ''));
  const right = Buffer.from(String(b ?? ''));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function sessionSecret() {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error('SESSION_SECRET is missing or too short. Set a random secret of at least 32 characters.');
  }
  return secret;
}

function signature(payload) {
  return crypto.createHmac('sha256', sessionSecret()).update(payload).digest('base64url');
}

export function verifyAdminPassword(candidate) {
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected || expected.length < 12) {
    throw new Error('ADMIN_PASSWORD is missing or too short. Set an admin password of at least 12 characters.');
  }
  return timingSafeTextEqual(candidate, expected);
}

export function createSession() {
  const now = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(JSON.stringify({ iat: now, exp: now + SESSION_SECONDS, nonce: crypto.randomBytes(12).toString('hex') })).toString('base64url');
  return `${payload}.${signature(payload)}`;
}

export function getSessionCookie(token, secure = true) {
  const securePart = secure ? '; Secure' : '';
  return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_SECONDS}${securePart}`;
}

export function clearSessionCookie(secure = true) {
  const securePart = secure ? '; Secure' : '';
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${securePart}`;
}

function readCookie(req, name) {
  const header = req.headers?.cookie || '';
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim();
  }
  return '';
}

export function isAuthenticated(req) {
  try {
    const authorization = String(req.headers?.authorization || req.headers?.Authorization || '');
    const bearer = authorization.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() || '';
    const token = bearer || readCookie(req, COOKIE_NAME);
    const [payload, providedSignature, extra] = token.split('.');
    if (!payload || !providedSignature || extra) return false;
    const expectedSignature = signature(payload);
    if (!timingSafeTextEqual(providedSignature, expectedSignature)) return false;
    const session = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    const now = Math.floor(Date.now() / 1000);
    return Number.isFinite(session.exp) && session.exp > now && session.iat <= now + 60;
  } catch {
    return false;
  }
}

export function requirePost(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ error: 'Method not allowed.' });
    return false;
  }
  return true;
}

export function requireGet(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    res.status(405).json({ error: 'Method not allowed.' });
    return false;
  }
  return true;
}

export function requireSession(req, res) {
  if (!isAuthenticated(req)) {
    res.status(401).json({ error: 'Session expired. Please sign in again.' });
    return false;
  }
  return true;
}

export function isSecureRequest(req) {
  return req.headers?.['x-forwarded-proto'] === 'https' || process.env.NODE_ENV === 'production';
}

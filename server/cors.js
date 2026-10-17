const DEFAULT_ORIGINS = [
  'https://sabana-gold.web.app',
  'https://sabana-gold.firebaseapp.com',
  'https://sabanagold.in',
  'https://www.sabanagold.in',
  'https://sabana-media-vault.vercel.app',
  'https://sabanagold.com',
  'https://www.sabanagold.com',
  'https://sabanagold.vercel.app'
];

function getAllowedOrigins() {
  const configured = String(process.env.ADMIN_ORIGINS || '')
    .split(',').map((origin) => origin.trim()).filter(Boolean);
  return new Set([...DEFAULT_ORIGINS, ...configured]);
}

export function applyCors(req, res) {
  const origin = String(req.headers?.origin || '');
  const allowed = Boolean(origin) && getAllowedOrigins().has(origin);
  if (allowed) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Max-Age', '86400');
    res.setHeader('Vary', 'Origin');
  }
  if (req.method === 'OPTIONS') {
    if (!allowed) {
      res.status(403).end();
      return true;
    }
    res.status(204).end();
    return true;
  }
  return false;
}

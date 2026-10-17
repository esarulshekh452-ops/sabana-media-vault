import { isAuthenticated, requireGet } from '../server/auth.js';
import { applyCors } from '../server/cors.js';

export default function handler(req, res) {
  if (applyCors(req, res)) return;
  if (!requireGet(req, res)) return;
  if (!isAuthenticated(req)) return res.status(401).json({ error: 'Session expired. Please sign in again.' });
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({
    ok: true,
    github_configured: Boolean(process.env.GITHUB_TOKEN),
    upload_provider: 'github-only',
    max_photo_bytes: 4 * 1024 * 1024
  });
}

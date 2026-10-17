import { clearSessionCookie, isSecureRequest, requirePost } from '../server/auth.js';
import { applyCors } from '../server/cors.js';

export default function handler(req, res) {
  if (applyCors(req, res)) return;
  if (!requirePost(req, res)) return;
  res.setHeader('Set-Cookie', clearSessionCookie(isSecureRequest(req)));
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({ ok: true });
}

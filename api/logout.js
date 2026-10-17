import { clearSessionCookie, isSecureRequest, requirePost } from '../server/auth.js';

export default function handler(req, res) {
  if (!requirePost(req, res)) return;
  res.setHeader('Set-Cookie', clearSessionCookie(isSecureRequest(req)));
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({ ok: true });
}

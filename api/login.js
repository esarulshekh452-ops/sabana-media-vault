import { createSession, getSessionCookie, isSecureRequest, requirePost, verifyAdminPassword } from '../server/auth.js';

export default function handler(req, res) {
  if (!requirePost(req, res)) return;
  try {
    const password = req.body?.password;
    if (!verifyAdminPassword(password)) {
      res.status(401).json({ error: 'Incorrect admin password.' });
      return;
    }
    res.setHeader('Set-Cookie', getSessionCookie(createSession(), isSecureRequest(req)));
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({ ok: true, message: 'Signed in.' });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Could not sign in.' });
  }
}

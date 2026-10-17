import { createSession, getSessionCookie, isSecureRequest, requirePost, verifyAdminPassword } from '../server/auth.js';
import { applyCors } from '../server/cors.js';

export default function handler(req, res) {
  if (applyCors(req, res)) return;
  if (!requirePost(req, res)) return;
  try {
    const password = req.body?.password;
    if (!verifyAdminPassword(password)) {
      res.status(401).json({ error: 'Incorrect admin password.' });
      return;
    }
    const sessionToken = createSession();
    res.setHeader('Set-Cookie', getSessionCookie(sessionToken, isSecureRequest(req)));
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({ ok: true, sessionToken, message: 'Signed in.' });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Could not sign in.' });
  }
}

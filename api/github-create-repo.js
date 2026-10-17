import { isAuthenticated, requirePost } from '../server/auth.js';
import { createRepository } from '../server/github.js';
import { applyCors } from '../server/cors.js';

export default async function handler(req, res) {
  if (applyCors(req, res)) return;
  if (!requirePost(req, res)) return;
  if (!isAuthenticated(req)) return res.status(401).json({ error: 'Session expired. Please sign in again.' });
  try {
    const repo = await createRepository({
      name: req.body?.name,
      description: req.body?.description,
      isPrivate: req.body?.visibility === 'private'
    });
    return res.status(201).json({ ok: true, repo, message: 'Repository created.' });
  } catch (error) {
    return res.status(error.status || 500).json({ error: error.message || 'Could not create repository.' });
  }
}

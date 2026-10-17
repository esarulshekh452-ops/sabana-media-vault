// api/github-delete.js
import { isAuthenticated, requirePost } from '../server/auth.js';
import { getGitHubUser } from '../server/github.js';
import { applyCors } from '../server/cors.js';

const IMAGE_EXT = /\.(jpe?g|png|webp|gif|avif)$/i;
const SAFE_PART = /^[A-Za-z0-9_.-]+$/;

const redact = (message) =>
  String(message || '').replace(/(gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, '[redacted token]');

function gh(path, options = {}) {
  return fetch(`https://api.github.com${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'sabana-media-vault',
      ...(options.headers || {})
    }
  });
}

export default async function handler(req, res) {
  if (applyCors(req, res)) return;
  if (!requirePost(req, res)) return;
  if (!isAuthenticated(req)) return res.status(401).json({ error: 'Session expired. Please sign in again.' });
  res.setHeader('Cache-Control', 'no-store');
  if (!process.env.GITHUB_TOKEN) return res.status(500).json({ error: 'GitHub is not configured on Vercel.' });

  const repo = String(req.body?.repo || '').trim();
  const branch = String(req.body?.branch || 'main').trim() || 'main';
  const path = String(req.body?.path || '').trim();

  // ---- strict input validation ----
  const parts = repo.split('/');
  if (parts.length !== 2 || !parts.every((p) => SAFE_PART.test(p))) {
    return res.status(400).json({ error: 'Invalid repository.' });
  }
  if (!/^[A-Za-z0-9_./-]{1,200}$/.test(branch) || branch.includes('..')) {
    return res.status(400).json({ error: 'Invalid branch.' });
  }
  const segs = path.split('/');
  if (
    !path || path.length > 300 || segs.length < 2 ||
    segs.some((s) => !s || s === '.' || s === '..' || !SAFE_PART.test(s)) ||
    !IMAGE_EXT.test(path)
  ) {
    return res.status(400).json({ error: 'Invalid image path.' });
  }

  try {
    // Only repositories owned by the connected GitHub account can be changed.
    const user = await getGitHubUser();
    if (String(user?.login || '').toLowerCase() !== parts[0].toLowerCase()) {
      return res.status(403).json({ error: 'Only repositories owned by the connected GitHub account can be changed.' });
    }

    const repoPath = parts.map(encodeURIComponent).join('/');
    const url = `/repos/${repoPath}/contents/${segs.map(encodeURIComponent).join('/')}`;

    // Need the file's sha to delete it.
    const found = await gh(`${url}?ref=${encodeURIComponent(branch)}`);
    if (found.status === 404) {
      // Already gone: report success so the admin list can clean itself up.
      return res.status(200).json({ ok: true, already_deleted: true, path });
    }
    if (!found.ok) {
      const j = await found.json().catch(() => ({}));
      return res.status(found.status).json({ error: redact(j.message) || 'Could not read the image on GitHub.' });
    }
    const meta = await found.json();
    if (Array.isArray(meta) || meta.type !== 'file' || !meta.sha) {
      return res.status(400).json({ error: 'That path is not a file.' });
    }

    const del = await gh(url, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: `Delete product image ${path}`, sha: meta.sha, branch })
    });
    if (!del.ok) {
      const j = await del.json().catch(() => ({}));
      return res.status(del.status).json({
        error: del.status === 409
          ? 'GitHub reported a conflict. Refresh the library and try again.'
          : redact(j.message) || 'GitHub refused the delete.'
      });
    }
    return res.status(200).json({ ok: true, path, message: 'Image deleted from GitHub.' });
  } catch (error) {
    return res.status(error.status || 500).json({ error: redact(error.message) || 'Could not delete the image.' });
  }
}

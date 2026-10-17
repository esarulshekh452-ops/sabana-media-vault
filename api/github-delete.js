// api/github-delete.js
import { isAuthenticated, requirePost } from '../server/auth.js';
import { getGitHubUser } from '../server/github.js';
import { applyCors } from '../server/cors.js';

const IMAGE_EXT = /\.(jpe?g|png|webp|gif|avif)$/i;
const SAFE_PART = /^[A-Za-z0-9_.-]+$/;
const TOKEN_PATTERN = /(gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})/g;

const redact = (message) =>
  String(message || '').replace(TOKEN_PATTERN, '[redacted token]');

async function githubRequest(path, options = {}) {
  return fetch(`https://api.github.com${path}`, {
    ...options,
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'sabana-media-vault',
      ...(options.headers || {}),
      // Keep server credentials authoritative; callers cannot override this header.
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`
    }
  });
}

async function responseMessage(response, fallback) {
  const body = await response.json().catch(() => ({}));
  return redact(body?.message) || fallback;
}

function validBranch(branch) {
  return Boolean(
    branch &&
    branch.length <= 200 &&
    /^[A-Za-z0-9_./-]+$/.test(branch) &&
    !branch.startsWith('/') &&
    !branch.endsWith('/') &&
    !branch.includes('//') &&
    !branch.includes('..') &&
    !branch.includes('@{') &&
    !branch.split('/').some((part) => !part || part.startsWith('.') || part.endsWith('.lock'))
  );
}

function validateRequest(body) {
  const repo = String(body?.repo || '').trim();
  const branch = String(body?.branch || 'main').trim() || 'main';
  const path = String(body?.path || '').trim();
  const repoParts = repo.split('/');

  if (repoParts.length !== 2 || !repoParts.every((part) => SAFE_PART.test(part))) {
    return { error: 'Invalid repository.' };
  }
  if (!validBranch(branch)) {
    return { error: 'Invalid branch name.' };
  }

  const segments = path.split('/');
  if (
    !path ||
    path.length > 300 ||
    segments.length < 2 ||
    segments.some((part) => !part || part === '.' || part === '..' || !SAFE_PART.test(part)) ||
    !IMAGE_EXT.test(path)
  ) {
    return { error: 'Invalid image path.' };
  }

  return { repo, branch, path, owner: repoParts[0], segments };
}

async function verifyRepositoryAndBranch(repoPath, branch) {
  const repoResponse = await githubRequest(`/repos/${repoPath}`);
  if (!repoResponse.ok) {
    return {
      ok: false,
      status: repoResponse.status,
      error: await responseMessage(repoResponse, 'Could not verify the GitHub repository.')
    };
  }

  const branchResponse = await githubRequest(
    `/repos/${repoPath}/branches/${encodeURIComponent(branch)}`
  );
  if (!branchResponse.ok) {
    return {
      ok: false,
      status: branchResponse.status,
      error: await responseMessage(branchResponse, 'The selected branch could not be found.')
    };
  }
  return { ok: true };
}

export default async function handler(req, res) {
  if (applyCors(req, res)) return;
  if (!requirePost(req, res)) return;

  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  if (!isAuthenticated(req)) {
    return res.status(401).json({ error: 'Session expired. Please sign in again.' });
  }
  if (!process.env.GITHUB_TOKEN) {
    return res.status(500).json({ error: 'GitHub is not configured on Vercel.' });
  }

  const input = validateRequest(req.body);
  if (input.error) return res.status(400).json({ error: input.error });

  const { repo, branch, path, owner, segments } = input;

  try {
    // Restrict destructive operations to repositories owned by the configured GitHub account.
    const user = await getGitHubUser();
    if (!user?.login) {
      return res.status(502).json({ error: 'Could not verify the configured GitHub account.' });
    }
    if (String(user.login).toLowerCase() !== owner.toLowerCase()) {
      return res.status(403).json({
        error: 'Only repositories owned by the connected GitHub account can be changed.'
      });
    }

    const repoPath = repo.split('/').map(encodeURIComponent).join('/');
    const contentsPath = `/repos/${repoPath}/contents/${segments.map(encodeURIComponent).join('/')}`;
    const found = await githubRequest(`${contentsPath}?ref=${encodeURIComponent(branch)}`);

    if (found.status === 404) {
      // A Contents API 404 can also mean a wrong repo/branch or missing permissions.
      // Verify the repository and branch before reporting that a file was already deleted.
      const verified = await verifyRepositoryAndBranch(repoPath, branch);
      if (!verified.ok) {
        const status = verified.status === 404 ? 404 : (verified.status || 502);
        return res.status(status).json({ error: verified.error });
      }
      return res.status(200).json({ ok: true, already_deleted: true, path });
    }

    if (!found.ok) {
      return res.status(found.status).json({
        error: await responseMessage(found, 'Could not read the image on GitHub.')
      });
    }

    const meta = await found.json().catch(() => null);
    if (!meta || Array.isArray(meta) || meta.type !== 'file' || !meta.sha) {
      return res.status(400).json({ error: 'That path is not a valid image file.' });
    }

    const deleted = await githubRequest(contentsPath, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: `Delete product image ${path}`,
        sha: meta.sha,
        branch
      })
    });

    if (deleted.status === 404) {
      // A concurrent delete may have removed the file between GET and DELETE.
      const verified = await verifyRepositoryAndBranch(repoPath, branch);
      if (verified.ok) {
        return res.status(200).json({ ok: true, already_deleted: true, path });
      }
      return res.status(verified.status || 502).json({ error: verified.error });
    }

    if (!deleted.ok) {
      const fallback = deleted.status === 409 || deleted.status === 422
        ? 'GitHub reported a conflict. Refresh the library and try again.'
        : 'GitHub refused to delete this image.';
      return res.status(deleted.status).json({
        error: await responseMessage(deleted, fallback)
      });
    }

    return res.status(200).json({ ok: true, path, message: 'Image deleted from GitHub.' });
  } catch (error) {
    const status = Number(error?.status);
    const safeStatus = Number.isInteger(status) && status >= 400 && status <= 599 ? status : 500;
    return res.status(safeStatus).json({
      error: redact(error?.message) || 'Could not delete the image.'
    });
  }
}

const API_BASE = 'https://api.github.com';

export class GitHubError extends Error {
  constructor(message, status = 500, details = '') {
    super(message);
    this.name = 'GitHubError';
    this.status = status;
    this.details = details;
  }
}

function getToken() {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new GitHubError('GitHub is not configured. Add GITHUB_TOKEN in Vercel Environment Variables.', 503);
  return token;
}

export async function githubRequest(path, options = {}) {
  const token = getToken();
  let response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      ...options,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'Sabana-Media-Vault',
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...options.headers
      }
    });
  } catch {
    throw new GitHubError('Could not reach GitHub. Check the network and try again.', 502);
  }

  const raw = await response.text();
  let data = {};
  try { data = raw ? JSON.parse(raw) : {}; } catch { data = { message: raw }; }
  if (!response.ok) {
    const safeMessage = data?.message || `GitHub returned HTTP ${response.status}.`;
    let hint = '';
    if (response.status === 401) hint = ' Check that GITHUB_TOKEN is valid and has not expired.';
    if (response.status === 403) hint = ' Check token permissions, organization policy, and GitHub API rate limits.';
    if (response.status === 404) hint = ' Check that the repository exists and the token can access it.';
    if (response.status === 422) hint = ' Check the repository name or destination path; that path may already exist.';
    throw new GitHubError(`${safeMessage}${hint}`, response.status, data?.errors ? JSON.stringify(data.errors) : '');
  }
  return { data, headers: response.headers };
}

export async function getGitHubUser() {
  const { data } = await githubRequest('/user');
  return data;
}

export async function listOwnedRepositories() {
  const repos = [];
  const maxPages = 20;
  let complete = true;
  for (let page = 1; page <= maxPages; page += 1) {
    const { data } = await githubRequest(`/user/repos?visibility=all&affiliation=owner&sort=updated&per_page=100&page=${page}`);
    if (!Array.isArray(data)) throw new GitHubError('GitHub returned an unexpected repository list.', 502);
    repos.push(...data);
    if (data.length < 100) return { repos, complete };
  }
  complete = false;
  return { repos, complete };
}

export function summarizeRepository(repo) {
  return {
    id: repo.id,
    name: repo.name,
    full_name: repo.full_name,
    private: Boolean(repo.private),
    size_kb: Number(repo.size) || 0,
    default_branch: repo.default_branch || 'main',
    html_url: repo.html_url,
    updated_at: repo.updated_at || null,
    description: repo.description || ''
  };
}

export function sanitizePathSegment(value, fallback = 'photo') {
  const normalized = String(value || '')
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}._ -]/gu, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 100);
  return normalized || fallback;
}

export function sanitizeFolder(value) {
  const raw = String(value || 'uploads').replace(/\\/g, '/');
  const segments = raw.split('/').map((part) => part.trim()).filter(Boolean);
  if (segments.length > 8 || segments.some((part) => part === '.' || part === '..')) {
    throw new GitHubError('Invalid folder path. Use a simple folder such as products or products/rings.', 400);
  }
  return segments.map((part) => sanitizePathSegment(part, 'uploads')).join('/') || 'uploads';
}

export async function createRepository({ name, description = '', isPrivate = false }) {
  const safeName = String(name || '').trim();
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(safeName) || safeName === '.' || safeName === '..') {
    throw new GitHubError('Repository name must be 1–100 characters using letters, numbers, dots, underscores, or hyphens.', 400);
  }
  const { data } = await githubRequest('/user/repos', {
    method: 'POST',
    body: JSON.stringify({
      name: safeName,
      description: String(description || '').slice(0, 350),
      private: Boolean(isPrivate),
      auto_init: true
    })
  });
  return summarizeRepository(data);
}

export async function uploadToRepository({ repoFullName, branch, path, buffer, contentType, commitMessage }) {
  const parts = String(repoFullName || '').split('/');
  if (parts.length !== 2 || parts.some((part) => !/^[A-Za-z0-9_.-]+$/.test(part))) {
    throw new GitHubError('Please select a valid GitHub repository.', 400);
  }
  const repoPath = parts.map(encodeURIComponent).join('/');
  const { data: repo } = await githubRequest(`/repos/${repoPath}`);
  const chosenBranch = String(branch || repo.default_branch || 'main');
  if (!/^[A-Za-z0-9_./-]{1,200}$/.test(chosenBranch) || chosenBranch.includes('..')) {
    throw new GitHubError('Invalid branch name.', 400);
  }
  const encodedPath = path.split('/').map(encodeURIComponent).join('/');
  const body = {
    message: String(commitMessage || `Add image ${path}`).slice(0, 500),
    content: buffer.toString('base64'),
    branch: chosenBranch
  };
  const { data: result } = await githubRequest(`/repos/${repoPath}/contents/${encodedPath}`, {
    method: 'PUT',
    body: JSON.stringify(body)
  });
  const rawUrl = `https://raw.githubusercontent.com/${repo.full_name}/${encodeURIComponent(chosenBranch)}/${path.split('/').map(encodeURIComponent).join('/')}`;
  return {
    repo: summarizeRepository(repo),
    branch: chosenBranch,
    path,
    html_url: result.content?.html_url || `${repo.html_url}/blob/${encodeURIComponent(chosenBranch)}/${encodedPath}`,
    raw_url: rawUrl,
    commit_sha: result.commit?.sha || null
  };
}

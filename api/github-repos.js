import { isAuthenticated, requireGet } from '../server/auth.js';
import { getGitHubUser, listOwnedRepositories, summarizeRepository } from '../server/github.js';

export default async function handler(req, res) {
  if (!requireGet(req, res)) return;
  if (!isAuthenticated(req)) return res.status(401).json({ error: 'Session expired. Please sign in again.' });
  res.setHeader('Cache-Control', 'no-store');
  try {
    const [{ repos, complete }, user] = await Promise.all([listOwnedRepositories(), getGitHubUser()]);
    const list = repos.map(summarizeRepository).sort((a, b) => b.updated_at?.localeCompare(a.updated_at || '') || a.full_name.localeCompare(b.full_name));
    const totalKb = list.reduce((sum, repo) => sum + (Number(repo.size_kb) || 0), 0);
    return res.status(200).json({
      ok: true,
      user: { login: user.login, avatar_url: user.avatar_url, html_url: user.html_url },
      repos: list,
      repo_count: list.length,
      approximate_total_size_kb: totalKb,
      complete,
      note: complete ? 'GitHub repository size fields are approximate and are not an account storage quota.' : 'Only the first 2,000 repositories were included in this estimate; the sum is partial.'
    });
  } catch (error) {
    return res.status(error.status || 500).json({ error: error.message || 'Could not load GitHub repositories.' });
  }
}

import formidable from 'formidable';
import { readFile, unlink } from 'node:fs/promises';
import { requireSession } from '../server/auth.js';
import { githubRequest, sanitizeFolder, sanitizePathSegment, uploadToRepository } from '../server/github.js';
import { applyCors } from '../server/cors.js';

export const config = { api: { bodyParser: false, responseLimit: false } };
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif']);

function first(value) { return Array.isArray(value) ? value[0] : value; }
function publicError(error) {
  const message = String(error?.message || 'GitHub upload failed.');
  return message.replace(/(gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, '[redacted token]');
}

export default async function handler(req, res) {
  if (applyCors(req, res)) return;
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed.' });
  }
  if (!requireSession(req, res)) return;
  res.setHeader('Cache-Control', 'no-store');
  const contentTypeHeader = String(req.headers['content-type'] || '');
  if (!contentTypeHeader.toLowerCase().startsWith('multipart/form-data')) {
    return res.status(400).json({ error: 'Send the photo as multipart/form-data.' });
  }

  let parsedFiles = [];
  try {
    const form = formidable({
      maxFileSize: MAX_FILE_BYTES,
      maxTotalFileSize: MAX_FILE_BYTES,
      maxFiles: 1,
      allowEmptyFiles: false,
      minFileSize: 1,
      multiples: false,
      keepExtensions: true,
      uploadDir: '/tmp'
    });
    const [fields, files] = await form.parse(req);
    parsedFiles = Object.values(files).flat();
    const file = parsedFiles[0];
    if (!file) return res.status(400).json({ error: 'No photo was received.' });
    if ((file.size || 0) > MAX_FILE_BYTES) {
      return res.status(413).json({ error: 'Photo is too large. Keep the compressed output below 4 MB.' });
    }
    const contentType = String(file.mimetype || 'application/octet-stream').toLowerCase();
    if (!ALLOWED_MIME.has(contentType)) {
      return res.status(415).json({ error: 'Unsupported image type. Please upload JPG, PNG, WebP, GIF, or AVIF.' });
    }

    // This endpoint is GitHub-only. Do not use Firebase as a fallback under any condition.
    const requestedProvider = String(first(fields.provider) || 'github').toLowerCase();
    if (requestedProvider !== 'github') {
      return res.status(400).json({ error: 'This uploader supports GitHub repositories only.' });
    }
    const repoFullName = String(first(fields.repo) || '').trim();
    const parts = repoFullName.split('/');
    if (parts.length !== 2 || parts.some((part) => !/^[A-Za-z0-9_.-]+$/.test(part))) {
      return res.status(400).json({ error: 'Choose a valid GitHub repository in owner/repository format.' });
    }

    const buffer = await readFile(file.filepath);
    const repoPath = parts.map(encodeURIComponent).join('/');
    const { data: repoMetadata } = await githubRequest(`/repos/${repoPath}`);
    if (repoMetadata.private) {
      return res.status(409).json({ error: 'Choose a public GitHub repository. Private repository links will not load for customers on Sabana Gold.' });
    }

    const folder = sanitizeFolder(first(fields.folder));
    const original = sanitizePathSegment(file.originalFilename || 'photo.jpg', 'photo.jpg');
    const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
    const unique = Math.random().toString(16).slice(2, 10);
    const path = `${folder}/${timestamp}-${unique}-${original}`;
    const branch = String(first(fields.branch) || '').trim();

    const uploaded = await uploadToRepository({
      repoFullName,
      branch,
      path,
      buffer,
      contentType,
      commitMessage: `Add product image ${path}`
    });

    // Defensive guard in case repository visibility changes during the request.
    if (uploaded.repo.private) {
      return res.status(409).json({ error: 'The selected repository is private. Use a public repository for product photos.' });
    }
    return res.status(200).json({
      ok: true,
      provider: 'github',
      url: uploaded.raw_url,
      raw_url: uploaded.raw_url,
      github_url: uploaded.html_url,
      path: uploaded.path,
      repository: uploaded.repo.full_name,
      repository_private: false,
      branch: uploaded.branch,
      size_bytes: buffer.length,
      message: 'Uploaded to GitHub. The raw image URL is public and ready to use on your website.'
    });
  } catch (error) {
    const message = publicError(error);
    const status = error?.httpCode === 413 || /maxFileSize|maxTotalFileSize|exceeded|too large/i.test(message)
      ? 413
      : (Number(error?.status) >= 400 && Number(error?.status) < 600 ? Number(error.status) : 500);
    return res.status(status).json({ error: message });
  } finally {
    await Promise.all(parsedFiles.map((file) => unlink(file.filepath).catch(() => {})));
  }
}

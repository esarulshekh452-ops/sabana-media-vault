import formidable from 'formidable';
import { readFile, unlink } from 'node:fs/promises';
import { requireSession } from '../server/auth.js';
import { GitHubError, sanitizeFolder, sanitizePathSegment, uploadToRepository } from '../server/github.js';
import { uploadToFirebase } from '../server/firebase.js';

export const config = { api: { bodyParser: false, responseLimit: false } };
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif']);

function first(value) { return Array.isArray(value) ? value[0] : value; }
function publicError(error) {
  const message = String(error?.message || 'Upload failed.');
  return message.replace(/(gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, '[redacted token]');
}

export default async function handler(req, res) {
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
    if ((file.size || 0) > MAX_FILE_BYTES) return res.status(413).json({ error: 'Photo is too large. Keep each photo under 4 MB because of the Vercel function upload limit.' });
    const contentType = String(file.mimetype || 'application/octet-stream').toLowerCase();
    if (!ALLOWED_MIME.has(contentType)) return res.status(415).json({ error: 'Unsupported file type. Upload JPG, PNG, WebP, GIF, or AVIF images.' });
    const buffer = await readFile(file.filepath);
    const name = sanitizePathSegment(file.originalFilename || 'photo', 'photo');
    const folder = sanitizeFolder(first(fields.folder));
    const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
    const unique = Math.random().toString(16).slice(2, 10);
    const path = `${folder}/${timestamp}-${unique}-${name}`;
    const repoFullName = String(first(fields.repo) || '').trim();
    const branch = String(first(fields.branch) || '').trim();
    const requestedProvider = String(first(fields.provider) || 'github');
    const requirePublicLink = String(first(fields.requirePublicLink) ?? 'true') !== 'false';

    let githubResult = null;
    let githubFailure = null;
    try {
      if (requestedProvider === 'firebase') throw new GitHubError('Firebase Storage was selected as the upload destination.', 400);
      if (!repoFullName) throw new GitHubError('Choose a GitHub repository first.', 400);
      githubResult = await uploadToRepository({
        repoFullName,
        branch,
        path,
        buffer,
        contentType,
        commitMessage: `Add image ${path}`
      });
    } catch (error) {
      githubFailure = error;
    }

    if (githubResult && !githubResult.repo.private) {
      return res.status(200).json({
        ok: true,
        provider: 'github',
        url: githubResult.raw_url,
        github_url: githubResult.html_url,
        raw_url: githubResult.raw_url,
        path: githubResult.path,
        repository: githubResult.repo.full_name,
        repository_private: false,
        branch: githubResult.branch,
        size_bytes: buffer.length,
        message: 'Uploaded to GitHub. The raw image URL is public and can be used on your website.'
      });
    }

    if (githubResult?.repo.private) {
      if (requirePublicLink) {
        try {
          const fb = await uploadToFirebase({ filePath: path, file, buffer, contentType });
          return res.status(200).json({
            ok: true,
            provider: 'github+firebase',
            url: fb.url,
            firebase_url: fb.url,
            github_url: githubResult.html_url,
            raw_url: githubResult.raw_url,
            path: githubResult.path,
            repository: githubResult.repo.full_name,
            repository_private: true,
            branch: githubResult.branch,
            size_bytes: buffer.length,
            fallback: true,
            message: 'Saved to your private GitHub repository. A public Firebase copy was created because private GitHub image URLs will not load for ordinary store visitors.'
          });
        } catch (firebaseError) {
          return res.status(200).json({
            ok: true,
            provider: 'github-private',
            url: githubResult.raw_url,
            github_url: githubResult.html_url,
            raw_url: githubResult.raw_url,
            path: githubResult.path,
            repository: githubResult.repo.full_name,
            repository_private: true,
            branch: githubResult.branch,
            size_bytes: buffer.length,
            public_link_warning: publicError(firebaseError),
            message: 'Uploaded to the private GitHub repository, but the image link is not publicly accessible. Configure Firebase fallback or use a public repository.'
          });
        }
      }
      return res.status(200).json({
        ok: true,
        provider: 'github-private',
        url: githubResult.raw_url,
        github_url: githubResult.html_url,
        raw_url: githubResult.raw_url,
        path: githubResult.path,
        repository: githubResult.repo.full_name,
        repository_private: true,
        branch: githubResult.branch,
        size_bytes: buffer.length,
        message: 'Uploaded to private GitHub repository. This image URL requires authorized access and should not be used on a public storefront.'
      });
    }

    try {
      const fb = await uploadToFirebase({ filePath: path, file, buffer, contentType });
      return res.status(200).json({
        ok: true,
        provider: 'firebase-fallback',
        url: fb.url,
        firebase_url: fb.url,
        path: fb.path,
        size_bytes: buffer.length,
        fallback: true,
        github_error: publicError(githubFailure),
        message: `GitHub upload failed, so the photo was saved to Firebase Storage instead. ${publicError(githubFailure)}`
      });
    } catch (firebaseError) {
      const status = githubFailure?.status === 400 ? 400 : 502;
      return res.status(status).json({
        error: `Upload failed on GitHub and Firebase fallback also failed. GitHub: ${publicError(githubFailure)} Firebase: ${publicError(firebaseError)}`,
        github_error: publicError(githubFailure),
        firebase_error: publicError(firebaseError)
      });
    }
  } catch (error) {
    const message = publicError(error);
    const status = error?.httpCode === 413 || /maxFileSize|maxTotalFileSize|exceeded|too large/i.test(message) ? 413 : (error.status || 500);
    return res.status(status).json({ error: status === 413 ? 'Photo is too large. Keep each photo under 4 MB.' : message });
  } finally {
    await Promise.all(parsedFiles.map((file) => unlink(file.filepath).catch(() => {})));
  }
}

import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';

let cachedAppPromise;

function loadServiceAccount() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error('Firebase fallback is not configured: set FIREBASE_SERVICE_ACCOUNT_JSON in Vercel.');
  try {
    const parsed = JSON.parse(raw);
    if (parsed.private_key) parsed.private_key = parsed.private_key.replace(/\\n/g, '\n');
    return parsed;
  } catch {
    throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON. Paste the full service-account JSON as a single environment-variable value.');
  }
}

async function getBucket() {
  const bucketName = process.env.FIREBASE_STORAGE_BUCKET;
  if (!bucketName) throw new Error('Firebase fallback is not configured: set FIREBASE_STORAGE_BUCKET in Vercel.');
  if (!cachedAppPromise) {
    cachedAppPromise = (async () => {
      const [{ getApps, initializeApp, cert }, { getStorage }] = await Promise.all([
        import('firebase-admin/app'), import('firebase-admin/storage')
      ]);
      const serviceAccount = loadServiceAccount();
      const existing = getApps().find((app) => app.name === 'sabana-media-vault');
      const app = existing || initializeApp({ credential: cert(serviceAccount), storageBucket: bucketName }, 'sabana-media-vault');
      return getStorage(app).bucket(bucketName);
    })();
  }
  return cachedAppPromise;
}

export async function uploadToFirebase({ filePath, file, buffer, contentType }) {
  const bucket = await getBucket();
  const token = crypto.randomUUID();
  const safeName = file.originalFilename || 'photo';
  const objectName = `sabana-media-vault/${Date.now()}-${crypto.randomBytes(6).toString('hex')}-${safeName.replace(/[^\w.-]+/g, '-')}`;
  let data = buffer;
  if (!data && file?.filepath) data = await readFile(file.filepath);
  const object = bucket.file(objectName);
  await object.save(data, {
    resumable: false,
    validation: 'crc32c',
    metadata: {
      contentType: contentType || file?.mimetype || 'application/octet-stream',
      cacheControl: 'public, max-age=31536000, immutable',
      metadata: { firebaseStorageDownloadTokens: token, originalFilename: safeName }
    }
  });
  const encodedObject = encodeURIComponent(objectName);
  return {
    provider: 'firebase',
    path: objectName,
    url: `https://firebasestorage.googleapis.com/v0/b/${encodeURIComponent(bucket.name)}/o/${encodedObject}?alt=media&token=${token}`
  };
}

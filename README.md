# Sabana Media Vault

A small Vercel-hosted, password-protected dashboard for Sabana Gold product photos. It can list and create GitHub repositories, upload photos to a selected repository, show a raw image URL after the upload finishes, estimate the combined size of your owned GitHub repositories, and fall back to Firebase Storage if a GitHub upload fails.

## Important behavior

- The GitHub token and Firebase service account are server-side environment variables. They are never included in browser JavaScript.
- GitHub uploads to **public repositories** return a public `raw.githubusercontent.com` image URL.
- If you select a private repository and leave **Need a public website link** checked, the photo is saved to that private GitHub repo and a public Firebase copy is attempted. If Firebase is not configured, the dashboard warns that the private raw link will not work for public store visitors.
- If GitHub upload fails, the API automatically tries Firebase Storage when Firebase is configured.
- You can select **Firebase Storage only** in the destination dropdown to bypass GitHub.
- GitHub repository size fields are approximate. The dashboard sums the `size` values returned by GitHub for repositories owned by the token's account. It is **not** an account-wide storage quota or a hard remaining-space indicator. Git LFS and recent pushes may not be reflected exactly.
- Upload one image at a time through the API, even when several files are queued. Keep each file at or below **4 MB** because Vercel Function request bodies have a roughly 4.5 MB limit, including multipart overhead. Compress large phone images to JPEG/WebP first.
- Supported formats are JPG/JPEG, PNG, WebP, GIF, and AVIF. SVG is deliberately not allowed.

## Deploy to Vercel

1. Upload this folder to a new GitHub repository (for example `sabana-media-vault`) or push it from your computer.
2. Import that repository into Vercel. The project uses the repository root; no build command is required for the static files and API functions.
3. In **Vercel → Project → Settings → Environment Variables**, add the values below for Production (and Preview only if you intend to test there).
4. Redeploy after setting or changing environment variables.
5. Open the deployed site and sign in with `ADMIN_PASSWORD`.

### Required environment variables

- `ADMIN_PASSWORD`: strong, unique password for this dashboard, minimum 12 characters.
- `SESSION_SECRET`: random secret, minimum 32 characters. Generate one with `openssl rand -base64 48` or a password manager.
- `GITHUB_TOKEN`: a token that can list the account's owned repositories, create repositories, and write repository contents. GitHub's fine-grained token is preferred where it can grant the needed access: select the account owner and all repositories you expect to manage, then grant **Metadata: Read-only** and **Contents: Read and write**. Repository creation permissions can depend on account/organization policy; if creating a repository fails, check the token's available permissions and organization rules. A classic token with `repo` scope may work but grants broader access; use the least privilege practical for your account.

### Optional Firebase fallback

Set both variables to enable automatic fallback:

- `FIREBASE_STORAGE_BUCKET`: exact bucket name from Firebase Console → Storage. Depending on the project, it can look like `PROJECT_ID.firebasestorage.app` or `PROJECT_ID.appspot.com`.
- `FIREBASE_SERVICE_ACCOUNT_JSON`: the full JSON key for a service account from the same Firebase/GCP project, pasted as one environment-variable value. Keep it private. Do not commit the JSON file into GitHub.

To create/get the service-account JSON: Firebase Console → Project settings → Service accounts → Generate new private key (button names may differ). Keep the service account protected and grant only the required Storage access for the project. The Firebase Storage bucket must already exist and be enabled. Ensure Firebase/GCP billing and Storage rules/bucket configuration satisfy your project setup.

The app uses the Admin SDK to upload the photo and adds a download token to the stored object's metadata so it can return a direct public download URL. Anybody with that URL can access that image, so only upload assets meant to be public. This tool is not intended for customer documents or private customer images.

## Local development

Install Node.js 20 or later. Then:

```bash
npm install
npx vercel dev
```

Set the environment variables in Vercel's local environment workflow (for example `vercel env pull .env.local`) or your terminal. Do not commit `.env.local`.

## Troubleshooting

- **Incorrect admin password / session error:** check `ADMIN_PASSWORD` and `SESSION_SECRET`, then redeploy.
- **GitHub repositories don't load:** confirm `GITHUB_TOKEN` is valid, not expired, and has repository metadata access. If the page reports `.add is not a function`, deploy the latest app code; the repository dropdown must append options to `<optgroup>` elements. If `/api/status` returns 401, sign in again. If that keeps happening, confirm `SESSION_SECRET` is stable across all deployments/functions and redeploy once after setting it; changing it invalidates existing sessions. If you have more than 2,000 owned repositories, the size figure is marked as partial.
- **Create repository fails:** token permission or organization policy may block repository creation. Check the API error shown in the dashboard.
- **GitHub upload fails:** check token Contents write permission, selected branch, file size, and whether the destination path already exists. Each uploaded filename is timestamped to reduce path collisions.
- **Firebase fallback fails:** confirm both Firebase variables, valid service-account JSON/private key, exact bucket name, billing eligibility, and bucket access.
- **Private GitHub link:** raw GitHub image URLs from private repositories aren't public storefront URLs. Use a public repository or enable Firebase fallback.
- **Files larger than 4 MB:** compress/resize the image, or replace this upload path with a direct-to-storage upload architecture before uploading large files.

## Security checklist

- Never put `GITHUB_TOKEN`, `ADMIN_PASSWORD`, `SESSION_SECRET`, or the Firebase service-account JSON in `public/app.js`, HTML, or any client-side environment variable.
- Protect this Vercel project and keep the admin password unique.
- The admin session is stored in a signed HttpOnly, SameSite=Strict cookie and expires after four hours.
- Enable usage monitoring/budget notifications for Firebase. Notifications do not automatically stop billing.

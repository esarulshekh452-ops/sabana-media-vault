(() => {
  'use strict';

  const MAX_FILE_BYTES = 4 * 1024 * 1024;
  const ALLOWED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif']);
  const ALLOWED_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'avif']);
  const $ = (selector) => document.querySelector(selector);
  const state = {
    repos: [],
    queue: [],
    results: [],
    status: { github_configured: false, firebase_configured: false },
    isUploading: false,
    toastTimer: null
  };

  const loginScreen = $('#loginScreen');
  const dashboard = $('#dashboard');
  const loginForm = $('#loginForm');
  const loginError = $('#loginError');
  const adminPassword = $('#adminPassword');
  const logoutBtn = $('#logoutBtn');
  const repoSelect = $('#repoSelect');
  const fileInput = $('#fileInput');
  const dropzone = $('#dropzone');
  const fileQueue = $('#fileQueue');
  const fileQueueWrap = $('#fileQueueWrap');
  const uploadBtn = $('#uploadBtn');
  const uploadResults = $('#uploadResults');
  const resultsList = $('#resultsList');
  const globalNotice = $('#globalNotice');
  const createRepoModal = $('#createRepoModal');
  const createRepoForm = $('#createRepoForm');

  function escapeText(value) {
    return String(value ?? '');
  }

  async function api(url, options = {}) {
    const response = await fetch(url, {
      credentials: 'same-origin',
      ...options,
      headers: {
        ...(options.body && !(options.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
        ...(options.headers || {})
      }
    });
    const contentType = response.headers.get('content-type') || '';
    const payload = contentType.includes('application/json') ? await response.json() : { error: await response.text() };
    if (!response.ok) {
      if (response.status === 401 && !url.endsWith('/login')) showLogin();
      throw new Error(payload.error || `Request failed (${response.status}).`);
    }
    return payload;
  }

  function showToast(message) {
    const toast = $('#toast');
    toast.textContent = message;
    toast.classList.add('visible');
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => toast.classList.remove('visible'), 2900);
  }

  function showNotice(message, type = 'info') {
    globalNotice.textContent = message;
    globalNotice.className = `notice${type === 'error' ? ' error' : type === 'success' ? ' success' : ''}`;
  }

  function hideNotice() {
    globalNotice.classList.add('hidden');
    globalNotice.textContent = '';
  }

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes < 0) return '—';
    if (bytes < 1024) return `${bytes} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let value = bytes / 1024;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
      value /= 1024;
      unit += 1;
    }
    return `${value.toLocaleString(undefined, { maximumFractionDigits: value >= 10 ? 1 : 2 })} ${units[unit]}`;
  }

  function formatDate(value) {
    if (!value) return 'Not available';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? 'Not available' : date.toLocaleDateString();
  }

  function showLogin() {
    loginScreen.classList.remove('hidden');
    dashboard.classList.add('hidden');
    logoutBtn.classList.add('hidden');
    adminPassword.value = '';
    loginError.textContent = '';
    hideNotice();
  }

  function showDashboard() {
    loginScreen.classList.add('hidden');
    dashboard.classList.remove('hidden');
    logoutBtn.classList.remove('hidden');
  }

  function setConnectionStatus(elementId, textId, ok, message) {
    const dot = $(elementId);
    dot.classList.toggle('status-bad', !ok);
    dot.classList.toggle('status-unknown', false);
    dot.style.background = ok ? '#39a276' : '#d35d57';
    $(textId).textContent = message;
  }

  async function loadDashboard() {
    hideNotice();
    showDashboard();
    $('#githubUserLabel').textContent = 'Loading account…';
    try {
      state.status = await api('/api/status');
      setConnectionStatus('#githubStatusDot', '#githubStatusText', state.status.github_configured, state.status.github_configured ? 'GitHub token configured on server' : 'GITHUB_TOKEN is not configured');
      setConnectionStatus('#firebaseStatusDot', '#firebaseStatusText', state.status.firebase_configured, state.status.firebase_configured ? 'Firebase fallback is configured' : 'Firebase fallback is not configured');
      if (state.status.github_configured) {
        await loadRepositories();
      } else {
        state.repos = [];
        $('#githubUserLabel').textContent = 'GitHub not connected';
        $('#repoCountStat').textContent = '—';
        $('#totalSizeStat').textContent = '—';
        renderRepositorySelect();
        showNotice('GitHub is not configured yet. Add GITHUB_TOKEN in Vercel Environment Variables. Firebase-only uploads will work once Firebase fallback is configured.', 'info');
      }
      if (!state.status.firebase_configured && !state.status.github_configured) {
        showNotice('No upload destination is configured yet. Add GITHUB_TOKEN for GitHub uploads and/or Firebase service-account settings for fallback uploads in Vercel.', 'error');
      }
    } catch (error) {
      if (/sign in again/i.test(error.message)) return;
      showNotice(error.message, 'error');
      $('#githubUserLabel').textContent = 'Connection needs attention';
      renderRepositorySelect();
    }
  }

  async function loadRepositories(selectFullName = '') {
    $('#refreshReposBtn').disabled = true;
    $('#refreshReposBtn').textContent = '↻ Loading repositories…';
    try {
      const data = await api('/api/github-repos');
      state.repos = Array.isArray(data.repos) ? data.repos : [];
      $('#githubUserLabel').textContent = `@${data.user?.login || 'GitHub user'}`;
      $('#repoCountStat').textContent = data.repo_count.toLocaleString();
      $('#totalSizeStat').textContent = formatBytes((data.approximate_total_size_kb || 0) * 1024);
      $('#totalSizeStat').title = data.note || '';
      $('#totalSizeStat').closest('.stat-card').querySelector('.stat-meta').textContent = data.complete ? 'Approximate sum for owned repos' : 'Partial sum — repository list capped';
      renderRepositorySelect(selectFullName);
      if (!data.complete) showNotice(data.note, 'info');
      else if (state.repos.length === 0) showNotice('No owned GitHub repositories were found. Create a public image repository or upload to Firebase Storage.', 'info');
    } catch (error) {
      state.repos = [];
      $('#githubUserLabel').textContent = 'GitHub connection issue';
      $('#repoCountStat').textContent = '—';
      $('#totalSizeStat').textContent = '—';
      renderRepositorySelect();
      showNotice(`Could not load GitHub repositories: ${error.message}`, 'error');
    } finally {
      $('#refreshReposBtn').disabled = false;
      $('#refreshReposBtn').textContent = '↻ Refresh repository list';
    }
  }

  function renderRepositorySelect(selectFullName = '') {
    const previous = selectFullName || repoSelect.value;
    repoSelect.replaceChildren();
    const placeholder = new Option('Choose a GitHub repository…', '');
    repoSelect.add(placeholder);
    if (state.repos.length) {
      const publicGroup = document.createElement('optgroup');
      publicGroup.label = 'PUBLIC REPOSITORIES';
      const privateGroup = document.createElement('optgroup');
      privateGroup.label = 'PRIVATE REPOSITORIES';
      state.repos.forEach((repo) => {
        const option = new Option(`${repo.full_name}  ·  ${formatBytes(repo.size_kb * 1024)}`, repo.full_name);
        option.dataset.private = String(repo.private);
        option.dataset.branch = repo.default_branch || 'main';
        option.dataset.sizeKb = String(repo.size_kb || 0);
        option.dataset.description = repo.description || '';
        (repo.private ? privateGroup : publicGroup).append(option);
      });
      if (publicGroup.children.length) repoSelect.add(publicGroup);
      if (privateGroup.children.length) repoSelect.add(privateGroup);
    }
    const firebaseOption = new Option('Firebase Storage only  ·  no GitHub repo', '__firebase__');
    firebaseOption.disabled = !state.status.firebase_configured;
    repoSelect.add(firebaseOption);
    if (previous && [...repoSelect.options].some((option) => option.value === previous && !option.disabled)) repoSelect.value = previous;
    else if (!state.repos.length && state.status.firebase_configured) repoSelect.value = '__firebase__';
    else repoSelect.value = '';
    updateSelectedRepository();
  }

  function selectedRepo() {
    return state.repos.find((repo) => repo.full_name === repoSelect.value) || null;
  }

  function updateSelectedRepository() {
    const repo = selectedRepo();
    const firebaseOnly = repoSelect.value === '__firebase__';
    $('#repoInfo').classList.toggle('hidden', !repo);
    $('#privateWarning').classList.toggle('hidden', !(repo?.private && $('#publicLinkCheck').checked));
    if (repo) {
      $('#repoVisibility').textContent = repo.private ? 'PRIVATE' : 'PUBLIC';
      $('#repoVisibility').classList.toggle('private', repo.private);
      $('#repoSizeInline').textContent = `~ ${formatBytes(repo.size_kb * 1024)}`;
      $('#repoFullName').textContent = repo.full_name;
      $('#repoDescription').textContent = repo.description || `Default branch: ${repo.default_branch || 'main'}`;
      $('#repoLink').href = repo.html_url;
      $('#branchInput').value = repo.default_branch || 'main';
      $('#branchInput').disabled = false;
      $('#selectedSizeStat').textContent = formatBytes(repo.size_kb * 1024);
      $('#selectedRepoMeta').textContent = repo.private ? 'Private repository · link access restricted' : 'Approximate size in GitHub API';
    } else {
      $('#selectedSizeStat').textContent = firebaseOnly ? 'Firebase' : '—';
      $('#selectedRepoMeta').textContent = firebaseOnly ? 'Uploads go directly to Firebase Storage' : 'Select a repository to view its size';
      $('#branchInput').value = 'main';
      $('#branchInput').disabled = firebaseOnly;
    }
    if (firebaseOnly) $('#queueSummary').textContent = state.queue.length ? `${state.queue.length} photo${state.queue.length === 1 ? '' : 's'} ready · Firebase Storage destination` : 'No photos selected';
    else updateQueueSummary();
  }

  function updateQueueSummary() {
    if (!state.queue.length) {
      $('#queueSummary').textContent = 'No photos selected';
      return;
    }
    const total = state.queue.reduce((sum, item) => sum + item.file.size, 0);
    const oversized = state.queue.filter((item) => item.file.size > MAX_FILE_BYTES).length;
    $('#queueSummary').textContent = oversized ? `${oversized} photo${oversized === 1 ? '' : 's'} over the 4 MB limit` : `${state.queue.length} photo${state.queue.length === 1 ? '' : 's'} · ${formatBytes(total)} total`;
  }

  function looksLikeAllowedImage(file) {
    const ext = file.name.includes('.') ? file.name.split('.').pop().toLowerCase() : '';
    return ALLOWED_TYPES.has(file.type) || (!file.type && ALLOWED_EXTENSIONS.has(ext));
  }

  function addFiles(fileList) {
    if (state.isUploading) return showToast('Wait until the current upload queue finishes.');
    const candidates = Array.from(fileList || []);
    let added = 0;
    for (const file of candidates) {
      if (!looksLikeAllowedImage(file)) {
        showToast(`${file.name}: use JPG, PNG, WebP, GIF or AVIF.`);
        continue;
      }
      if (file.size > MAX_FILE_BYTES) {
        showToast(`${file.name} is over 4 MB. Compress it before uploading through Vercel.`);
        continue;
      }
      if (state.queue.some((item) => item.file.name === file.name && item.file.size === file.size && item.file.lastModified === file.lastModified)) continue;
      state.queue.push({ id: `${Date.now()}-${Math.random().toString(16).slice(2)}`, file, preview: URL.createObjectURL(file) });
      added += 1;
    }
    renderQueue();
    if (added) showToast(`${added} photo${added === 1 ? '' : 's'} added to the queue.`);
    fileInput.value = '';
  }

  function renderQueue() {
    fileQueue.replaceChildren();
    fileQueueWrap.classList.toggle('hidden', !state.queue.length);
    $('#queueCount').textContent = String(state.queue.length);
    for (const item of state.queue) {
      const row = document.createElement('div');
      row.className = 'file-row';
      const image = document.createElement('img');
      image.className = 'file-thumb';
      image.src = item.preview;
      image.alt = '';
      const info = document.createElement('div');
      info.className = 'file-info';
      const name = document.createElement('div');
      name.className = 'file-name';
      name.textContent = item.file.name;
      const meta = document.createElement('div');
      meta.className = 'file-meta';
      meta.textContent = `${formatBytes(item.file.size)} · Image ready`;
      info.append(name, meta);
      const remove = document.createElement('button');
      remove.className = 'remove-file';
      remove.type = 'button';
      remove.textContent = '×';
      remove.setAttribute('aria-label', `Remove ${item.file.name}`);
      remove.disabled = state.isUploading;
      remove.addEventListener('click', () => {
        if (state.isUploading) return;
        state.queue = state.queue.filter((entry) => entry.id !== item.id);
        URL.revokeObjectURL(item.preview);
        renderQueue();
      });
      row.append(image, info, remove);
      fileQueue.append(row);
    }
    uploadBtn.disabled = state.isUploading || state.queue.length === 0;
    uploadBtn.innerHTML = state.isUploading ? '<span>Uploading queue…</span><span aria-hidden="true">◌</span>' : '<span>Upload photos</span><span aria-hidden="true">↑</span>';
    $('#clearQueueBtn').disabled = state.isUploading;
    updateQueueSummary();
  }

  function createResultCard(file) {
    uploadResults.classList.remove('hidden');
    const card = document.createElement('article');
    card.className = 'result-card';
    const top = document.createElement('div');
    top.className = 'result-card-top';
    const fileName = document.createElement('div');
    fileName.className = 'result-file';
    fileName.textContent = file.name;
    fileName.title = file.name;
    const badge = document.createElement('span');
    badge.className = 'result-badge warning';
    badge.textContent = 'QUEUED';
    top.append(fileName, badge);
    const progressTrack = document.createElement('div');
    progressTrack.className = 'progress-track';
    const progressBar = document.createElement('div');
    progressBar.className = 'progress-bar';
    progressTrack.append(progressBar);
    const caption = document.createElement('div');
    caption.className = 'progress-caption';
    const captionLeft = document.createElement('span');
    captionLeft.textContent = 'Waiting to upload';
    const captionRight = document.createElement('span');
    captionRight.textContent = '0%';
    caption.append(captionLeft, captionRight);
    const message = document.createElement('div');
    message.className = 'result-message';
    message.textContent = `${formatBytes(file.size)} · ${file.type || 'Image file'}`;
    const urlRow = document.createElement('div');
    urlRow.className = 'result-url-row hidden';
    const link = document.createElement('a');
    link.className = 'result-url';
    link.href = '#';
    link.target = '_blank';
    link.rel = 'noreferrer';
    link.textContent = 'Image URL will appear here';
    const copy = document.createElement('button');
    copy.className = 'copy-button';
    copy.type = 'button';
    copy.textContent = 'Copy URL';
    copy.addEventListener('click', () => copyText(link.href, 'Image URL copied.'));
    urlRow.append(link, copy);
    card.append(top, progressTrack, caption, message, urlRow);
    resultsList.prepend(card);
    return {
      card, badge, progressBar, captionLeft, captionRight, message, urlRow, link,
      setProgress(value, label) {
        const pct = Math.max(0, Math.min(100, value));
        progressBar.style.width = `${pct}%`;
        captionRight.textContent = `${Math.round(pct)}%`;
        if (label) captionLeft.textContent = label;
      },
      setState(kind, label) {
        badge.className = `result-badge${kind === 'firebase' ? ' firebase' : kind === 'warning' || kind === 'error' ? ' warning' : ''}`;
        badge.textContent = label;
      },
      showUrl(url, provider) {
        urlRow.classList.remove('hidden');
        link.href = url;
        link.textContent = url;
        copy.dataset.provider = provider;
      }
    };
  }

  function uploadFile(item, card) {
    return new Promise((resolve, reject) => {
      const request = new XMLHttpRequest();
      const form = new FormData();
      const destination = repoSelect.value;
      const repo = selectedRepo();
      const provider = destination === '__firebase__' ? 'firebase' : 'github';
      form.append('file', item.file, item.file.name);
      form.append('provider', provider);
      form.append('repo', repo?.full_name || '');
      form.append('branch', $('#branchInput').value.trim() || repo?.default_branch || 'main');
      form.append('folder', $('#folderInput').value.trim() || 'products');
      form.append('requirePublicLink', $('#publicLinkCheck').checked ? 'true' : 'false');
      request.open('POST', '/api/upload');
      request.withCredentials = true;
      request.upload.onprogress = (event) => {
        if (!event.lengthComputable) return;
        const percent = Math.min(93, (event.loaded / event.total) * 93);
        card.setProgress(percent, 'Sending photo securely…');
        if (percent >= 92) card.setProgress(94, 'Photo sent · writing to storage…');
      };
      request.onload = () => {
        let data = {};
        try { data = JSON.parse(request.responseText || '{}'); } catch { data = { error: 'The server returned an unreadable response.' }; }
        if (request.status >= 200 && request.status < 300 && data.ok && data.url) {
          card.setProgress(100, 'Upload complete');
          const privateOnly = data.provider === 'github-private';
          const usedFirebase = String(data.provider || '').includes('firebase');
          card.setState(privateOnly ? 'warning' : usedFirebase ? 'firebase' : 'success', privateOnly ? 'PRIVATE LINK' : usedFirebase ? 'FIREBASE' : 'GITHUB');
          card.message.textContent = data.message || `Saved to ${data.provider}.`;
          card.showUrl(data.url, data.provider);
          if (data.public_link_warning) card.message.textContent += ` Public-link warning: ${data.public_link_warning}`;
          resolve(data);
        } else {
          const message = data.error || `Upload failed (HTTP ${request.status}).`;
          card.setState('error', 'FAILED');
          card.setProgress(0, 'Upload failed');
          card.message.textContent = message;
          reject(new Error(message));
        }
      };
      request.onerror = () => {
        card.setState('error', 'FAILED');
        card.setProgress(0, 'Network error');
        card.message.textContent = 'Network error. Check your connection and retry this photo.';
        reject(new Error('Network error while uploading.'));
      };
      request.onabort = () => reject(new Error('Upload cancelled.'));
      card.setProgress(2, 'Starting secure upload…');
      request.send(form);
    });
  }

  async function processUploads() {
    if (state.isUploading || !state.queue.length) return;
    if (!state.status.github_configured && !state.status.firebase_configured) {
      showToast('Configure GitHub or Firebase Storage in Vercel first.');
      return;
    }
    if (repoSelect.value !== '__firebase__' && !selectedRepo()) {
      showToast('Choose a repository or select Firebase Storage only.');
      return;
    }
    if (selectedRepo()?.private && $('#publicLinkCheck').checked && !state.status.firebase_configured) {
      showNotice('The selected repository is private and Firebase fallback is not configured. The photo can be stored in GitHub, but its raw image URL will not be public for store visitors. Configure Firebase or choose a public repo.', 'error');
    }
    const currentQueue = [...state.queue];
    state.isUploading = true;
    setUploadControlsDisabled(true);
    resultsList.replaceChildren();
    state.results = [];
    uploadResults.classList.remove('hidden');
    try {
      let success = 0;
      for (let index = 0; index < currentQueue.length; index += 1) {
        const item = currentQueue[index];
        const card = createResultCard(item.file);
        card.setState('warning', 'UPLOADING');
        card.setProgress(1, `Photo ${index + 1} of ${currentQueue.length} · preparing…`);
        try {
          const result = await uploadFile(item, card);
          success += 1;
          state.results.push(result);
        } catch (error) {
          showToast(`${item.file.name}: ${error.message}`);
        }
      }
      const failures = currentQueue.length - success;
      showNotice(`${success} of ${currentQueue.length} photo${currentQueue.length === 1 ? '' : 's'} uploaded${failures ? `; ${failures} failed` : ''}. Open each result to copy its link.`, failures ? 'error' : 'success');
      if (success) showToast(`${success} photo${success === 1 ? '' : 's'} uploaded successfully.`);
    } finally {
      state.queue.forEach((item) => URL.revokeObjectURL(item.preview));
      state.queue = [];
      state.isUploading = false;
      setUploadControlsDisabled(false);
      renderQueue();
      updateSelectedRepository();
      fileInput.value = '';
    }
  }

  function setUploadControlsDisabled(disabled) {
    repoSelect.disabled = disabled;
    $('#branchInput').disabled = disabled || repoSelect.value === '__firebase__';
    $('#folderInput').disabled = disabled;
    $('#publicLinkCheck').disabled = disabled;
    $('#createRepoBtn').disabled = disabled;
    $('#refreshReposBtn').disabled = disabled;
    dropzone.classList.toggle('disabled', disabled);
    $('#clearQueueBtn').disabled = disabled;
    renderQueue();
  }

  async function copyText(text, successMessage) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
      } else {
        const helper = document.createElement('textarea');
        helper.value = text;
        helper.style.position = 'fixed';
        helper.style.opacity = '0';
        document.body.append(helper);
        helper.select();
        const ok = document.execCommand('copy');
        helper.remove();
        if (!ok) throw new Error('Copy failed');
      }
      showToast(successMessage || 'Copied to clipboard.');
    } catch {
      showToast('Could not copy automatically. Open the link and copy it from the address bar.');
    }
  }

  function closeCreateRepoModal() {
    createRepoModal.classList.add('hidden');
    $('#createRepoError').textContent = '';
  }

  async function createRepository(event) {
    event.preventDefault();
    const name = $('#newRepoName').value.trim();
    const description = $('#newRepoDescription').value.trim();
    const visibility = $('#newRepoVisibility').value;
    const submit = $('#createRepoSubmit');
    const errorNode = $('#createRepoError');
    errorNode.textContent = '';
    submit.disabled = true;
    submit.textContent = 'Creating…';
    try {
      const data = await api('/api/github-create-repo', {
        method: 'POST',
        body: JSON.stringify({ name, description, visibility })
      });
      closeCreateRepoModal();
      createRepoForm.reset();
      await loadRepositories(data.repo.full_name);
      showNotice(`Repository ${data.repo.full_name} created. ${data.repo.private ? 'It is private; public product links require Firebase fallback.' : 'It is public and ready for website images.'}`, data.repo.private ? 'info' : 'success');
      showToast('Repository created successfully.');
    } catch (error) {
      errorNode.textContent = error.message;
    } finally {
      submit.disabled = false;
      submit.innerHTML = 'Create repository <span aria-hidden="true">→</span>';
    }
  }

  loginForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    loginError.textContent = '';
    const submit = loginForm.querySelector('button[type="submit"]');
    submit.disabled = true;
    submit.textContent = 'Checking…';
    try {
      await api('/api/login', { method: 'POST', body: JSON.stringify({ password: adminPassword.value }) });
      adminPassword.value = '';
      await loadDashboard();
    } catch (error) {
      loginError.textContent = error.message;
    } finally {
      submit.disabled = false;
      submit.innerHTML = '<span>Unlock workspace</span><span aria-hidden="true">→</span>';
    }
  });

  logoutBtn.addEventListener('click', async () => {
    try { await api('/api/logout', { method: 'POST', body: '{}' }); } catch { /* The local screen still locks if the session has already expired. */ }
    showLogin();
    showToast('Signed out.');
  });

  $('#togglePassword').addEventListener('click', () => {
    const isPassword = adminPassword.type === 'password';
    adminPassword.type = isPassword ? 'text' : 'password';
    $('#togglePassword').textContent = isPassword ? 'Hide' : 'Show';
    $('#togglePassword').setAttribute('aria-label', isPassword ? 'Hide password' : 'Show password');
  });

  dropzone.addEventListener('click', () => { if (!state.isUploading) fileInput.click(); });
  dropzone.addEventListener('keydown', (event) => {
    if (!state.isUploading && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); fileInput.click(); }
  });
  fileInput.addEventListener('change', () => addFiles(fileInput.files));
  dropzone.addEventListener('dragover', (event) => { event.preventDefault(); if (!state.isUploading) dropzone.classList.add('dragging'); });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragging'));
  dropzone.addEventListener('drop', (event) => { event.preventDefault(); dropzone.classList.remove('dragging'); if (!state.isUploading) addFiles(event.dataTransfer.files); });
  $('#clearQueueBtn').addEventListener('click', () => {
    if (state.isUploading) return;
    state.queue.forEach((item) => URL.revokeObjectURL(item.preview));
    state.queue = [];
    renderQueue();
  });
  $('#clearResultsBtn').addEventListener('click', () => {
    if (state.isUploading) return;
    resultsList.replaceChildren();
    uploadResults.classList.add('hidden');
    hideNotice();
  });
  uploadBtn.addEventListener('click', processUploads);
  repoSelect.addEventListener('change', updateSelectedRepository);
  $('#publicLinkCheck').addEventListener('change', updateSelectedRepository);
  $('#refreshReposBtn').addEventListener('click', () => loadRepositories(repoSelect.value));
  $('#createRepoBtn').addEventListener('click', () => {
    createRepoModal.classList.remove('hidden');
    $('#newRepoName').focus();
  });
  $('#closeModalBtn').addEventListener('click', closeCreateRepoModal);
  $('#cancelModalBtn').addEventListener('click', closeCreateRepoModal);
  createRepoModal.addEventListener('click', (event) => { if (event.target === createRepoModal) closeCreateRepoModal(); });
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && !createRepoModal.classList.contains('hidden')) closeCreateRepoModal(); });
  createRepoForm.addEventListener('submit', createRepository);

  // The session is stored in a signed, HttpOnly cookie. Check it without keeping secrets in browser storage.
  api('/api/status').then(() => loadDashboard()).catch(() => showLogin());
})();

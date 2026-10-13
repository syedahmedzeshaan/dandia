require('dotenv').config();
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const express = require('express');
const multer = require('multer');
const { google } = require('googleapis');
const { GoogleSheetsStore } = require('./googleSheets');
const { GoogleDriveStore } = require('./googleDrive');

function loadConfig() {
  const required = ['GOOGLE_SERVICE_ACCOUNT_EMAIL', 'GOOGLE_PRIVATE_KEY', 'GOOGLE_SHEETS_SPREADSHEET_ID', 'GOOGLE_SHEETS_WORKSHEET_NAME'];
  const missing = required.filter((key) => !process.env[key]?.trim());
  if (missing.length) throw new Error(`Missing required environment configuration: ${missing.join(', ')}. Copy .env.example to .env and fill in the values.`);
  const size = Number(process.env.MAX_UPLOAD_SIZE_MB || 5);
  if (!Number.isFinite(size) || size <= 0 || size > 25) throw new Error('MAX_UPLOAD_SIZE_MB must be a number greater than 0 and no more than 25.');
  return {
    email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL.trim(),
    privateKey: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n').replace(/^"|"$/g, ''),
    spreadsheetId: process.env.GOOGLE_SHEETS_SPREADSHEET_ID.trim(),
    sheetName: process.env.GOOGLE_SHEETS_WORKSHEET_NAME.trim(),
    folderId: process.env.GOOGLE_DRIVE_FOLDER_ID.trim(),
    driveClientId: (process.env.GOOGLE_DRIVE_OAUTH_CLIENT_ID || '').trim(),
    driveClientSecret: (process.env.GOOGLE_DRIVE_OAUTH_CLIENT_SECRET || '').trim(),
    driveRefreshToken: (process.env.GOOGLE_DRIVE_REFRESH_TOKEN || '').trim(),
    appBaseUrl: (process.env.APP_BASE_URL || '').trim().replace(/\/$/, ''),
    adminUsername: process.env.ADMIN_USERNAME || '',
    adminPassword: process.env.ADMIN_PASSWORD || '',
    driveTokenPath: process.env.GOOGLE_DRIVE_TOKEN_PATH || path.join(__dirname, '..', '.drive-token.json'),
    maxBytes: size * 1024 * 1024,
    port: Number(process.env.PORT || 3000)
  };
}
function protectAdminRoutes(req, res, next) {
  if (req.path === '/api/health') return next();
  if (!process.env.ADMIN_USERNAME || !process.env.ADMIN_PASSWORD) {
    if (process.env.NODE_ENV !== 'production') return next();
    return res.status(503).send('Admin access is not configured. Set ADMIN_USERNAME and ADMIN_PASSWORD.');
  }
  const header = req.headers.authorization || '';
  const [scheme, encoded] = header.split(' ');
  if (scheme === 'Basic' && encoded) {
    let supplied = '';
    try { supplied = Buffer.from(encoded, 'base64').toString('utf8'); } catch (_error) {}
    const separator = supplied.indexOf(':');
    const username = separator < 0 ? '' : supplied.slice(0, separator);
    const password = separator < 0 ? '' : supplied.slice(separator + 1);
    const equal = (a, b) => {
      const left = Buffer.from(a);
      const right = Buffer.from(b);
      return left.length === right.length && crypto.timingSafeEqual(left, right);
    };
    if (equal(username, process.env.ADMIN_USERNAME) && equal(password, process.env.ADMIN_PASSWORD)) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="Dandiya Admin", charset="UTF-8"');
  return res.status(401).send('Sign in with the Dandiya admin credentials.');
}
function identifyImage(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return { mimeType: 'image/jpeg', extension: 'jpg' };
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return { mimeType: 'image/png', extension: 'png' };
  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return { mimeType: 'image/webp', extension: 'webp' };
  return null;
}
function publicRegistration(data) {
  const r = data.registration;
  return { registrationId: r.registrationId, name: r.name, rollNumber: r.rollNumber, branch: r.branch, section: r.section, year: r.year, mobileNumber: r.mobileNumber, timestamp: r.timestamp, utrNumber: r.utrNumber, paymentStatus: r.paymentStatus, paymentUpdatedAt: r.paymentUpdatedAt, screenshotUrl: r.screenshotFileId ? `/api/registrations/${encodeURIComponent(r.registrationId)}/payment-screenshot` : (r.screenshotUrl || '') };
}

async function start() {
  let config;
  try { config = loadConfig(); }
  catch (configurationError) {
    // Keep the interface viewable before Google Sheets settings are supplied.
    const preview = express();
    preview.disable('x-powered-by');
    preview.use(protectAdminRoutes);
    preview.use(express.static(path.join(__dirname, '..', 'public')));
    preview.get('/api/*', (_req, res) => res.status(503).json({ success: false, message: 'Google Sheets is not configured yet. Add its required values to .env and restart the server.' }));
    preview.get('*', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));
    const port = Number(process.env.PORT || 3000);
    preview.listen(port, '0.0.0.0', () => console.log(`MVSREC Dandiya interface preview listening on port ${port} (Google configuration required for live data)`));
    return;
  }
  const sheets = new GoogleSheetsStore(config);
  const driveOAuthReady = Boolean(config.driveClientId && config.driveClientSecret);
  const driveRedirectUri = process.env.GOOGLE_DRIVE_OAUTH_REDIRECT_URI || (config.appBaseUrl ? `${config.appBaseUrl}/auth/google/callback` : `http://localhost:${config.port}/auth/google/callback`);
  const driveOAuth = driveOAuthReady ? new google.auth.OAuth2(config.driveClientId, config.driveClientSecret, driveRedirectUri) : null;
  let driveTokens = null;
  if (config.driveRefreshToken) driveTokens = { refresh_token: config.driveRefreshToken };
  if (!driveTokens && driveOAuthReady && fs.existsSync(config.driveTokenPath)) {
    try { driveTokens = JSON.parse(fs.readFileSync(config.driveTokenPath, 'utf8')); }
    catch (_error) { console.error('Saved Google Drive authorization could not be read; reconnect Drive.'); }
  }
  if (driveTokens?.refresh_token) driveOAuth.setCredentials(driveTokens);
  let drive = driveOAuth && driveTokens?.refresh_token && config.folderId ? new GoogleDriveStore({ auth: driveOAuth, folderId: config.folderId }) : null;
  const pendingOAuthStates = new Set();
  // Read-only by default: startup must never add headers or backfill cells.
  console.log('App ready. Spreadsheet updates occur only when an admin submits UTR and screenshot.');
  const app = express();
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.maxBytes, files: 1, fields: 2 } });
  app.disable('x-powered-by');
  app.use(protectAdminRoutes);
  app.use(express.static(path.join(__dirname, '..', 'public'), { fallthrough: true, etag: true }));
  app.get('/auth/google', (_req, res) => {
    if (!driveOAuth) return res.status(503).send('Google Drive OAuth is not configured. Add the OAuth client ID and secret to .env first.');
    const state = crypto.randomBytes(24).toString('hex');
    pendingOAuthStates.add(state);
    // Request only per-file access. The Picker exposes just the configured
    // Dandiya payments folder, and the callback rejects any other selection.
    const authUrl = new URL(driveOAuth.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      scope: ['https://www.googleapis.com/auth/drive.file'],
      state
    }));
    authUrl.searchParams.set('trigger_onepick', 'true');
    authUrl.searchParams.set('allow_folder_selection', 'true');
    authUrl.searchParams.set('file_ids', config.folderId);
    res.redirect(authUrl.toString());
  });
  app.get('/auth/google/callback', async (req, res) => {
    if (!driveOAuth || typeof req.query.state !== 'string' || !pendingOAuthStates.delete(req.query.state)) return res.status(400).send('Drive authorization could not be validated. Start again from the app.');
    if (req.query.error) return res.status(400).send('Google Drive authorization was cancelled. You can close this tab.');
    const pickedFolderIds = String(req.query.picked_file_ids || '').split(',').filter(Boolean);
    if (pickedFolderIds.length !== 1 || pickedFolderIds[0] !== config.folderId) {
      return res.status(400).send('Select only the configured Dandiya payments folder to connect Drive. No Drive changes were made.');
    }
    try {
      const { tokens } = await driveOAuth.getToken(String(req.query.code || ''));
      const refreshToken = tokens.refresh_token || driveTokens?.refresh_token;
      if (!refreshToken) return res.status(400).send('Google did not return a refresh token. Revoke this app in your Google Account permissions and try connecting again.');
      driveTokens = { refresh_token: refreshToken, scope: tokens.scope, token_type: tokens.token_type };
      if (process.env.NODE_ENV === 'production') {
        // Render's free filesystem is ephemeral. Hand the token to the admin once
        // so it can be placed in the protected service environment instead.
        res.type('html').send(`<!doctype html><meta charset="utf-8"><title>Drive connected</title><main style="font:16px system-ui;max-width:760px;margin:10vh auto"><h1>Google Drive authorized</h1><p>Copy this refresh token into Render as <code>GOOGLE_DRIVE_REFRESH_TOKEN</code>, save the environment change, and redeploy. The token is shown only on this authorized callback page.</p><textarea readonly style="width:100%;height:9em">${refreshToken.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))}</textarea><p>After saving it in Render, remove this value from your clipboard.</p></main>`);
        driveOAuth.setCredentials(driveTokens);
        drive = config.folderId ? new GoogleDriveStore({ auth: driveOAuth, folderId: config.folderId }) : null;
        return;
      }
      fs.writeFileSync(config.driveTokenPath, `${JSON.stringify(driveTokens, null, 2)}\n`, { mode: 0o600 });
      fs.chmodSync(config.driveTokenPath, 0o600);
      driveOAuth.setCredentials(driveTokens);
      drive = config.folderId ? new GoogleDriveStore({ auth: driveOAuth, folderId: config.folderId }) : null;
      res.send('Google Drive connected. You can close this tab and return to the Dandiya admin app.');
    } catch (_error) {
      res.status(502).send('Google Drive authorization failed. Return to the app and try connecting again.');
    }
  });
  app.get('/api/health', (_req, res) => res.json({ success: true, status: 'ok' }));
  app.get('/api/config', (_req, res) => res.json({
    maxUploadSizeMb: config.maxBytes / 1024 / 1024,
    driveConfigured: Boolean(drive),
    driveOAuthReady,
    driveAuthorizationNeeded: Boolean(driveOAuth && !driveTokens?.refresh_token)
  }));
  app.get('/api/registrations/:registrationId', async (req, res, next) => {
    try {
      const found = await sheets.resolveUnique(req.params.registrationId.trim());
      res.json({ success: true, message: 'Registration found.', data: publicRegistration(found) });
    } catch (error) { next(error); }
  });
  app.post('/api/registrations/:registrationId/payment', (req, res, next) => {
    if (!drive) return res.status(503).json({ success: false, message: 'Connect Google Drive first to enable screenshot uploads.' });
    upload.single('screenshot')(req, res, async (uploadError) => {
      if (uploadError) return next(uploadError);
      try {
        const registrationId = req.params.registrationId.trim();
        const utrNumber = String(req.body.utrNumber || '').trim();
        if (!utrNumber) return res.status(400).json({ success: false, message: 'UTR number is required.' });
        if (utrNumber.length > 100) return res.status(400).json({ success: false, message: 'UTR number must be 100 characters or fewer.' });
        if (!req.file) return res.status(400).json({ success: false, message: 'Please select a payment screenshot.' });
        const image = identifyImage(req.file.buffer);
        if (!image) return res.status(415).json({ success: false, message: 'Unsupported image format. Upload a JPEG, PNG, or WebP image.' });
        await sheets.resolveUnique(registrationId);
        const uploaded = await drive.upload({ ...image, buffer: req.file.buffer }, registrationId);
        const saved = await sheets.savePaymentEvidence(registrationId, { utrNumber, screenshotUrl: uploaded.url });
        res.json({ success: true, message: 'UTR and screenshot saved for this Pass No.', data: publicRegistration(saved) });
      } catch (error) {
        if (error.status) return next(error);
        console.error('Could not save payment evidence.');
        return res.status(502).json({ success: false, message: 'Upload could not be saved to the registration. Please retry.' });
      } finally { if (req.file?.buffer) req.file.buffer = null; }
    });
  });
  app.post('/api/registrations/:registrationId/verify-payment', (_req, res) => res.status(403).json({ success: false, message: 'This app only saves the UTR number and screenshot link.' }));
  app.get('/api/registrations/:registrationId/payment-screenshot', async (req, res, next) => {
    try {
      const found = await sheets.resolveUnique(req.params.registrationId.trim());
      if (!found.registration.screenshotFileId) return res.status(404).json({ success: false, message: 'No payment screenshot is saved for this registration.' });
      if (!drive) return res.status(503).json({ success: false, message: 'Screenshot viewing requires Google Drive folder configuration.' });
      await drive.stream(found.registration.screenshotFileId, res);
    } catch (error) { next(error); }
  });
  app.use((error, _req, res, _next) => {
    if (res.headersSent) return res.destroy();
    if (error instanceof multer.MulterError) {
      const message = error.code === 'LIMIT_FILE_SIZE' ? `Image exceeds the ${config.maxBytes / 1024 / 1024} MB maximum file size.` : 'Upload was rejected. Select one image within the file size limit.';
      return res.status(400).json({ success: false, message });
    }
    const status = error.status || 502;
    if (status >= 500) console.error('Request failed while communicating with Google APIs.');
    res.status(status).json({ success: false, message: status === 404 || status === 409 || status === 400 ? error.message : 'Unable to complete the request. Check Google API configuration and try again.' });
  });
  app.listen(config.port, '0.0.0.0', () => console.log(`MVSREC Dandiya admin listening on port ${config.port}`));
}

start().catch((error) => { console.error(`Startup failed: ${error.message}`); process.exitCode = 1; });

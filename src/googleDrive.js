const { google } = require('googleapis');
const { Readable } = require('node:stream');

class GoogleDriveStore {
  constructor({ auth, folderId }) {
    this.folderId = folderId;
    this.api = google.drive({ version: 'v3', auth });
  }
  async upload(file, registrationId) {
    const safeId = registrationId.replace(/[^a-zA-Z0-9_-]/g, '_');
    const name = `${safeId}_payment_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${file.extension}`;
    const { data } = await this.api.files.create({ supportsAllDrives: true, requestBody: { name, parents: [this.folderId], mimeType: file.mimeType }, media: { mimeType: file.mimeType, body: Readable.from(file.buffer) }, fields: 'id,name,webViewLink' });
    return { fileId: data.id, url: data.webViewLink || `https://drive.google.com/file/d/${data.id}/view` };
  }
  async stream(fileId, res) {
    const response = await this.api.files.get({ fileId, alt: 'media', supportsAllDrives: true }, { responseType: 'stream' });
    res.setHeader('Content-Type', response.headers['content-type'] || 'application/octet-stream');
    res.setHeader('Cache-Control', 'private, no-store');
    response.data.on('error', (error) => res.destroy(error));
    response.data.pipe(res);
  }
}
module.exports = { GoogleDriveStore };

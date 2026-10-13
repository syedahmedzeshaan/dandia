const { google } = require('googleapis');

const FIELD_ALIASES = {
  registrationId: ['registration id', 'registrationid', 'pass no', 'passno'],
  timestamp: ['timestamp', 'registration timestamp', 'submitted at'],
  name: ['name', 'full name'],
  rollNumber: ['rollno', 'roll no', 'roll number', 'rollnumber'],
  branch: ['branch'], section: ['section'], year: ['year'],
  mobileNumber: ['mobile no', 'mobile number', 'mobile', 'phone'],
  utrNumber: ['utr number', 'utr'],
  screenshotUrl: ['payment screenshot url', 'screenshot url', 'payment screenshot', 'screenshot / payment drive link', 'payment drive link'],
  screenshotFileId: ['payment screenshot file id', 'screenshot file id'],
  paymentStatus: ['payment status'],
  paymentUpdatedAt: ['payment updated at', 'payment updated']
};
const normalize = (value) => String(value || '').trim().toLowerCase().replace(/[-_]+/g, ' ').replace(/\s+/g, ' ');
function colLetter(index) {
  let n = index + 1, result = '';
  while (n) { const rem = (n - 1) % 26; result = String.fromCharCode(65 + rem) + result; n = Math.floor((n - 1) / 26); }
  return result;
}

class GoogleSheetsStore {
  constructor(config) {
    this.spreadsheetId = config.spreadsheetId;
    this.sheetName = config.sheetName;
    this.auth = new google.auth.JWT({ email: config.email, key: config.privateKey, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
    this.api = google.sheets({ version: 'v4', auth: this.auth });
  }
  range(a1) { return `'${this.sheetName.replace(/'/g, "''")}'!${a1}`; }
  async getGrid() {
    const { data } = await this.api.spreadsheets.values.get({ spreadsheetId: this.spreadsheetId, range: this.range('A:ZZ'), valueRenderOption: 'FORMATTED_VALUE' });
    const values = data.values || [];
    if (!values.length) throw new Error('The configured worksheet has no header row.');
    const headers = values[0].map((value) => String(value || '').trim());
    return { values, headers, rows: values.slice(1) };
  }
  findColumn(headers, key) {
    const aliases = FIELD_ALIASES[key];
    return headers.findIndex((header) => {
      const normalized = normalize(header);
      if (aliases.includes(normalized)) return true;
      return key === 'rollNumber' && normalized.startsWith('rollno');
    });
  }
  async find(registrationId) {
    const { headers, rows } = await this.getGrid();
    const idCol = this.findColumn(headers, 'registrationId');
    if (idCol < 0) throw new Error('Registration ID column is missing.');
    const matches = [];
    rows.forEach((row, index) => { if (String(row[idCol] || '').trim().toLowerCase() === registrationId.toLowerCase()) matches.push({ row, rowNumber: index + 2 }); });
    if (matches.length > 1) return { duplicate: true };
    if (!matches.length) return null;
    const { row, rowNumber } = matches[0];
    const value = (key) => { const i = this.findColumn(headers, key); return i < 0 ? '' : String(row[i] ?? ''); };
    return { rowNumber, headers, registration: {
      registrationId: value('registrationId'), name: value('name'), rollNumber: value('rollNumber'), branch: value('branch'),
      section: value('section'), year: value('year'), mobileNumber: value('mobileNumber'), timestamp: value('timestamp'),
      utrNumber: value('utrNumber'), screenshotUrl: value('screenshotUrl'), screenshotFileId: value('screenshotFileId'),
      paymentStatus: value('paymentStatus') || 'PENDING', paymentUpdatedAt: value('paymentUpdatedAt')
    } };
  }
  async resolveUnique(registrationId) {
    const result = await this.find(registrationId);
    if (!result) { const error = new Error('No registration found for this ID.'); error.status = 404; throw error; }
    if (result.duplicate) { const error = new Error('Multiple records have this ID. Please resolve the duplicate before proceeding.'); error.status = 409; throw error; }
    return result;
  }
  async savePaymentEvidence(registrationId, { utrNumber, screenshotUrl }) {
    const current = await this.resolveUnique(registrationId);
    const idCol = this.findColumn(current.headers, 'registrationId');
    const utrCol = this.findColumn(current.headers, 'utrNumber');
    const screenshotCol = this.findColumn(current.headers, 'screenshotUrl');
    if (utrCol < 0 || screenshotCol < 0) {
      const error = new Error('The existing UTR or screenshot-link column could not be found. No columns were added.');
      error.status = 409;
      throw error;
    }
    const latest = await this.getGrid();
    const latestIdCol = this.findColumn(latest.headers, 'registrationId');
    const matches = latest.rows.map((row, index) => ({ row, rowNumber: index + 2 }))
      .filter(({ row }) => String(row[latestIdCol] || '').trim().toLowerCase() === registrationId.toLowerCase());
    if (matches.length !== 1) {
      const error = new Error(matches.length ? 'Multiple records have this Pass No. No changes were made.' : 'Registration changed while saving. Search again and retry.');
      error.status = 409;
      throw error;
    }
    const rowNumber = matches[0].rowNumber;
    await this.api.spreadsheets.values.batchUpdate({
      spreadsheetId: this.spreadsheetId,
      requestBody: {
        valueInputOption: 'RAW',
        data: [
          { range: this.range(`${colLetter(utrCol)}${rowNumber}`), values: [[utrNumber]] },
          { range: this.range(`${colLetter(screenshotCol)}${rowNumber}`), values: [[screenshotUrl]] }
        ]
      }
    });
    return this.resolveUnique(registrationId);
  }
}
module.exports = { GoogleSheetsStore };

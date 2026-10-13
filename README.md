# Dandia

Private admin tool for looking up MVSR Dandiya registrations and recording payment evidence.

## What it does

- Looks up a registration by Pass No from the existing Google Sheet.
- Lets an admin enter a UTR and upload a JPEG, PNG, or WebP payment screenshot.
- On form submission, uploads the screenshot to the configured Dandiya Payments Drive folder and updates only the existing UTR and screenshot-link cells for that registration.
- Does not create or modify spreadsheet columns, Pass Nos, or other registration details. Payment verification is not available in this app.

## Run locally

Requirements: Node.js 18 or newer and npm.

```sh
npm install
cp .env.example .env
# Fill in the Google settings in .env.
npm start
```

Open <http://localhost:3000>.

## Google configuration

Enable Google Sheets API for the service-account project and Google Drive API for the OAuth client project. Configure these values in `.env`:

- `GOOGLE_SERVICE_ACCOUNT_EMAIL` and `GOOGLE_PRIVATE_KEY`: service account used to read the spreadsheet and save the payment fields.
- `GOOGLE_SHEETS_SPREADSHEET_ID` and `GOOGLE_SHEETS_WORKSHEET_NAME`: existing spreadsheet and worksheet.
- `GOOGLE_DRIVE_FOLDER_ID`: existing Dandiya Payments folder ID.
- `GOOGLE_DRIVE_OAUTH_CLIENT_ID` and `GOOGLE_DRIVE_OAUTH_CLIENT_SECRET`: OAuth web client credentials.
- `PORT`: local server port, default `3000`.

The Drive connection requests the `drive.file` scope and uses Google Picker to authorize the configured folder. The app's Drive upload path is limited to that folder. OAuth tokens are stored locally in `.drive-token.json` with owner-only permissions.

Keep `.env` and `.drive-token.json` private. They are excluded by `.gitignore`; do not commit credentials or payment screenshots.

## Data behavior

The server reads spreadsheet data for lookups. It writes only when an admin submits the UTR and screenshot form, and only to the existing UTR and screenshot-link cells on the matching row. It never edits Pass Nos or other registration fields. Google Drive uploads are made by the app on that same form submission; the agent does not submit payments or alter Drive files.

The server binds to `127.0.0.1` by default, so it is local-only. Public hosting requires a backend host, secure secrets, and authentication for administrators. GitHub Pages alone cannot run this backend.

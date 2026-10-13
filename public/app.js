const $ = (selector) => document.querySelector(selector);
const searchForm = $('#search-form');
const paymentForm = $('#payment-form');
let activeId = '';
let uploadLimit = 5;
$('#drive-connect').hidden = true;
$('#verify-button').disabled = true;

async function api(url, options = {}) {
  const response = await fetch(url, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.success) throw new Error(body.message || 'Unable to complete the request. Please try again.');
  return body;
}
function notice(message, kind = '') { const item = $('#notice'); item.textContent = message; item.dataset.kind = kind; }
function fill(data) {
  activeId = data.registrationId;
  $('#student-name').textContent = data.name || 'Registration';
  $('#registration-badge').textContent = data.registrationId;
  $('#record-pass-no').textContent = data.registrationId || '—';
  $('#roll-number').textContent = data.rollNumber || '—'; $('#branch').textContent = data.branch || '—';
  $('#section').textContent = data.section || '—'; $('#year').textContent = data.year || '—';
  $('#mobile-number').textContent = data.mobileNumber || '—'; $('#timestamp').textContent = data.timestamp || '—';
  $('#utr-number').value = data.utrNumber || '';
  const status = data.paymentStatus || 'PENDING';
  $('#status-badge').textContent = status; $('#status-badge').dataset.status = status;
  const saved = Boolean(data.utrNumber || data.screenshotUrl);
  $('#existing-payment').hidden = !saved;
  $('#saved-utr').textContent = data.utrNumber || '—';
  $('#screenshot-link').hidden = !data.screenshotUrl;
  $('#screenshot-link').href = data.screenshotUrl || '#';
  $('#verify-box').hidden = !(saved && status !== 'VERIFIED');
  $('#verify-box').hidden = true;
  $('#record').hidden = false;
}
searchForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const id = $('#registration-id').value.trim();
  if (!id) return;
  const button = $('#search-button'); button.disabled = true; button.textContent = 'Searching…';
  $('#record').hidden = true; notice('Looking up registration…');
  try { const result = await api(`/api/registrations/${encodeURIComponent(id)}`); fill(result.data); notice(result.message, 'success'); }
  catch (error) { notice(error.message, 'error'); }
  finally { button.disabled = false; button.textContent = 'Search'; }
});
paymentForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const file = $('#screenshot').files[0];
  const utr = $('#utr-number').value.trim();
  if (!utr) return notice('UTR number is required.', 'error');
  if (!file) return notice('Please select a payment screenshot.', 'error');
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) return notice('Unsupported image format. Upload a JPEG, PNG, or WebP image.', 'error');
  if (file.size > uploadLimit * 1024 * 1024) return notice(`Image exceeds the ${uploadLimit} MB maximum file size.`, 'error');
  if (!window.confirm(`Save payment details for ${activeId} — ${$('#student-name').textContent}?`)) return;
  const button = $('#save-button'); button.disabled = true; button.textContent = 'Saving…'; notice('Uploading screenshot and saving payment…');
  const body = new FormData(); body.append('utrNumber', utr); body.append('screenshot', file);
  try { const result = await api(`/api/registrations/${encodeURIComponent(activeId)}/payment`, { method: 'POST', body }); fill(result.data); $('#screenshot').value = ''; notice(result.message, 'success'); }
  catch (error) { notice(error.message, 'error'); }
  finally { button.disabled = false; button.textContent = 'Save payment details'; }
});
$('#verify-button').addEventListener('click', async () => {
  if (!activeId || !window.confirm(`Mark payment for ${activeId} as verified? Confirm you have checked the payment evidence.`)) return;
  const button = $('#verify-button'); button.disabled = true; button.textContent = 'Verifying…'; notice('Updating payment status…');
  try { const result = await api(`/api/registrations/${encodeURIComponent(activeId)}/verify-payment`, { method: 'POST' }); fill(result.data); notice(result.message, 'success'); }
  catch (error) { notice(error.message, 'error'); }
  finally { button.disabled = false; button.textContent = 'Mark payment as verified'; }
});

if (location.protocol !== 'file:') {
  // Keep the free Render service awake while an admin has this page open.
  // A browser-side heartbeat avoids an always-on external monitor; Render can
  // still spin down after 15 minutes when every admin tab is closed.
  let lastHealthPing = 0;
  const pingHealth = () => {
    const now = Date.now();
    if (now - lastHealthPing < 60_000) return;
    lastHealthPing = now;
    fetch('/api/health', { cache: 'no-store' }).catch(() => {});
  };
  window.setInterval(pingHealth, 8 * 60 * 1000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') pingHealth();
  });

  fetch('/api/config').then((response) => response.ok ? response.json() : null).then((data) => {
    if (data?.maxUploadSizeMb) { uploadLimit = data.maxUploadSizeMb; $('#max-size').textContent = uploadLimit; }
    $('#save-button').disabled = !data?.driveConfigured;
    if (data?.driveConfigured) {
      notice('Ready. Saving updates only the existing UTR and screenshot link for the selected Pass No.', 'success');
    } else {
      $('#drive-connect').hidden = !data?.driveOAuthReady || !data?.driveAuthorizationNeeded;
      notice(data?.driveOAuthReady
        ? 'Connect Google Drive to enable screenshot uploads. Lookup remains available.'
        : 'Google Drive OAuth credentials are needed for screenshot uploads. Lookup remains available.', 'error');
    }
  }).catch(() => {});
  fetch('/api/health').then(async (response) => { if (!response.ok) { const data = await response.json().catch(() => ({})); notice(data.message || 'Google Sheets and Drive are not configured yet. The interface is in preview mode.', 'error'); } }).catch(() => notice('The admin backend is unavailable.', 'error'));
} else {
  $('#search-button').disabled = true;
  notice('Preview only. Open http://localhost:3000 to look up a registration.', 'error');
}

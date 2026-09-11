// extension/shared/share-security-ui.js
// A small, self-contained UI block for setting password protection and
// expiration on a share link that already exists -- reused across all
// four surfaces that can create a share link (popup, gallery, editor,
// recorder) rather than duplicating this markup/logic four times. Uses
// inline styles referencing each page's own CSS custom properties
// (--accent, --bg-card, --border, --text, --text-dim -- consistent
// names across every page's stylesheet in this project) instead of
// requiring a matching CSS class to be added to four separate
// stylesheets.
import { setSharePassword, setLinkExpiration } from './api.js';

const EXPIRY_OPTIONS = [
  { label: 'Never expires', hours: null },
  { label: 'Expires in 1 hour', hours: 1 },
  { label: 'Expires in 24 hours', hours: 24 },
  { label: 'Expires in 7 days', hours: 24 * 7 },
  { label: 'Expires in 30 days', hours: 24 * 30 }
];

/**
 * Builds and appends the password + expiration controls into `container`.
 * @param {HTMLElement} container - appended into; typically the same
 *   panel that already shows the share URL + Copy button.
 * @param {string} shareId
 * @param {(message: string, isError?: boolean) => void} showToast
 */
export function mountShareSecurityControls(container, shareId, showToast) {
  const wrap = document.createElement('div');
  wrap.style.cssText =
    'margin-top:10px;padding-top:10px;border-top:1px solid var(--border);' +
    'display:flex;flex-direction:column;gap:8px;';

  // --- Password protection ---
  const pwRow = document.createElement('div');
  pwRow.style.cssText = 'display:flex;gap:6px;align-items:center;';
  pwRow.innerHTML = `
    <span style="font-size:11px;color:var(--text-dim);white-space:nowrap;">🔒 Password</span>
    <input type="password" placeholder="Leave blank for no password"
      style="flex:1;min-width:0;background:var(--bg-card);border:1px solid var(--border);
      color:var(--text);border-radius:7px;padding:6px 8px;font-size:11.5px;" />
    <button style="background:var(--accent);border:none;color:#fff;border-radius:7px;
      padding:6px 10px;font-size:11px;font-weight:600;cursor:pointer;white-space:nowrap;">Save</button>
  `;
  const pwInput = pwRow.querySelector('input');
  const pwBtn = pwRow.querySelector('button');
  pwBtn.addEventListener('click', async () => {
    pwBtn.disabled = true;
    pwBtn.textContent = 'Saving…';
    try {
      const result = await setSharePassword(shareId, pwInput.value.trim());
      showToast(result.password_protected ? 'Password set 🔒' : 'Password removed', false);
      if (!result.password_protected) pwInput.value = '';
    } catch (err) {
      showToast(err.message || 'Could not update password.', true);
    } finally {
      pwBtn.disabled = false;
      pwBtn.textContent = 'Save';
    }
  });

  // --- Expiration ---
  const expRow = document.createElement('div');
  expRow.style.cssText = 'display:flex;gap:6px;align-items:center;';
  const select = document.createElement('select');
  select.style.cssText =
    'flex:1;min-width:0;background:var(--bg-card);border:1px solid var(--border);' +
    'color:var(--text);border-radius:7px;padding:6px 8px;font-size:11.5px;';
  for (const opt of EXPIRY_OPTIONS) {
    const el = document.createElement('option');
    el.value = opt.hours ?? '';
    el.textContent = opt.label;
    select.appendChild(el);
  }
  const expBtn = document.createElement('button');
  expBtn.textContent = 'Save';
  expBtn.style.cssText =
    'background:var(--accent);border:none;color:#fff;border-radius:7px;' +
    'padding:6px 10px;font-size:11px;font-weight:600;cursor:pointer;white-space:nowrap;';
  expRow.innerHTML = '<span style="font-size:11px;color:var(--text-dim);white-space:nowrap;">⏰ Expiry</span>';
  expRow.appendChild(select);
  expRow.appendChild(expBtn);
  expBtn.addEventListener('click', async () => {
    expBtn.disabled = true;
    expBtn.textContent = 'Saving…';
    try {
      const hours = select.value ? Number(select.value) : null;
      await setLinkExpiration(shareId, hours);
      showToast(hours ? `Link will expire in ${select.options[select.selectedIndex].text.replace('Expires in ', '')}` : 'Link set to never expire', false);
    } catch (err) {
      showToast(err.message || 'Could not update expiration.', true);
    } finally {
      expBtn.disabled = false;
      expBtn.textContent = 'Save';
    }
  });

  wrap.appendChild(pwRow);
  wrap.appendChild(expRow);
  container.appendChild(wrap);
  return wrap;
}

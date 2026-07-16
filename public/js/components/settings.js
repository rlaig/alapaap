'use strict';

const SettingsComponent = (() => {
  function render(container) {
    container.innerHTML = `
      <div class="panel" style="max-width:480px">
        <div class="panel-header">&gt;_ change password</div>
        <div class="panel-body">
          <form id="pw-form">
            <div class="form-group">
              <label class="form-label">&gt;_ current password</label>
              <input type="password" class="form-input" id="pw-current" autocomplete="current-password">
            </div>
            <div class="form-group">
              <label class="form-label">&gt;_ new password</label>
              <input type="password" class="form-input" id="pw-new" autocomplete="new-password">
            </div>
            <div class="form-group">
              <label class="form-label">&gt;_ confirm new password</label>
              <input type="password" class="form-input" id="pw-confirm" autocomplete="new-password">
            </div>
            <div class="form-error" id="pw-error"></div>
            <button type="submit" class="btn-console btn-ok">[SAVE]</button>
          </form>
        </div>
      </div>
      <div class="panel mt-16" style="max-width:480px">
        <div class="panel-header">&gt;_ audit log (recent)</div>
        <div class="panel-body scroll-x" id="settings-audit">
          <span class="text-dim">loading...</span>
        </div>
      </div>`;

    document.getElementById('pw-form').addEventListener('submit', handleChangePassword);
    loadAuditLog();
  }

  async function handleChangePassword(e) {
    e.preventDefault();
    const errEl = document.getElementById('pw-error');
    errEl.textContent = '';

    const current = document.getElementById('pw-current').value;
    const newPw = document.getElementById('pw-new').value;
    const confirm = document.getElementById('pw-confirm').value;

    if (!current || !newPw) {
      errEl.textContent = 'ERR: all fields required';
      return;
    }
    if (newPw !== confirm) {
      errEl.textContent = 'ERR: passwords do not match';
      return;
    }
    if (newPw.length < 8) {
      errEl.textContent = 'ERR: password must be at least 8 characters';
      return;
    }

    try {
      await Api.post('/api/auth/change-password', { currentPassword: current, newPassword: newPw });
      App.toast('password changed', 'ok');
      document.getElementById('pw-form').reset();
    } catch (err) {
      errEl.textContent = `ERR: ${err.message}`;
    }
  }

  async function loadAuditLog() {
    try {
      const data = await Api.get('/api/auth/audit-log?limit=20');
      const el = document.getElementById('settings-audit');
      if (el && Array.isArray(data) && data.length) {
        const header = '<tr><th>time</th><th>action</th><th>target</th><th>ip</th></tr>';
        const rows = data.map(e => `<tr>
          <td class="text-dim">${esc(e.timestamp)}</td>
          <td>${esc(e.action)}</td>
          <td class="text-dim">${esc(e.target || '--')}</td>
          <td class="text-dim">${esc(e.ip || '--')}</td>
        </tr>`).join('');
        el.innerHTML = `<table class="table-console">${header}${rows}</table>`;
      } else if (el) {
        el.innerHTML = '<span class="text-dim">no entries</span>';
      }
    } catch {
      // silent
    }
  }

  function esc(s) {
    const d = document.createElement('div');
    d.textContent = s || '';
    return d.innerHTML;
  }

  function destroy() {}

  return { render, destroy };
})();

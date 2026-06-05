'use strict';

const LoginComponent = (() => {
  const ASCII_ART = `
   __ _| | __ _ _ __   __ _  __ _ _ __
  / _\` | |/ _\` | '_ \\ / _\` |/ _\` | '_ \\
 | (_| | | (_| | |_) | (_| | (_| | |_) |
  \\__,_|_|\\__,_| .__/ \\__,_|\\__,_| .__/
               |_|                |_|`;

  function render(container) {
    container.innerHTML = `
      <div class="login-box">
        <div class="login-header">${ASCII_ART}</div>
        <form class="login-form" id="login-form">
          <div class="form-group">
            <label class="form-label">&gt;_ username</label>
            <input type="text" class="form-input" id="login-user" autocomplete="username" autofocus>
          </div>
          <div class="form-group">
            <label class="form-label">&gt;_ password</label>
            <input type="password" class="form-input" id="login-pass" autocomplete="current-password">
          </div>
          <div class="form-error" id="login-error"></div>
          <button type="submit" class="btn-login">[ENTER]</button>
        </form>
      </div>`;

    document.getElementById('login-form').addEventListener('submit', handleLogin);
  }

  async function handleLogin(e) {
    e.preventDefault();
    const user = document.getElementById('login-user').value.trim();
    const pass = document.getElementById('login-pass').value;
    const errEl = document.getElementById('login-error');
    errEl.textContent = '';

    if (!user || !pass) {
      errEl.textContent = 'ERR: username and password required';
      return;
    }

    try {
      const data = await Api.post('/api/auth/login', { username: user, password: pass });
      Api.setToken(data.token);
      App.showMain();
    } catch (err) {
      errEl.textContent = `ERR: ${err.message}`;
    }
  }

  return { render };
})();

import { html, setHtml } from '../util.js';

const DEMO_PASSWORD = 'demo1234';

export function createLoginView({ api, navigate }, { signIn }) {
  let root;
  let slowTimer;

  async function submit(e) {
    e.preventDefault();
    const form = e.currentTarget;
    const btn = form.querySelector('button[type=submit]');
    const err = form.querySelector('.error-text');
    err.textContent = '';
    btn.disabled = true;
    btn.textContent = 'Signing in…';
    // Free hosting sleeps when idle; tell people why the first sign-in can take a while.
    slowTimer = setTimeout(() => {
      err.classList.remove('accent');
      err.style.color = 'var(--g5)';
      err.textContent = 'Waking the demo server. The first request can take up to a minute.';
    }, 3500);
    try {
      const { token, user } = await api.post('/auth/login', {
        email: form.email.value.trim(),
        password: form.password.value,
      });
      signIn(token, user);
      navigate('/overview');
    } catch (ex) {
      err.style.color = '';
      err.textContent = ex.message;
      btn.disabled = false;
      btn.textContent = 'Sign in';
    } finally {
      clearTimeout(slowTimer);
    }
  }

  return {
    mount(el) {
      root = el;
      setHtml(
        root,
        html`<div class="login"><div class="login-box">
          <div class="brand">Vigil<span class="dot">.</span></div>
          <p class="tag">Fraud and risk operations. Simulated data only.</p>
          <form id="login-form" novalidate>
            <div class="field"><label for="email">Email</label><input id="email" name="email" type="email" autocomplete="username" required></div>
            <div class="field"><label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required></div>
            <button class="btn primary" type="submit">Sign in</button>
            <div class="error-text" role="alert"></div>
          </form>
          <div class="demo">
            <div style="margin-bottom:6px">Demo accounts (click to fill)</div>
            <div class="row"><button class="linkbtn mono" data-fill="analyst@demo">analyst@demo</button><span>can claim and resolve cases</span></div>
            <div class="row"><button class="linkbtn mono" data-fill="admin@demo">admin@demo</button><span>can edit rules, read audit log</span></div>
            <div class="row"><span>Password</span><span class="mono">${DEMO_PASSWORD}</span></div>
          </div>
        </div></div>`,
      );
      root.querySelector('#login-form').addEventListener('submit', submit);
      root.querySelectorAll('[data-fill]').forEach((b) =>
        b.addEventListener('click', () => {
          root.querySelector('#email').value = b.dataset.fill;
          root.querySelector('#password').value = DEMO_PASSWORD;
        }),
      );
      root.querySelector('#email').focus();
    },
    render() {},
    destroy() {
      clearTimeout(slowTimer);
    },
  };
}

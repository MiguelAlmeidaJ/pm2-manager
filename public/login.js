const form = document.getElementById('login-form');
const usernameInput = document.getElementById('username');
const passwordInput = document.getElementById('password');
const button = document.getElementById('login-btn');
const errorBox = document.getElementById('login-error');

function getSafeNext() {
  const value = new URLSearchParams(window.location.search).get('next');
  if (!value || !value.startsWith('/') || value.startsWith('//')) return '/';
  return value;
}

function showError(message) {
  errorBox.textContent = message;
  errorBox.classList.remove('hidden');
}

function clearError() {
  errorBox.textContent = '';
  errorBox.classList.add('hidden');
}

async function checkExistingSession() {
  try {
    const response = await fetch('/api/auth/status', {
      credentials: 'same-origin',
      cache: 'no-store',
    });
    const data = await response.json();
    if (data.authenticated) window.location.replace(getSafeNext());
  } catch (_) {
    // O formulário continua disponível se o status não puder ser consultado.
  }
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  clearError();

  button.disabled = true;
  button.textContent = 'Entrando...';

  try {
    const response = await fetch('/api/auth/login', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: usernameInput.value.trim(),
        password: passwordInput.value,
      }),
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(data.error || 'Não foi possível entrar.');
    }

    passwordInput.value = '';
    window.location.replace(getSafeNext());
  } catch (error) {
    showError(error.message);
    passwordInput.select();
  } finally {
    button.disabled = false;
    button.textContent = 'Entrar';
  }
});

checkExistingSession();

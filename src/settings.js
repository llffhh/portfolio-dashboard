// Config resolution for the public GitHub Pages deployment (design B.3.3):
// the secret API key is never committed, so it comes from (in order)
// 1. local gitignored config.js (developer machine)
// 2. browser localStorage (entered once via the setup form on the Pages site)
const PLACEHOLDER = 'YOUR_SCRIPT_ID';

export async function getConfig() {
  try {
    const m = await import('../config.js');
    if (m.WEBAPP_URL && !m.WEBAPP_URL.includes(PLACEHOLDER) && m.API_KEY && m.API_KEY !== 'PASTE_YOUR_SECRET_KEY') {
      return { WEBAPP_URL: m.WEBAPP_URL, API_KEY: m.API_KEY, source: 'file' };
    }
  } catch (e) { /* config.js absent — public deployment */ }

  const WEBAPP_URL = localStorage.getItem('WEBAPP_URL') || '';
  const API_KEY = localStorage.getItem('API_KEY') || '';
  if (WEBAPP_URL && API_KEY) return { WEBAPP_URL, API_KEY, source: 'localStorage' };
  return null;
}

export function saveConfig(url, key) {
  localStorage.setItem('WEBAPP_URL', url.trim());
  localStorage.setItem('API_KEY', key.trim());
}

export function clearConfig() {
  localStorage.removeItem('WEBAPP_URL');
  localStorage.removeItem('API_KEY');
}

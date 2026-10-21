export const escapeHtml = (v = '') =>
  String(v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
           .replace(/"/g,'&quot;').replace(/'/g,'&#39;');

export const validImageUrl = (url, fb = 'https://upload.wikimedia.org/wikipedia/commons/7/7c/Profile_avatar_placeholder_large.png') => {
  if (typeof url !== 'string') return fb;
  if (!/^https?:\/\//i.test(url)) return fb;
  return url;
};

export const safeUrl = (url, fb = '#') => {
  if (typeof url !== 'string') return fb;
  if (!/^https?:\/\//i.test(url)) return fb;
  return escapeHtml(url);
};

export const safeString = (v, max = 2000) => typeof v === 'string' ? v.slice(0, max) : '';
export const safeId = (id) => String(id || '').replace(/[^a-zA-Z0-9_-]/g, '');
export const stripAndEscape = (html = '') =>
  escapeHtml(String(html).replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim());
export const getTodayKey = () => new Date().toDateString();

export function sanitizeCSS(css, maxLen = 4000) {
  if (typeof css !== 'string') return '';
  let s = css.slice(0, maxLen);
  s = s.replace(/\/\*[\s\S]*?\*\//g, '');
  s = s.replace(/@import[^;]*;?/gi, '');
  s = s.replace(/@charset[^;]*;?/gi, '');
  s = s.replace(/@namespace[^;]*;?/gi, '');
  s = s.replace(/<\/?style[^>]*>/gi, '');
  s = s.replace(/url\(\s*(['"]?)(?!data:)[^)]*\)/gi, '');
  if (/expression\s*\(/i.test(s)) return '';
  if (/javascript\s*:/i.test(s)) return '';
  if (/behavior\s*:/i.test(s)) return '';
  if (/-moz-binding/i.test(s)) return '';
  if (/<script/i.test(s)) return '';
  return s;
}

export function getFriendlyError(error) {
  if (!error) return 'Something went wrong. Please try again.';
  const code = error.code || '';
  const messages = {
    'auth/invalid-credential': 'Incorrect email or password.',
    'auth/invalid-email': 'Please enter a valid email address.',
    'auth/user-not-found': 'No account found with this email.',
    'auth/wrong-password': 'Incorrect password.',
    'auth/user-disabled': 'This account has been disabled.',
    'auth/too-many-requests': 'Too many attempts. Wait a moment.',
    'auth/email-already-in-use': 'Email already in use by another account.',
    'auth/credential-already-in-use': 'This credential is already used by another account.',
    'auth/weak-password': 'Password too weak. Use 6+ characters.',
    'auth/network-request-failed': 'Network error.',
    'auth/requires-recent-login': 'Please sign in again to change this.',
    'permission-denied': 'Permission denied.',
    'not-found': 'Data not found.',
    'unavailable': 'Server temporarily unavailable.',
    'unauthenticated': 'Please sign in again.'
  };
  if (code && messages[code]) return messages[code];
  if (error.message && /already/i.test(error.message)) return error.message;
  return error.message || 'Something went wrong. Please try again.';
}

export function restoreOriginalPath(req) {
  try {
    const u = new URL(req.url, 'http://localhost');
    if (u.searchParams.has('p')) {
      const p = u.searchParams.get('p');
      u.searchParams.delete('p');
      const rest = u.searchParams.toString();
      req.url = '/api/' + p + (rest ? '?' + rest : '');
    }
  } catch (_) { /* ignore */ }
}
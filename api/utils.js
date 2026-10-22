export const escapeHtml = (v = '') =>
  String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

export const validImageUrl = (url, fb = 'https://upload.wikimedia.org/wikipedia/commons/7/7c/Profile_avatar_placeholder_large.png') => {
  if (typeof url !== 'string') return fb;
  if (!/^https?:\/\//i.test(url)) return fb;
  return url;
};

export const safeString = (v, maxLen = 2000) =>
  typeof v === 'string' ? v.slice(0, maxLen) : '';

export function sanitizeCSS(css, maxLen = 4000) {
  if (typeof css !== 'string') return '';
  if (css.length > maxLen) css = css.slice(0, maxLen);
  css = css.replace(/\/\*[\s\S]*?\*\//g, '');
  css = css.replace(/@import[^;]*;?/gi, '');
  css = css.replace(/@charset[^;]*;?/gi, '');
  css = css.replace(/@namespace[^;]*;?/gi, '');
  css = css.replace(/<\/?style[^>]*>/gi, '');
  css = css.replace(/url\(\s*(['"]?)(?!data:)[^)]*\)/gi, '');
  if (/expression\s*\(/i.test(css)) return '';
  if (/javascript\s*:/i.test(css)) return '';
  if (/behavior\s*:/i.test(css)) return '';
  if (/-moz-binding/i.test(css)) return '';
  if (/<script/i.test(css)) return '';
  return css;
}

export const getTodayKey = () => new Date().toDateString();

export const isValidEmail = (e) =>
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e || '').trim().toLowerCase());

export function friendlyError(e) {
  if (!e) return 'Something went wrong. Please try again.';
  const msg = e.message || '';
  if (/already/i.test(msg)) return msg;
  if (/cannot be changed/i.test(msg)) return msg;
  return msg || 'Something went wrong. Please try again.';
}

export default function handler(req, res) {
  res.status(404).json({ error: 'Not found' });
}

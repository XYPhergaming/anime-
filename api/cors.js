// CORS middleware. Also exports a 404 handler so Vercel doesn't treat this as an endpoint.
export function corsMiddleware(req, res, next) {
  const origin = req.headers.origin || '';
  const allowed = process.env.ALLOWED_ORIGIN || '*';
  if (allowed === '*') {
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
  } else if (allowed.split(',').map(s => s.trim()).includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
}

export default function handler(req, res) {
  res.status(404).json({ error: 'Not found' });
}

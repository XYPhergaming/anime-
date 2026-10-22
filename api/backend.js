import 'dotenv/config';
import express from 'express';
import cookieParser from 'cookie-parser';
import { corsMiddleware } from './cors.js';
import { friendlyError } from './utils.js';
import {
  signToken, verifyToken, getUserByUid, publicUser, loadConfig, isReady,
  buildGoogleAuthUrl, exchangeGoogleCode, findOrCreateGoogleUser,
  emailLogin, completeSetup, updateProfile, linkBackupEmail, changePassword,
  calculateRank, buyStoreItem, claimDaily,
  addToUpcoming, removeUpcoming, incrementWatching, toggleSlot,
  toggleFollow, getLeaderboard, getPublicUser, getFollowers,
  listPolls, myPolls, createPoll, answerPoll, reportPoll,
  getTrendingAnime, searchAnime, getAnimeDetails, getSeasonal, getSchedule,
  getTrendingManga, searchManga, getMangaDetails, fetchEpisodeTitle,
  identifyAnime, getStoreItems, getNews, getMusicStations, uploadAvatar, celebrate
} from './script.js';

const app = express();
app.set('trust proxy', 1);

app.use(corsMiddleware);
app.use(express.json({ limit: '12mb' }));
app.use(cookieParser());

// ---------- PATH NORMALIZATION (must run first) ----------
app.use((req, res, next) => {
  const apiPath = req.headers['x-api-path'];
  if (apiPath && typeof apiPath === 'string') {
    req.url = '/api' + (apiPath.startsWith('/') ? apiPath : '/' + apiPath);
  } else if (!req.url.startsWith('/api')) {
    req.url = '/api' + req.url;
  }
  next();
});

// ---------- DIAGNOSTICS (public, before DB gate) ----------
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    time: new Date().toISOString(),
    node: process.version,
    dbReady: isReady(),
    url: req.url,
    host: req.headers.host
  });
});

app.get('/api/debug', (req, res) => {
  res.json({
    ok: true,
    env: {
      FIREBASE_PROJECT_ID: !!process.env.FIREBASE_PROJECT_ID,
      FIREBASE_CLIENT_EMAIL: !!process.env.FIREBASE_CLIENT_EMAIL,
      FIREBASE_PRIVATE_KEY: !!process.env.FIREBASE_PRIVATE_KEY,
      JWT_SECRET: !!process.env.JWT_SECRET,
      GOOGLE_CLIENT_ID: !!process.env.GOOGLE_CLIENT_ID,
      GOOGLE_CLIENT_SECRET: !!process.env.GOOGLE_CLIENT_SECRET,
      BASE_URL: process.env.BASE_URL || '(not set - using host)',
      IMGBB_KEY: !!process.env.IMGBB_KEY,
      GEMINI_KEY: !!process.env.GEMINI_KEY,
      ALLOWED_ORIGIN: process.env.ALLOWED_ORIGIN || '*'
    },
    dbReady: isReady(),
    requestUrl: req.url,
    headers: {
      'x-forwarded-proto': req.headers['x-forwarded-proto'],
      'x-forwarded-host': req.headers['x-forwarded-host'],
      'x-api-path': req.headers['x-api-path'] || null
    }
  });
});

// ---------- DB GATE ----------
app.use('/api', (req, res, next) => {
  if (!isReady() && req.path !== '/health' && req.path !== '/debug') {
    return res.status(500).json({
      error: 'Database not initialized. Check FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY in Vercel env.'
    });
  }
  next();
});

const router = express.Router();

const wrap = (fn) => async (req, res) => {
  try { await fn(req, res); }
  catch (e) {
    console.error('[API]', req.method, req.originalUrl, e?.message || e);
    res.status(400).json({ error: friendlyError(e) });
  }
};

const isSecure = (req) => req.secure || req.headers['x-forwarded-proto'] === 'https';
const cookieOpts = (req) => ({
  httpOnly: true,
  secure: isSecure(req),
  sameSite: 'lax',
  path: '/',
  maxAge: 30 * 24 * 60 * 60 * 1000
});

function authenticate(req, res, next) {
  const token = req.cookies?.session;
  if (!token) return res.status(401).json({ error: 'Not signed in.' });
  const payload = verifyToken(token);
  if (!payload) return res.status(401).json({ error: 'Session expired.' });
  req.auth = payload;
  next();
}

// ---------- AUTH ----------
router.get('/auth/google', wrap(async (req, res) => {
  const baseUrl = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
  const { url, state } = buildGoogleAuthUrl(baseUrl);
  res.cookie('oauth_state', state, { ...cookieOpts(req), maxAge: 10 * 60 * 1000 });
  res.redirect(url);
}));

router.get('/auth/google/callback', wrap(async (req, res) => {
  const { code, state } = req.query;
  const expected = req.cookies?.oauth_state;
  res.clearCookie('oauth_state', { path: '/' });
  if (!code || !state || state !== expected) return res.redirect('/?auth_error=invalid_state');
  const baseUrl = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
  try {
    const g = await exchangeGoogleCode(code, baseUrl);
    const { user } = await findOrCreateGoogleUser(g);
    if (user.isBanned) return res.redirect('/?auth_error=banned');
    const token = signToken(user);
    res.cookie('session', token, cookieOpts(req));
    return res.redirect(user.setupCompleted ? '/' : '/?setup=1');
  } catch (e) {
    console.error('[Auth callback]', e?.message || e);
    if (e.code === 'ADMIN_ACCOUNT') return res.redirect('/?auth_error=admin_account');
    return res.redirect('/?auth_error=google_failed');
  }
}));

router.post('/auth/login', wrap(async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) throw new Error('Enter backup email and password.');
  const user = await emailLogin(email, password);
  if (user.isBanned) throw new Error('Your account is banned.');
  const token = signToken(user);
  res.cookie('session', token, cookieOpts(req));
  res.json({ ok: true, user: publicUser(user) });
}));

router.post('/auth/logout', (req, res) => {
  res.clearCookie('session', { path: '/' });
  res.json({ ok: true });
});

router.get('/auth/me', authenticate, wrap(async (req, res) => {
  const user = await getUserByUid(req.auth.uid);
  if (!user) { res.clearCookie('session', { path: '/' }); return res.status(401).json({ error: 'User not found.' }); }
  if (user.isBanned) { res.clearCookie('session', { path: '/' }); return res.status(403).json({ error: 'Account banned: ' + (user.banReason || 'Violation of terms') }); }
  res.json({ user: publicUser(user) });
}));

// ---------- USER ----------
router.get('/user/me', authenticate, wrap(async (req, res) => {
  const user = await getUserByUid(req.auth.uid);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  res.json({ user: publicUser(user) });
}));

router.post('/user/setup', authenticate, wrap(async (req, res) => {
  await completeSetup(req.auth.uid, req.body?.name, req.body?.avatar);
  res.json({ user: publicUser(await getUserByUid(req.auth.uid)) });
}));

router.put('/user/profile', authenticate, wrap(async (req, res) => {
  await updateProfile(req.auth.uid, req.body?.name, req.body?.avatar);
  res.json({ user: publicUser(await getUserByUid(req.auth.uid)) });
}));

router.post('/user/backup-email', authenticate, wrap(async (req, res) => {
  res.json(await linkBackupEmail(req.auth.uid, req.body?.email, req.body?.password));
}));

router.post('/user/change-password', authenticate, wrap(async (req, res) => {
  await changePassword(req.auth.uid, req.body?.currentPassword, req.body?.newPassword);
  res.json({ ok: true });
}));

router.post('/user/claim-daily', authenticate, wrap(async (req, res) => {
  res.json(await claimDaily(req.auth.uid));
}));

router.post('/user/upcoming/add', authenticate, wrap(async (req, res) => {
  res.json(await addToUpcoming(req.auth.uid, req.body?.item || {}));
}));

router.post('/user/upcoming/remove', authenticate, wrap(async (req, res) => {
  res.json({ upcoming: await removeUpcoming(req.auth.uid, req.body?.malId) });
}));

router.post('/user/upcoming/increment', authenticate, wrap(async (req, res) => {
  res.json(await incrementWatching(req.auth.uid, req.body?.malId));
}));

router.post('/user/slot/toggle', authenticate, wrap(async (req, res) => {
  const items = await toggleSlot(req.auth.uid, req.body?.slot, req.body?.malId);
  res.json({ slot: req.body?.slot, items });
}));

router.post('/user/follow', authenticate, wrap(async (req, res) => {
  if (!req.body?.uid) throw new Error('Target UID required.');
  res.json(await toggleFollow(req.auth.uid, String(req.body.uid)));
}));

router.get('/user/leaderboard', authenticate, wrap(async (req, res) => {
  res.json({ list: await getLeaderboard() });
}));

router.get('/user/followers', authenticate, wrap(async (req, res) => {
  res.json({ list: await getFollowers(req.auth.uid) });
}));

router.get('/user/public/:uid', authenticate, wrap(async (req, res) => {
  const u = await getPublicUser(req.params.uid);
  if (!u) return res.status(404).json({ error: 'User not found.' });
  res.json({ user: u });
}));

router.get('/user/rank-info', authenticate, wrap(async (req, res) => {
  const config = await loadConfig();
  const user = await getUserByUid(req.auth.uid);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  const { rank, target } = calculateRank(user.totalExp || 0, config.rankThresholds);
  res.json({ totalExp: user.totalExp || 0, rank, target, thresholds: config.rankThresholds });
}));

// ---------- STORE ----------
router.get('/store/items', authenticate, wrap(async (req, res) => {
  res.json({ items: await getStoreItems() });
}));

router.post('/store/buy/:id', authenticate, wrap(async (req, res) => {
  res.json(await buyStoreItem(req.auth.uid, req.params.id));
}));

// ---------- POLLS ----------
router.get('/polls', authenticate, wrap(async (req, res) => {
  res.json({ list: await listPolls(req.auth.uid) });
}));
router.get('/polls/mine', authenticate, wrap(async (req, res) => {
  res.json({ list: await myPolls(req.auth.uid) });
}));
router.post('/polls', authenticate, wrap(async (req, res) => {
  res.json(await createPoll(req.auth.uid, req.body || {}));
}));
router.post('/polls/:id/answer', authenticate, wrap(async (req, res) => {
  res.json(await answerPoll(req.auth.uid, req.params.id, req.body?.index));
}));
router.post('/polls/:id/report', authenticate, wrap(async (req, res) => {
  await reportPoll(req.auth.uid, req.params.id);
  res.json({ ok: true });
}));

// ---------- ANIME / MANGA ----------
router.get('/anime/trending', authenticate, wrap(async (req, res) => {
  res.json(await getTrendingAnime(Number(req.query.page) || 1));
}));

router.get('/anime/search', authenticate, wrap(async (req, res) => {
  res.json(await searchAnime({
    q: req.query.q, genre: req.query.genre, year: req.query.year,
    format: req.query.format, status: req.query.status, score: req.query.score
  }));
}));

router.get('/anime/details/:id', authenticate, wrap(async (req, res) => {
  const isMAL = req.query.by === 'mal';
  const anime = isMAL ? await getAnimeDetails(null, req.params.id) : await getAnimeDetails(req.params.id, null);
  if (!anime) return res.status(404).json({ error: 'Anime not found.' });
  res.json({ anime });
}));

router.get('/anime/seasonal', authenticate, wrap(async (req, res) => {
  res.json(await getSeasonal(req.query.season, req.query.year));
}));

router.get('/anime/schedule', authenticate, wrap(async (req, res) => {
  res.json(await getSchedule(req.query.from, req.query.to));
}));

router.get('/anime/episode-title', authenticate, wrap(async (req, res) => {
  res.json({ title: await fetchEpisodeTitle(req.query.title || '', Number(req.query.ep) || 1) });
}));

router.get('/manga/trending', authenticate, wrap(async (req, res) => {
  res.json(await getTrendingManga(Number(req.query.page) || 1));
}));

router.get('/manga/search', authenticate, wrap(async (req, res) => {
  res.json(await searchManga(req.query.q || ''));
}));

router.get('/manga/details/:id', authenticate, wrap(async (req, res) => {
  res.json(await getMangaDetails(req.params.id));
}));

// ---------- SCANNER ----------
router.post('/scanner/identify', authenticate, wrap(async (req, res) => {
  if (!req.body?.image) throw new Error('Image required.');
  res.json(await identifyAnime(String(req.body.image).replace(/^data:image\/\w+;base64,/, '')));
}));

// ---------- MISC ----------
router.get('/news', authenticate, wrap(async (req, res) => {
  res.json({ list: await getNews() });
}));

router.get('/music/stations', authenticate, wrap(async (req, res) => {
  res.json({ list: await getMusicStations() });
}));

router.post('/upload/avatar', authenticate, wrap(async (req, res) => {
  if (!req.body?.image) throw new Error('Image required.');
  res.json(await uploadAvatar(req.body.image));
}));

router.get('/celebrate', authenticate, wrap(async (req, res) => {
  res.json(await celebrate());
}));

app.use('/api', router);

app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Not found', path: req.url });
});

export default app;

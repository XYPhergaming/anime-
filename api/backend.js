import 'dotenv/config';
import express from 'express';
import cookieParser from 'cookie-parser';
import { corsMiddleware } from './cors.js';
import { friendlyError } from './utils.js';
import {
  signToken, verifyToken, getUserByUid, publicUser, loadConfig,
  buildGoogleAuthUrl, exchangeGoogleCode, findOrCreateGoogleUser,
  emailLogin, completeSetup, updateProfile, linkBackupEmail, changePassword,
  recalculatePublic: _unused,
  recalcRank, calculateRank, buyStoreItem, claimDaily,
  addToUpcoming, removeUpcoming, incrementWatching, toggleSlot,
  toggleFollow, getLeaderboard, getPublicUser, getFollowers,
  listPolls, myPolls, createPoll, answerPoll, reportPoll,
  getTrendingAnime, searchAnime, getAnimeDetails, getSeasonal, getSchedule,
  getTrendingManga, searchManga, getMangaDetails, fetchEpisodeTitle,
  identifyAnime, getStoreItems, getNews, getMusicStations, uploadAvatar, celebrate
} from './script.js';

const app = express();
app.use(corsMiddleware);
app.use(express.json({ limit: '10mb' }));
app.use(cookieParser());

// Normalize URL so routing works whether Vercel preserved the path or not
app.use((req, res, next) => {
  let u = req.url;
  if (u.startsWith('/api/backend')) u = '/api' + u.slice('/api/backend'.length);
  else if (!u.startsWith('/api')) u = '/api' + u;
  req.url = u;
  next();
});

const router = express.Router();

const wrap = (fn) => async (req, res) => {
  try { await fn(req, res); }
  catch (e) {
    console.error('[API]', req.method, req.originalUrl, e);
    res.status(400).json({ error: friendlyError(e) });
  }
};

const COOKIE_OPTS = {
  httpOnly: true, secure: true, sameSite: 'lax',
  maxAge: 30 * 24 * 60 * 60 * 1000, path: '/'
};

function authenticate(req, res, next) {
  const token = req.cookies?.session;
  if (!token) return res.status(401).json({ error: 'Not signed in.' });
  const payload = verifyToken(token);
  if (!payload) return res.status(401).json({ error: 'Session expired.' });
  req.auth = payload;
  next();
}

// ---- Auth ----
router.get('/auth/google', wrap(async (req, res) => {
  const baseUrl = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
  const { url, state } = buildGoogleAuthUrl(baseUrl);
  res.cookie('oauth_state', state, { ...COOKIE_OPTS, maxAge: 10 * 60 * 1000 });
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
    const { user, isNew } = await findOrCreateGoogleUser(g);
    if (user.isBanned) return res.redirect('/?auth_error=banned');
    const token = signToken(user);
    res.cookie('session', token, COOKIE_OPTS);
    return res.redirect(isNew || !user.setupCompleted ? '/?setup=1' : '/');
  } catch (e) {
    if (e.code === 'ADMIN_ACCOUNT') return res.redirect('/?auth_error=admin_account');
    console.error('[Auth] google callback', e);
    return res.redirect('/?auth_error=google_failed');
  }
}));

router.post('/auth/login', wrap(async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) throw new Error('Enter backup email and password.');
  const user = await emailLogin(email, password);
  if (user.isBanned) throw new Error('Your account is banned.');
  const token = signToken(user);
  res.cookie('session', token, COOKIE_OPTS);
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

// ---- User ----
router.get('/user/me', authenticate, wrap(async (req, res) => {
  const user = await getUserByUid(req.auth.uid);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  if (user.isBanned) return res.status(403).json({ error: 'Account banned.' });
  res.json({ user: publicUser(user) });
}));

router.post('/user/setup', authenticate, wrap(async (req, res) => {
  const { name, avatar } = req.body || {};
  await completeSetup(req.auth.uid, name, avatar);
  const user = await getUserByUid(req.auth.uid);
  res.json({ user: publicUser(user) });
}));

router.put('/user/profile', authenticate, wrap(async (req, res) => {
  const { name, avatar } = req.body || {};
  await updateProfile(req.auth.uid, name, avatar);
  const user = await getUserByUid(req.auth.uid);
  res.json({ user: publicUser(user) });
}));

router.post('/user/backup-email', authenticate, wrap(async (req, res) => {
  const { email, password } = req.body || {};
  const r = await linkBackupEmail(req.auth.uid, email, password);
  res.json(r);
}));

router.post('/user/change-password', authenticate, wrap(async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  await changePassword(req.auth.uid, currentPassword, newPassword);
  res.json({ ok: true });
}));

router.post('/user/claim-daily', authenticate, wrap(async (req, res) => {
  const r = await claimDaily(req.auth.uid);
  res.json(r);
}));

router.post('/user/upcoming/add', authenticate, wrap(async (req, res) => {
  const r = await addToUpcoming(req.auth.uid, req.body?.item || {});
  res.json(r);
}));
router.post('/user/upcoming/remove', authenticate, wrap(async (req, res) => {
  const up = await removeUpcoming(req.auth.uid, req.body?.malId);
  res.json({ upcoming: up });
}));
router.post('/user/upcoming/increment', authenticate, wrap(async (req, res) => {
  const r = await incrementWatching(req.auth.uid, req.body?.malId);
  res.json(r);
}));
router.post('/user/slot/toggle', authenticate, wrap(async (req, res) => {
  const { slot, malId } = req.body || {};
  const arr = await toggleSlot(req.auth.uid, slot, malId);
  res.json({ slot, items: arr });
}));
router.post('/user/follow', authenticate, wrap(async (req, res) => {
  const targetUid = req.body?.uid;
  if (!targetUid) throw new Error('Target UID required.');
  const r = await toggleFollow(req.auth.uid, String(targetUid));
  res.json(r);
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

// ---- Store ----
router.get('/store/items', authenticate, wrap(async (req, res) => {
  res.json({ items: await getStoreItems() });
}));
router.post('/store/buy/:id', authenticate, wrap(async (req, res) => {
  const r = await buyStoreItem(req.auth.uid, req.params.id);
  res.json(r);
}));

// ---- Polls ----
router.get('/polls', authenticate, wrap(async (req, res) => {
  res.json({ list: await listPolls(req.auth.uid) });
}));
router.get('/polls/mine', authenticate, wrap(async (req, res) => {
  res.json({ list: await myPolls(req.auth.uid) });
}));
router.post('/polls', authenticate, wrap(async (req, res) => {
  const r = await createPoll(req.auth.uid, req.body || {});
  res.json(r);
}));
router.post('/polls/:id/answer', authenticate, wrap(async (req, res) => {
  const r = await answerPoll(req.auth.uid, req.params.id, req.body?.index);
  res.json(r);
}));
router.post('/polls/:id/report', authenticate, wrap(async (req, res) => {
  await reportPoll(req.auth.uid, req.params.id);
  res.json({ ok: true });
}));

// ---- Anime / Manga ----
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
  const id = req.params.id;
  const isMAL = req.query.by === 'mal';
  const anime = isMAL ? await getAnimeDetails(null, id) : await getAnimeDetails(id, null);
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
  const t = await fetchEpisodeTitle(req.query.title || '', Number(req.query.ep) || 1);
  res.json({ title: t });
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

// ---- Scanner ----
router.post('/scanner/identify', authenticate, wrap(async (req, res) => {
  const b64 = req.body?.image;
  if (!b64) throw new Error('Image required.');
  const r = await identifyAnime(String(b64).replace(/^data:image\/\w+;base64,/, ''));
  res.json(r);
}));

// ---- Misc ----
router.get('/news', authenticate, wrap(async (req, res) => {
  res.json({ list: await getNews() });
}));
router.get('/music/stations', authenticate, wrap(async (req, res) => {
  res.json({ list: await getMusicStations() });
}));
router.post('/upload/avatar', authenticate, wrap(async (req, res) => {
  const b64 = req.body?.image;
  if (!b64) throw new Error('Image required.');
  res.json(await uploadAvatar(b64));
}));
router.get('/celebrate', authenticate, wrap(async (req, res) => {
  res.json(await celebrate());
}));

app.use('/api', router);

export default app;

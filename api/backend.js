import express from 'express';
import multer from 'multer';
import { corsMiddleware } from './cors.js';
import { restoreOriginalPath, getFriendlyError, safeString, validImageUrl } from './utils.js';
import {
  initAdmin, db, authAdmin, loadAppConfig, createUserRecord, sanitizeUserData,
  getStoreItems, buyStoreItem, claimDailyBonus, incrementEpisode, toggleFollow,
  answerPoll, createPoll, reportPoll, listPolls, getLeaderboard, setBackupEmailDoc,
  verifyToken, getUserByUid, getUserByCustomId, calculateRank, recalculateExpAndRank
} from './script.js';
import {
  anilistQuery, fetchAnimeDetails, traceMoeSearch, geminiScan, uploadToImgBB,
  fetchNewsXml, fetchKitsuEpisodeTitle, fetchRadioStations, fetchNekosCelebrate,
  idToolkitSignInEmail, idToolkitSignInGoogle, idToolkitRefresh, idToolkitLinkPassword
} from './api.js';

initAdmin();

const app = express();
app.use(corsMiddleware);
app.use(express.json({ limit: '10mb' }));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// ---------- Auth middleware ----------
async function authenticate(req, res, next) {
  try {
    const h = req.headers.authorization || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    const decoded = await verifyToken(token);
    req.uid = decoded.uid;
    req.decoded = decoded;
    next();
  } catch (e) {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

const wrap = (fn) => async (req, res) => {
  try { await fn(req, res); }
  catch (e) { res.status(400).json({ error: getFriendlyError(e) }); }
};

// ---------- PUBLIC CONFIG ----------
app.get('/api/config', wrap(async (req, res) => {
  const cfg = await loadAppConfig();
  res.json({
    dailyBonus: cfg.dailyBonus, maxUpcoming: cfg.maxUpcoming,
    maxPrime: cfg.maxPrime, maxFavourite: cfg.maxFavourite,
    rankThresholds: cfg.rankThresholds,
    googleClientId: process.env.GOOGLE_CLIENT_ID || ''
  });
}));

// ---------- AUTH ----------
app.post('/api/auth/signin-email', wrap(async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password required.' });
  const d = await idToolkitSignInEmail(email, password);
  let user = await getUserByUid(d.localId);
  if (!user) {
    user = await createUserRecord(d.localId, { email: d.email, name: d.displayName || 'Gojo Hunter', avatar: d.photoUrl });
  }
  if (user.isBanned) return res.status(403).json({ error: 'Account banned. Reason: ' + (user.banReason || 'Violation of terms') });
  res.json({ idToken: d.idToken, refreshToken: d.refreshToken, uid: d.localId, user });
}));

app.post('/api/auth/signin-google', wrap(async (req, res) => {
  const { idToken } = req.body || {};
  if (!idToken) return res.status(400).json({ error: 'Google idToken required.' });
  const d = await idToolkitSignInGoogle(idToken);
  let user = await getUserByUid(d.localId);
  if (!user) {
    user = await createUserRecord(d.localId, { email: d.email, name: d.displayName || 'Gojo Hunter', avatar: d.photoUrl });
  }
  if (user.isBanned) return res.status(403).json({ error: 'Account banned. Reason: ' + (user.banReason || 'Violation of terms') });
  res.json({ idToken: d.idToken, refreshToken: d.refreshToken, uid: d.localId, user });
}));

app.post('/api/auth/refresh', wrap(async (req, res) => {
  const { refreshToken } = req.body || {};
  if (!refreshToken) return res.status(400).json({ error: 'refreshToken required' });
  const d = await idToolkitRefresh(refreshToken);
  res.json(d);
}));

app.post('/api/auth/link-backup', authenticate, wrap(async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Invalid email.' });
  if (!password || password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  const h = req.headers.authorization || '';
  const token = h.slice(7);
  const d = await idToolkitLinkPassword(token, email, password);
  await setBackupEmailDoc(req.uid, email);
  res.json({ ok: true });
}));

// ---------- USER ----------
app.get('/api/user/me', authenticate, wrap(async (req, res) => {
  const u = await getUserByUid(req.uid);
  if (!u) return res.status(404).json({ error: 'User not found' });
  res.json(u);
}));

app.put('/api/user/me', authenticate, wrap(async (req, res) => {
  const { name, avatar } = req.body || {};
  const updates = {};
  if (name) updates.name = safeString(name, 60);
  if (avatar) updates.avatar = validImageUrl(avatar);
  if (!Object.keys(updates).length) return res.status(400).json({ error: 'No fields.' });
  await db().doc(`users/${req.uid}`).update(updates);
  const u = await getUserByUid(req.uid);
  res.json(u);
}));

app.put('/api/user/me/setup', authenticate, wrap(async (req, res) => {
  const { name, avatar } = req.body || {};
  if (!name) return res.status(400).json({ error: 'Name is required.' });
  await db().doc(`users/${req.uid}`).update({
    name: safeString(name, 60),
    avatar: validImageUrl(avatar),
    setupCompleted: true
  });
  const u = await getUserByUid(req.uid);
  res.json(u);
}));

app.put('/api/user/me/border', authenticate, wrap(async (req, res) => {
  const { border } = req.body || {};
  await db().doc(`users/${req.uid}`).update({ activeBorder: safeString(border || '', 200) });
  res.json({ ok: true });
}));

app.get('/api/user/me/exp-history', authenticate, wrap(async (req, res) => {
  const u = await getUserByUid(req.uid);
  res.json({ expHistory: (u && u.expHistory) || [] });
}));

app.get('/api/user/me/followers', authenticate, wrap(async (req, res) => {
  const u = await getUserByUid(req.uid);
  const ids = (u && u.followers) || [];
  const users = await Promise.all(ids.map((id) => getUserByUid(id)));
  res.json(users.filter(Boolean).map((x) => ({ uid: x.id, name: x.name, avatar: x.avatar, rank: x.rank })));
}));

app.get('/api/user/by-custom-id/:customId', authenticate, wrap(async (req, res) => {
  const u = await getUserByCustomId(safeString(req.params.customId, 20));
  if (!u) return res.status(404).json({ error: 'User not found' });
  res.json(u);
}));

app.get('/api/user/:uid', authenticate, wrap(async (req, res) => {
  const u = await getUserByUid(req.params.uid);
  if (!u) return res.status(404).json({ error: 'User not found' });
  res.json(u);
}));

app.post('/api/user/:uid/follow', authenticate, wrap(async (req, res) => {
  const r = await toggleFollow(req.uid, req.params.uid);
  res.json(r);
}));

app.post('/api/user/me/upcoming', authenticate, wrap(async (req, res) => {
  const cfg = await loadAppConfig();
  const { malId, anilistId, title, img, totalEps } = req.body || {};
  if (!malId || !title) return res.status(400).json({ error: 'malId and title required.' });
  const u = await getUserByUid(req.uid);
  const up = u.upcoming || [];
  if (up.some((x) => String(x.malId) === String(malId))) return res.status(400).json({ error: 'Already in Upcoming.' });
  if (up.length >= cfg.maxUpcoming) return res.status(400).json({ error: `Upcoming full (max ${cfg.maxUpcoming}).` });
  const ni = { malId: String(malId), anilistId: anilistId || null, title: safeString(title, 200), img: validImageUrl(img), currentEp: 0, totalEps: totalEps || 12, lastWatchedDate: '' };
  await db().doc(`users/${req.uid}`).update({ upcoming: [...up, ni] });
  res.json(ni);
}));

app.put('/api/user/me/upcoming/:malId/increment', authenticate, wrap(async (req, res) => {
  const r = await incrementEpisode(req.uid, req.params.malId);
  res.json(r);
}));

app.delete('/api/user/me/upcoming/:malId', authenticate, wrap(async (req, res) => {
  const u = await getUserByUid(req.uid);
  const up = (u.upcoming || []).filter((x) => String(x.malId) !== String(req.params.malId));
  await db().doc(`users/${req.uid}`).update({ upcoming: up });
  res.json({ ok: true });
}));

app.put('/api/user/me/prime/:malId', authenticate, wrap(async (req, res) => {
  const cfg = await loadAppConfig();
  const u = await getUserByUid(req.uid);
  const mi = String(req.params.malId);
  const anime = (u.collection || []).find((c) => String(c.malId) === mi);
  if (!anime) return res.status(400).json({ error: 'Not in collection.' });
  const prime = [...(u.prime || [])];
  const idx = prime.findIndex((p) => String(p.malId) === mi);
  if (idx > -1) prime.splice(idx, 1);
  else {
    if (prime.length >= cfg.maxPrime) return res.status(400).json({ error: `Max ${cfg.maxPrime} Prime.` });
    prime.push({ malId: mi, anilistId: anime.anilistId || null, title: anime.title, img: anime.img });
  }
  await db().doc(`users/${req.uid}`).update({ prime });
  res.json({ prime });
}));

app.put('/api/user/me/favourite/:malId', authenticate, wrap(async (req, res) => {
  const cfg = await loadAppConfig();
  const u = await getUserByUid(req.uid);
  const mi = String(req.params.malId);
  const anime = (u.collection || []).find((c) => String(c.malId) === mi);
  if (!anime) return res.status(400).json({ error: 'Not in collection.' });
  const fav = [...(u.favourite || [])];
  const idx = fav.findIndex((f) => String(f.malId) === mi);
  if (idx > -1) fav.splice(idx, 1);
  else {
    if (fav.length >= cfg.maxFavourite) return res.status(400).json({ error: `Max ${cfg.maxFavourite} Favourite.` });
    fav.push({ malId: mi, anilistId: anime.anilistId || null, title: anime.title, img: anime.img });
  }
  await db().doc(`users/${req.uid}`).update({ favourite: fav });
  res.json({ favourite: fav });
}));

app.post('/api/user/me/recalculate-rank', authenticate, wrap(async (req, res) => {
  const r = await recalculateExpAndRank(req.uid);
  res.json(r);
}));

// ---------- LEADERBOARD ----------
app.get('/api/leaderboard', authenticate, wrap(async (req, res) => {
  res.json(await getLeaderboard(10));
}));

// ---------- STORE ----------
app.get('/api/store/items', authenticate, wrap(async (req, res) => {
  res.json(await getStoreItems());
}));

app.post('/api/store/purchase/:itemId', authenticate, wrap(async (req, res) => {
  const r = await buyStoreItem(req.uid, req.params.itemId);
  res.json(r);
}));

// ---------- INBOX ----------
app.get('/api/inbox/bonus-status', authenticate, wrap(async (req, res) => {
  const cfg = await loadAppConfig();
  const u = await getUserByUid(req.uid);
  res.json({ claimed: u.lastClaim === new Date().toDateString(), amount: cfg.dailyBonus || 50 });
}));

app.post('/api/inbox/claim-daily', authenticate, wrap(async (req, res) => {
  res.json(await claimDailyBonus(req.uid));
}));

// ---------- POLLS ----------
app.get('/api/polls', authenticate, wrap(async (req, res) => {
  res.json(await listPolls(req.uid, 'all'));
}));
app.get('/api/polls/mine', authenticate, wrap(async (req, res) => {
  res.json(await listPolls(req.uid, 'mine'));
}));
app.post('/api/polls', authenticate, wrap(async (req, res) => {
  const u = await getUserByUid(req.uid);
  const poll = await createPoll(req.uid, { ...req.body, creatorName: u.name });
  res.json(poll);
}));
app.post('/api/polls/:id/answer', authenticate, wrap(async (req, res) => {
  const r = await answerPoll(req.uid, req.params.id, Number(req.body?.optionIndex));
  res.json(r);
}));
app.post('/api/polls/:id/report', authenticate, wrap(async (req, res) => {
  await reportPoll(req.uid, req.params.id);
  res.json({ ok: true });
}));

// ---------- ANIME ----------
app.get('/api/anime/trending', wrap(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const q = `query($page:Int){Page(page:$page,perPage:20){media(sort:POPULARITY_DESC,type:ANIME){id idMal title{romaji english} coverImage{large} averageScore episodes}}}`;
  const d = await anilistQuery(q, { page });
  res.json(d?.data?.Page?.media || []);
}));

app.get('/api/anime/details', wrap(async (req, res) => {
  const { id, malId } = req.query;
  const a = await fetchAnimeDetails(id, malId);
  if (!a) return res.status(404).json({ error: 'Not found' });
  res.json(a);
}));

app.get('/api/anime/search', wrap(async (req, res) => {
  const { q: text, genre, year, format, status, minScore } = req.query;
  const vars = {}; const args = ['type:ANIME', 'sort:POPULARITY_DESC']; const defs = [];
  if (text) { defs.push('$search:String'); args.push('search:$search'); vars.search = text; }
  if (genre) { defs.push('$genre:String'); args.push('genre:$genre'); vars.genre = genre; }
  if (year) { defs.push('$year:Int'); args.push('seasonYear:$year'); vars.year = parseInt(year, 10); }
  if (format) { defs.push('$format:MediaFormat'); args.push('format:$format'); vars.format = format; }
  if (status) { defs.push('$status:MediaStatus'); args.push('status:$status'); vars.status = status; }
  if (minScore) { defs.push('$score:Int'); args.push('averageScore_greater:$score'); vars.score = parseInt(minScore, 10); }
  const def = defs.length ? `query(${defs.join(',')})` : '';
  const g = `${def}{Page(page:1,perPage:50){media(${args.join(',')}){id idMal title{romaji english} coverImage{large} averageScore episodes}}}`;
  const d = await anilistQuery(g, vars);
  res.json(d?.data?.Page?.media || []);
}));

app.get('/api/anime/schedule', wrap(async (req, res) => {
  const now = new Date(); const s = new Date(now); s.setHours(0,0,0,0);
  const from = Math.floor(s.getTime() / 1000);
  const e = new Date(s); e.setDate(e.getDate() + 7);
  const to = Math.floor(e.getTime() / 1000);
  const q = `query($from:Int,$to:Int){Page(page:1,perPage:50){airingSchedules(airingAt_greater:$from,airingAt_lesser:$to,sort:TIME){airingAt episode media{id idMal title{romaji english} coverImage{large}}}}}`;
  const d = await anilistQuery(q, { from, to });
  res.json(d?.data?.Page?.airingSchedules || []);
}));

app.get('/api/anime/seasonal', wrap(async (req, res) => {
  const season = String(req.query.season || 'WINTER').toUpperCase();
  const year = parseInt(req.query.year, 10) || new Date().getFullYear();
  const q = `query($season:MediaSeason,$year:Int){Page(page:1,perPage:50){media(season:$season,seasonYear:$year,type:ANIME,sort:POPULARITY_DESC){id idMal title{romaji english} coverImage{large} averageScore episodes}}}`;
  const d = await anilistQuery(q, { season, year });
  res.json(d?.data?.Page?.media || []);
}));

// ---------- MANGA ----------
app.get('/api/manga/trending', wrap(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const r = await fetch(`https://api.mangadex.org/manga?limit=20&offset=${(page-1)*20}&includes[]=cover_art&order[followedCount]=desc`);
  const d = await r.json();
  res.json(d.data || []);
}));

app.get('/api/manga/search', wrap(async (req, res) => {
  const q = safeString(req.query.q || '', 100);
  const r = await fetch(`https://api.mangadex.org/manga?title=${encodeURIComponent(q)}&limit=20&includes[]=cover_art&order[relevance]=desc`);
  const d = await r.json();
  res.json(d.data || []);
}));

app.get('/api/manga/:id', wrap(async (req, res) => {
  const r = await fetch(`https://api.mangadex.org/manga/${encodeURIComponent(req.params.id)}`);
  const d = await r.json();
  if (!d.data) return res.status(404).json({ error: 'Not found' });
  res.json(d.data);
}));

// ---------- SCANNER ----------
app.post('/api/scanner/scan', authenticate, upload.single('image'), wrap(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Image required.' });
  const buf = req.file.buffer;
  let identified = null, confidence = 0, anilistId = null, source = '', episodeInfo = null, timestamp = null, video = null;
  try {
    const td = await traceMoeSearch(buf, req.file.originalname || 'image.jpg', req.file.mimetype || 'image/jpeg');
    if (td.result && td.result.length && td.result[0].similarity >= 0.87) {
      const m = td.result[0];
      confidence = parseFloat((m.similarity * 100).toFixed(1));
      identified = m.anilist?.title?.english || m.anilist?.title?.romaji;
      anilistId = m.anilist?.id || null;
      source = 'Official Episode Scene (Exact Match)';
      episodeInfo = m.episode !== null ? `Episode ${m.episode}` : 'Movie / Special';
      const min = Math.floor(m.from / 60), sec = Math.floor(m.from % 60);
      timestamp = `${min}m ${sec < 10 ? '0' : ''}${sec}s`;
      video = m.video || null;
    }
  } catch (_) {}

  if (!identified) {
    const base64 = buf.toString('base64');
    const prompt = `You are a strict Japanese Anime & Manga verification system.
RULES:
1. Is this genuinely a Japanese anime, manga, anime-style art, fan-art, or cosplay?
2. If it's a real photo or Western cartoon, set isAnime: false.
3. If it IS anime, identify exact title with 85%+ confidence. If unsure, set false.
4. Return JSON: {"isAnime":bool,"confidence":number,"animeTitle":string|null,"character":string|null,"rejectionReason":string|null}`;
    const gj = await geminiScan(base64, prompt);
    const txt = gj.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
    let parsed = {};
    try { parsed = JSON.parse(txt.replace(/```json|```/g, '').trim()); } catch (_) {}
    if (!parsed.isAnime || !parsed.animeTitle || (parsed.confidence && parsed.confidence < 85)) {
      return res.json({ matched: false, reason: parsed.rejectionReason || 'This image does not appear to be an anime.' });
    }
    identified = parsed.animeTitle;
    confidence = parsed.confidence ? parseFloat(parsed.confidence.toFixed(1)) : 95;
    source = parsed.character ? `Character: ${parsed.character}` : 'Official Anime Artwork';
  }

  const details = await fetchAnimeDetails(anilistId, null) || (await anilistQuery(
    `query($search:String){Media(search:$search,type:ANIME){id idMal title{romaji english} coverImage{large} averageScore episodes description genres}}`,
    { search: identified }
  ))?.data?.Media || null;

  res.json({ matched: true, identified, confidence, anilistId, source, episodeInfo, timestamp, video, details });
}));

// ---------- MUSIC ----------
app.get('/api/music/stations', authenticate, wrap(async (req, res) => {
  const data = await fetchRadioStations();
  res.json(Array.isArray(data) ? data.filter((s) => s.url_resolved && /^https?:\/\//i.test(s.url_resolved)) : []);
}));

// ---------- NEWS ----------
app.get('/api/news', wrap(async (req, res) => {
  const xml = await fetchNewsXml();
  if (!xml) return res.status(502).json({ error: 'Could not load news.' });
  res.type('text/xml').send(xml);
}));

// ---------- UPLOAD ----------
app.post('/api/upload/image', authenticate, upload.single('image'), wrap(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Image required.' });
  const j = await uploadToImgBB(req.file.buffer, req.file.mimetype || 'image/jpeg', req.file.originalname || 'avatar.jpg');
  if (!j.success) return res.status(400).json({ error: 'Upload failed.' });
  res.json({ url: j.data.url });
}));

// ---------- KITSU EPISODE TITLE ----------
app.get('/api/episode-title', authenticate, wrap(async (req, res) => {
  const t = await fetchKitsuEpisodeTitle(String(req.query.title || ''), parseInt(req.query.ep, 10));
  res.json({ title: t });
}));

// ---------- CELEBRATION ----------
app.get('/api/celebration', authenticate, wrap(async (req, res) => {
  const d = await fetchNekosCelebrate();
  res.json({ url: d?.results?.[0]?.url || null });
}));

// ---------- HEALTH ----------
app.get('/api/health', (req, res) => res.json({ ok: true, ts: Date.now() }));

// ---------- Vercel entry ----------
export default function handler(req, res) {
  restoreOriginalPath(req);
  return app(req, res);
}
import admin from 'firebase-admin';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import {
  safeString, validImageUrl, getTodayKey, isValidEmail
} from './utils.js';
import {
  anilistQuery, mangadexFetch, traceMoeIdentify, geminiVerifyAnime,
  imgbbUpload, kitsuAnimeSearch, kitsuEpisodeTitle, radioBrowserStations,
  fetchNewsRSS, nekosCelebrate
} from './api.js';

// ----- Firebase Admin init (defensive) -----
let db = null;
try {
  if (!admin.apps.length) {
    const pk = (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
    if (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_CLIENT_EMAIL && pk) {
      admin.initializeApp({
        credential: admin.credential.cert({
          projectId: process.env.FIREBASE_PROJECT_ID,
          clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
          privateKey: pk
        })
      });
    } else {
      console.error('[FIREBASE] Missing env vars: FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY');
    }
  }
  if (admin.apps.length) db = admin.firestore();
} catch (e) {
  console.error('[FIREBASE INIT FAILED]', e?.message || e);
  db = null;
}

export function isReady() { return db !== null; }

let FV = null;
try { FV = admin.firestore.FieldValue; } catch (e) { /* until init */ }

// ----- Constants -----
const DEFAULT_CONFIG = {
  dailyBonus: 50, maxUpcoming: 3, maxPrime: 3, maxFavourite: 4,
  rankThresholds: { D: 250, C: 500, B: 750, A: 1000 }
};
const MEDIA_FIELDS = 'id idMal title{romaji english} coverImage{extraLarge large} bannerImage averageScore episodes description genres externalLinks{site url type}';

// ----- JWT -----
export function signToken(user) {
  return jwt.sign({ uid: user.uid, email: user.email }, process.env.JWT_SECRET, { expiresIn: '30d' });
}
export function verifyToken(token) {
  try { return jwt.verify(token, process.env.JWT_SECRET); }
  catch (e) { return null; }
}

// ----- User helpers -----
export async function getUserByUid(uid) {
  const snap = await db.collection('users').doc(String(uid)).get();
  return snap.exists ? { uid: snap.id, ...snap.data() } : null;
}
export async function getUserByEmail(email) {
  const snap = await db.collection('users').where('email', '==', String(email).toLowerCase()).limit(1).get();
  return snap.empty ? null : { uid: snap.docs[0].id, ...snap.docs[0].data() };
}
export function publicUser(u) {
  if (!u) return null;
  const { passwordHash, ...rest } = u;
  return rest;
}

export async function loadConfig() {
  try {
    const snap = await db.collection('meta').doc('config').get();
    if (snap.exists) {
      const d = snap.data();
      return { ...DEFAULT_CONFIG, ...d, rankThresholds: { ...DEFAULT_CONFIG.rankThresholds, ...(d.rankThresholds || {}) } };
    }
  } catch (e) { /* ignore */ }
  return { ...DEFAULT_CONFIG };
}

export async function isAdminEmail(email) {
  if (!email) return false;
  try {
    const snap = await db.collection('admins').where('email', '==', String(email).toLowerCase()).limit(1).get();
    return !snap.empty;
  } catch (e) { return false; }
}

async function generateNextUID() {
  const ref = db.collection('meta').doc('uidCounter');
  return await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    let n = 1000000000;
    if (snap.exists && snap.data().current) n = snap.data().current + 1;
    tx.set(ref, { current: n }, { merge: true });
    return String(n);
  });
}

// ----- Google OAuth -----
export function buildGoogleAuthUrl(baseUrl) {
  const state = crypto.randomBytes(16).toString('hex');
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID || '',
    redirect_uri: `${baseUrl}/api/auth/google/callback`,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    prompt: 'select_account'
  });
  return { url: `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`, state };
}

export async function exchangeGoogleCode(code, baseUrl) {
  const params = new URLSearchParams({
    code,
    client_id: process.env.GOOGLE_CLIENT_ID || '',
    client_secret: process.env.GOOGLE_CLIENT_SECRET || '',
    redirect_uri: `${baseUrl}/api/auth/google/callback`,
    grant_type: 'authorization_code'
  });
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString()
  });
  const j = await r.json();
  if (!j.id_token) throw new Error('Google token exchange failed');
  // JWT uses base64url encoding
  const b64 = j.id_token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - b64.length % 4) % 4);
  const payload = JSON.parse(Buffer.from(padded, 'base64').toString('utf-8'));
  return {
    sub: payload.sub,
    email: payload.email,
    name: payload.name,
    picture: payload.picture,
    emailVerified: payload.email_verified
  };
}

export async function findOrCreateGoogleUser(g) {
  const email = (g.email || '').toLowerCase();
  if (!email) throw new Error('No email from Google');
  let user = await getUserByEmail(email);
  if (user) return { user, isNew: false };
  if (await isAdminEmail(email)) {
    const err = new Error('This account is registered as an ADMIN. Please use the admin console.');
    err.code = 'ADMIN_ACCOUNT';
    throw err;
  }
  const uid = await generateNextUID();
  const nu = {
    uid, customId: uid, email,
    backupEmail: '', passwordHash: null, googleId: g.sub,
    name: g.name || 'Gojo Hunter', avatar: validImageUrl(g.picture),
    totalExp: 0, rank: 'E', coins: 0, lastClaim: '', activeBorder: '',
    isVerified: false, isBanned: false, banReason: '',
    ownedItems: [], upcoming: [], collection: [], prime: [], favourite: [],
    followers: [], following: [], setupCompleted: false,
    expHistory: [], createdAt: new Date().toISOString()
  };
  await db.collection('users').doc(uid).set(nu);
  return { user: nu, isNew: true };
}

// ----- Backup email login -----
export async function emailLogin(email, password) {
  email = (email || '').trim().toLowerCase();
  if (!isValidEmail(email)) throw new Error('Invalid email format.');
  const snap = await db.collection('users').where('backupEmail', '==', email).limit(1).get();
  if (snap.empty) throw new Error('Incorrect email or password.');
  const u = { uid: snap.docs[0].id, ...snap.docs[0].data() };
  if (u.isBanned) throw new Error('Your account is banned.');
  if (!u.passwordHash) throw new Error('This account has no password set. Please log in with Google.');
  const ok = await bcrypt.compare(password, u.passwordHash);
  if (!ok) throw new Error('Incorrect email or password.');
  return u;
}

// ----- Setup / profile -----
export async function completeSetup(uid, name, avatar) {
  name = safeString(name, 60);
  if (!name) throw new Error('Name required.');
  const updates = { name, avatar: validImageUrl(avatar), setupCompleted: true };
  await db.collection('users').doc(uid).update(updates);
  return updates;
}

export async function updateProfile(uid, name, avatar) {
  name = safeString(name, 60);
  if (!name) throw new Error('Name required.');
  const updates = { name };
  if (avatar) updates.avatar = validImageUrl(avatar);
  await db.collection('users').doc(uid).update(updates);
  return updates;
}

// ----- Backup email link (one-time) -----
export async function linkBackupEmail(uid, email, password) {
  email = (email || '').trim().toLowerCase();
  password = password || '';
  if (!isValidEmail(email)) throw new Error('Enter a valid email.');
  if (password.length < 6) throw new Error('Password must be at least 6 characters.');
  const user = await getUserByUid(uid);
  if (!user) throw new Error('User not found.');
  if (user.backupEmail || user.passwordHash) throw new Error('Backup email is permanent and cannot be changed.');
  if (user.email === email) throw new Error('Cannot use your Google account email as backup.');
  const usedBackup = await db.collection('users').where('backupEmail', '==', email).limit(1).get();
  if (!usedBackup.empty) throw new Error('This email is already registered to another account.');
  const usedGoogle = await db.collection('users').where('email', '==', email).limit(1).get();
  if (!usedGoogle.empty) throw new Error('This email is already registered.');
  const passwordHash = await bcrypt.hash(password, 10);
  await db.collection('users').doc(uid).update({ backupEmail: email, passwordHash });
  return { backupEmail: email };
}

// ----- Change password -----
export async function changePassword(uid, currentPassword, newPassword) {
  if (!newPassword || newPassword.length < 6) throw new Error('New password must be at least 6 characters.');
  const user = await getUserByUid(uid);
  if (!user || !user.passwordHash) throw new Error('This account has no password set. Add a backup email first.');
  const ok = await bcrypt.compare(currentPassword || '', user.passwordHash);
  if (!ok) throw new Error('Current password is incorrect.');
  const hash = await bcrypt.hash(newPassword, 10);
  await db.collection('users').doc(uid).update({ passwordHash: hash });
  return true;
}

// ----- Rank -----
export function calculateRank(exp, thresholds) {
  const th = thresholds || DEFAULT_CONFIG.rankThresholds;
  if (exp >= th.A) return { rank: 'A', target: th.A };
  if (exp >= th.B) return { rank: 'B', target: th.A };
  if (exp >= th.C) return { rank: 'C', target: th.B };
  if (exp >= th.D) return { rank: 'D', target: th.C };
  return { rank: 'E', target: th.D };
}

export async function recalcRank(uid) {
  const user = await getUserByUid(uid);
  if (!user) return null;
  const config = await loadConfig();
  const { rank } = calculateRank(user.totalExp || 0, config.rankThresholds);
  if (rank !== user.rank) {
    await db.collection('users').doc(uid).update({ rank });
    return { rank, oldRank: user.rank, changed: true };
  }
  return { rank, changed: false };
}

// ----- Bank transaction helper -----
async function readBankAndAdmin(tx) {
  const bankRef = db.collection('meta').doc('bank');
  const bankSnap = await tx.get(bankRef);
  if (!bankSnap.exists) throw new Error('Bank not initialized.');
  const bank = bankSnap.data();
  if (!bank.treasuryAdminUid) throw new Error('Treasury admin missing.');
  const adminRef = db.collection('admins').doc(bank.treasuryAdminUid);
  const adminSnap = await tx.get(adminRef);
  if (!adminSnap.exists) throw new Error('Treasury admin missing.');
  return { bankRef, bank, adminRef, admin: adminSnap.data() };
}

// ----- Store buy -----
export async function buyStoreItem(uid, itemId) {
  const itemSnap = await db.collection('storeItems').doc(itemId).get();
  if (!itemSnap.exists) throw new Error('Item not found.');
  const item = { id: itemSnap.id, ...itemSnap.data() };
  if (!item.active) throw new Error('Item not available.');
  const price = Number(item.price) || 0;
  const durationDays = Number(item.durationDays) || 30;
  const expiresAt = Date.now() + durationDays * 24 * 60 * 60 * 1000;

  const result = await db.runTransaction(async (tx) => {
    const { adminRef, admin: adminData } = await readBankAndAdmin(tx);
    const userRef = db.collection('users').doc(uid);
    const userSnap = await tx.get(userRef);
    if (!userSnap.exists) throw new Error('User not found.');
    const userD = userSnap.data();
    if (userD.isBanned) throw new Error('Account banned.');
    if ((Number(userD.coins) || 0) < price) throw new Error('Insufficient coins.');

    const newUserCoins = (Number(userD.coins) || 0) - price;
    const newAdminCoins = (Number(adminData.coins) || 0) + price;
    let newOwned = (userD.ownedItems || []).filter(o => {
      if (typeof o === 'string') return true;
      return o.expiresAt > Date.now() && o.id !== item.id;
    });
    newOwned.push({ id: item.id, expiresAt });

    const upd = { coins: newUserCoins, ownedItems: newOwned };
    if ((item.type || 'border') === 'border') upd.activeBorder = item.cssClass || '';

    tx.update(userRef, upd);
    tx.update(adminRef, { coins: newAdminCoins });
    tx.set(db.collection('coinTransactions').doc(), {
      type: 'PURCHASE', from: uid, to: 'admin', amount: price,
      meta: { itemId: item.id, itemName: item.name, durationDays },
      userBalanceAfter: newUserCoins, timestamp: new Date().toISOString()
    });
    return { newCoins: newUserCoins, newOwned };
  });
  return { ...result, item, durationDays };
}

// ----- Daily claim -----
export async function claimDaily(uid) {
  const config = await loadConfig();
  const bonus = Number(config.dailyBonus) || 50;
  const today = getTodayKey();
  const result = await db.runTransaction(async (tx) => {
    const { adminRef, admin: adminData } = await readBankAndAdmin(tx);
    const userRef = db.collection('users').doc(uid);
    const userSnap = await tx.get(userRef);
    if (!userSnap.exists) throw new Error('User not found.');
    const userD = userSnap.data();
    if (userD.isBanned) throw new Error('Account banned.');
    if (userD.lastClaim === today) throw new Error('Already claimed today.');
    if ((Number(adminData.coins) || 0) < bonus) throw new Error('Admin has no coins.');
    const newCoins = (Number(userD.coins) || 0) + bonus;
    tx.update(adminRef, { coins: (Number(adminData.coins) || 0) - bonus });
    tx.update(userRef, { coins: newCoins, lastClaim: today });
    tx.set(db.collection('coinTransactions').doc(), {
      type: 'DAILY_CLAIM', from: 'admin', to: uid, amount: bonus, meta: {},
      userBalanceAfter: newCoins, timestamp: new Date().toISOString()
    });
    return { newCoins };
  });
  return { ...result, bonus, today };
}

// ----- Upcoming -----
export async function addToUpcoming(uid, item) {
  const config = await loadConfig();
  const user = await getUserByUid(uid);
  if (!user) throw new Error('User not found.');
  const malIdStr = String(item.malId);
  const up = user.upcoming || [];
  if (up.some(u => String(u.malId) === malIdStr)) throw new Error('Already in Upcoming.');
  if (up.length >= config.maxUpcoming) throw new Error(`Upcoming full (max ${config.maxUpcoming}).`);
  const ni = {
    malId: malIdStr, anilistId: item.anilistId || null,
    title: safeString(item.title, 200), img: validImageUrl(item.img),
    currentEp: 0, totalEps: Number(item.totalEps) || 12, lastWatchedDate: ''
  };
  const updated = [...up, ni];
  await db.collection('users').doc(uid).update({ upcoming: updated });
  return { upcoming: updated, item: ni };
}

export async function removeUpcoming(uid, malId) {
  const user = await getUserByUid(uid);
  if (!user) throw new Error('User not found.');
  const up = (user.upcoming || []).filter(u => String(u.malId) !== String(malId));
  await db.collection('users').doc(uid).update({ upcoming: up });
  return up;
}

export async function incrementWatching(uid, malId) {
  const today = getTodayKey();
  const result = await db.runTransaction(async (tx) => {
    const userRef = db.collection('users').doc(uid);
    const userSnap = await tx.get(userRef);
    if (!userSnap.exists) throw new Error('User not found.');
    const userD = userSnap.data();
    if (userD.isBanned) throw new Error('Account banned.');
    const liveUpcoming = [...(userD.upcoming || [])];
    const idx = liveUpcoming.findIndex(u => String(u.malId) === String(malId));
    if (idx === -1) throw new Error('Item no longer in upcoming.');
    const liveItem = { ...liveUpcoming[idx] };
    if (liveItem.lastWatchedDate === today) throw new Error('Only 1 episode per day.');
    liveItem.currentEp = (liveItem.currentEp || 0) + 1;
    liveItem.lastWatchedDate = today;
    liveUpcoming[idx] = liveItem;
    const isComplete = liveItem.currentEp >= (liveItem.totalEps || 12);

    if (!isComplete) {
      tx.update(userRef, { upcoming: liveUpcoming });
      return { completed: false };
    }

    const { adminRef, admin: adminData } = await readBankAndAdmin(tx);
    const rewardCoins = 10;
    const canPay = (Number(adminData.coins) || 0) >= rewardCoins;

    const filtered = liveUpcoming.filter(u => String(u.malId) !== String(malId));
    const cl = [...(userD.collection || [])];
    if (!cl.some(x => String(x.malId) === String(malId))) {
      cl.push({
        malId: String(liveItem.malId), anilistId: liveItem.anilistId || null,
        title: liveItem.title, img: liveItem.img
      });
    }

    const newTotalExp = (Number(userD.totalExp) || 0) + 50;
    const newExpHistory = [...(userD.expHistory || []),
      { amount: 50, reason: `Completed ${liveItem.title}`, date: new Date().toISOString() }];
    const upd = { upcoming: filtered, collection: cl, totalExp: newTotalExp, expHistory: newExpHistory };
    if (canPay) upd.coins = (Number(userD.coins) || 0) + rewardCoins;
    tx.update(userRef, upd);

    if (canPay) {
      tx.update(adminRef, { coins: (Number(adminData.coins) || 0) - rewardCoins });
      tx.set(db.collection('coinTransactions').doc(), {
        type: 'ANIME_COMPLETE', from: 'admin', to: uid, amount: rewardCoins,
        meta: { animeId: liveItem.malId, animeTitle: liveItem.title },
        userBalanceAfter: (Number(userD.coins) || 0) + rewardCoins, timestamp: new Date().toISOString()
      });
    }
    return {
      completed: true, title: liveItem.title,
      newCoins: canPay ? (Number(userD.coins) || 0) + rewardCoins : (Number(userD.coins) || 0),
      newTotalExp, coinsPaid: canPay
    };
  });
  if (result.completed) await recalcRank(uid);
  return result;
}

// ----- Prime / Favourite slots -----
export async function toggleSlot(uid, slot, malId) {
  if (!['prime', 'favourite'].includes(slot)) throw new Error('Invalid slot.');
  const config = await loadConfig();
  const user = await getUserByUid(uid);
  if (!user) throw new Error('User not found.');
  const arr = [...(user[slot] || [])];
  const anime = (user.collection || []).find(c => String(c.malId) === String(malId));
  if (!anime) throw new Error('Anime not in collection.');
  const idx = arr.findIndex(p => String(p.malId) === String(malId));
  if (idx > -1) arr.splice(idx, 1);
  else {
    const max = slot === 'prime' ? config.maxPrime : config.maxFavourite;
    if (arr.length >= max) throw new Error(`Max ${max} ${slot}.`);
    arr.push({
      malId: String(malId), anilistId: anime.anilistId || null,
      title: anime.title, img: anime.img
    });
  }
  await db.collection('users').doc(uid).update({ [slot]: arr });
  return arr;
}

// ----- Follow -----
export async function toggleFollow(uid, targetUid) {
  if (uid === targetUid) throw new Error('Cannot follow yourself.');
  const result = await db.runTransaction(async (tx) => {
    const mr = db.collection('users').doc(uid);
    const tr = db.collection('users').doc(targetUid);
    const ms = await tx.get(mr);
    const ts = await tx.get(tr);
    if (!ms.exists || !ts.exists) throw new Error('User not found');
    const mf = ms.data().following || [];
    const isFollowing = mf.includes(targetUid);
    if (isFollowing) {
      tx.update(mr, { following: FV.arrayRemove(targetUid) });
      tx.update(tr, { followers: FV.arrayRemove(uid) });
    } else {
      tx.update(mr, { following: FV.arrayUnion(targetUid) });
      tx.update(tr, { followers: FV.arrayUnion(uid) });
    }
    return { following: !isFollowing };
  });
  return result;
}

export async function getLeaderboard() {
  const snap = await db.collection('users').orderBy('totalExp', 'desc').limit(10).get();
  return snap.docs.map(d => {
    const u = d.data();
    return {
      uid: d.id, name: u.name || '', avatar: u.avatar || '',
      rank: u.rank || 'E', totalExp: u.totalExp || 0, isVerified: u.isVerified || false
    };
  });
}

export async function getPublicUser(uid) {
  const user = await getUserByUid(uid);
  if (!user) return null;
  return {
    uid: user.uid, customId: user.customId, name: user.name, avatar: user.avatar,
    rank: user.rank, totalExp: user.totalExp, isVerified: user.isVerified,
    activeBorder: user.activeBorder, followers: user.followers || [],
    collection: user.collection || [], prime: user.prime || [],
    favourite: user.favourite || [], upcoming: user.upcoming || []
  };
}

export async function getFollowers(uid) {
  const user = await getUserByUid(uid);
  if (!user) return [];
  const ids = user.followers || [];
  if (ids.length === 0) return [];
  const results = [];
  for (const id of ids) {
    const u = await getUserByUid(id);
    if (u) results.push({ uid: u.uid, name: u.name, avatar: u.avatar, rank: u.rank });
  }
  return results;
}

// ----- Polls -----
export async function listPolls(viewerUid) {
  const snap = await db.collection('polls').get();
  return snap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .filter(p => p.creatorId !== viewerUid);
}
export async function myPolls(uid) {
  const snap = await db.collection('polls').where('creatorId', '==', uid).get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}
export async function createPoll(uid, data) {
  const animeTitle = safeString(data.animeTitle, 100);
  const question = safeString(data.question, 300);
  const options = (data.options || []).map(o => safeString(o, 150));
  const correctIndex = Number(data.correctIndex);
  if (!animeTitle) throw new Error('Enter anime name.');
  if (!question || options.length !== 4 || options.some(o => !o)) throw new Error('Fill all fields.');
  if (isNaN(correctIndex) || correctIndex < 0 || correctIndex > 3) throw new Error('Select correct answer.');
  const user = await getUserByUid(uid);
  const doc = await db.collection('polls').add({
    animeId: '', animeTitle, question, options, correctIndex,
    creatorId: uid, creatorName: user.name || '', voters: [], flags: [],
    createdAt: new Date().toISOString()
  });
  return { id: doc.id };
}

export async function answerPoll(uid, pollId, selIndex) {
  selIndex = Number(selIndex);
  const pollRef = db.collection('polls').doc(pollId);
  const userRef = db.collection('users').doc(uid);
  const result = await db.runTransaction(async (tx) => {
    const ps = await tx.get(pollRef);
    if (!ps.exists) throw new Error('Poll gone.');
    const poll = ps.data();
    if (poll.creatorId === uid) throw new Error('Cannot answer own.');
    if ((poll.voters || []).includes(uid)) throw new Error('Already answered.');
    if (selIndex < 0 || selIndex >= (poll.options || []).length) throw new Error('Invalid option.');
    const correct = Number(selIndex) === Number(poll.correctIndex);
    const userSnap = await tx.get(userRef);
    if (!userSnap.exists) throw new Error('User not found.');
    const userD = userSnap.data();
    let adminRef = null, adminData = null;
    if (correct) {
      const bankRef = db.collection('meta').doc('bank');
      const bankSnap = await tx.get(bankRef);
      if (bankSnap.exists) {
        const bank = bankSnap.data();
        if (bank.treasuryAdminUid) {
          adminRef = db.collection('admins').doc(bank.treasuryAdminUid);
          const aSnap = await tx.get(adminRef);
          if (aSnap.exists) adminData = aSnap.data();
        }
      }
    }
    tx.update(pollRef, { voters: FV.arrayUnion(uid) });
    if (poll.creatorId) {
      tx.update(db.collection('users').doc(poll.creatorId), { totalExp: FV.increment(15) });
    }
    let awarded = { exp: 0, coins: 0 };
    if (correct && adminData && (Number(adminData.coins) || 0) >= 5) {
      tx.update(adminRef, { coins: (Number(adminData.coins) || 0) - 5 });
      const newExpHistory = [...(userD.expHistory || []),
        { amount: 10, reason: 'Correct poll answer', date: new Date().toISOString() }];
      tx.update(userRef, {
        totalExp: (Number(userD.totalExp) || 0) + 10,
        coins: (Number(userD.coins) || 0) + 5,
        expHistory: newExpHistory
      });
      tx.set(db.collection('coinTransactions').doc(), {
        type: 'POLL_REWARD', from: 'admin', to: uid, amount: 5, meta: { pollId },
        userBalanceAfter: (Number(userD.coins) || 0) + 5, timestamp: new Date().toISOString()
      });
      awarded = { exp: 10, coins: 5 };
    }
    return { correct, awarded };
  });
  await recalcRank(uid);
  return result;
}

export async function reportPoll(uid, pollId) {
  await db.collection('polls').doc(pollId).update({ flags: FV.arrayUnion(uid) });
  return true;
}

// ----- Anime / Manga proxy -----
export async function getTrendingAnime(page = 1) {
  const q = 'query($page:Int){Page(page:$page,perPage:20){media(sort:POPULARITY_DESC,type:ANIME){id idMal title{romaji english} coverImage{large} averageScore episodes}}}';
  return await anilistQuery(q, { page });
}
export async function searchAnime(params) {
  const vars = {};
  const parts = ['type:ANIME', 'sort:POPULARITY_DESC'];
  const defs = [];
  if (params.q) { vars.search = params.q; defs.push('$search:String'); parts.push('search:$search'); }
  if (params.genre) { vars.genre = params.genre; defs.push('$genre:String'); parts.push('genre:$genre'); }
  if (params.year) { vars.year = Number(params.year); defs.push('$year:Int'); parts.push('seasonYear:$year'); }
  if (params.format) { vars.format = params.format; defs.push('$format:MediaFormat'); parts.push('format:$format'); }
  if (params.status) { vars.status = params.status; defs.push('$status:MediaStatus'); parts.push('status:$status'); }
  if (params.score) { vars.score = Number(params.score); defs.push('$score:Int'); parts.push('averageScore_greater:$score'); }
  const defStr = defs.length ? `query(${defs.join(',')})` : '';
  const q = `${defStr}{Page(page:1,perPage:50){media(${parts.join(',')}){id idMal title{romaji english} coverImage{large} averageScore episodes}}}`;
  return await anilistQuery(q, vars);
}
export async function getAnimeDetails(anilistId, malId) {
  const iv = (id) => id && /^\d+$/.test(String(id));
  let q, v;
  if (iv(anilistId)) { q = `query($id:Int){Media(id:$id,type:ANIME){${MEDIA_FIELDS}}}`; v = { id: parseInt(anilistId, 10) }; }
  else if (iv(malId)) { q = `query($malId:Int){Media(idMal:$malId,type:ANIME){${MEDIA_FIELDS}}}`; v = { malId: parseInt(malId, 10) }; }
  else return null;
  const d = await anilistQuery(q, v);
  return d?.data?.Media || null;
}
export async function getSeasonal(season, year) {
  const q = 'query($season:MediaSeason,$year:Int){Page(page:1,perPage:50){media(season:$season,seasonYear:$year,type:ANIME,sort:POPULARITY_DESC){id idMal title{romaji english} coverImage{large} averageScore episodes}}}';
  return await anilistQuery(q, { season, year: Number(year) });
}
export async function getSchedule(from, to) {
  const q = 'query($from:Int,$to:Int){Page(page:1,perPage:50){airingSchedules(airingAt_greater:$from,airingAt_lesser:$to,sort:TIME){airingAt episode media{id idMal title{romaji english} coverImage{large}}}}}';
  return await anilistQuery(q, { from: Number(from), to: Number(to) });
}
export async function getTrendingManga(page = 1) {
  const offset = (page - 1) * 20;
  return await mangadexFetch(`/manga?limit=20&offset=${offset}&includes[]=cover_art&order[followedCount]=desc`);
}
export async function searchManga(text) {
  return await mangadexFetch(`/manga?title=${encodeURIComponent(text)}&limit=20&includes[]=cover_art&order[relevance]=desc`);
}
export async function getMangaDetails(id) {
  return await mangadexFetch(`/manga/${encodeURIComponent(id)}`);
}
export async function fetchEpisodeTitle(title, epNum) {
  try {
    const sr = await kitsuAnimeSearch(title);
    if (sr.data && sr.data.length > 0) {
      const ki = sr.data[0].id;
      const er = await kitsuEpisodeTitle(ki, epNum);
      if (er.data && er.data.length > 0 && er.data[0].attributes?.canonicalTitle) {
        return er.data[0].attributes.canonicalTitle;
      }
    }
  } catch (e) { /* ignore */ }
  return `Episode ${epNum}`;
}

// ----- Scanner -----
export async function identifyAnime(base64Jpeg) {
  let identifiedTitle = null, confidence = 0, anilistId = null;
  let source = '', episode = null, timestamp = null, videoUrl = null, character = null;

  try {
    const tr = await traceMoeIdentify(base64Jpeg);
    if (tr.result && tr.result.length > 0 && tr.result[0].similarity >= 0.87) {
      const m = tr.result[0];
      confidence = parseFloat((m.similarity * 100).toFixed(1));
      identifiedTitle = m.anilist?.title?.english || m.anilist?.title?.romaji;
      anilistId = m.anilist?.id || null;
      source = 'Official Episode Scene (Exact Match)';
      episode = (m.episode !== null && m.episode !== undefined) ? `Episode ${m.episode}` : 'Movie or Special';
      const min = Math.floor(m.from / 60);
      const sec = Math.floor(m.from % 60);
      timestamp = `${min}m ${sec < 10 ? '0' : ''}${sec}s`;
      videoUrl = m.video || null;
    }
  } catch (e) { /* ignore */ }

  if (!identifiedTitle) {
    try {
      const gj = await geminiVerifyAnime(base64Jpeg);
      const to = gj.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
      const clean = JSON.parse(String(to).replace(/```json|```/g, '').trim());
      if (!clean.isAnime || !clean.animeTitle || (clean.confidence && clean.confidence < 85)) {
        return { rejected: true, reason: clean.rejectionReason || 'This image does not appear to be anime.' };
      }
      identifiedTitle = clean.animeTitle;
      confidence = clean.confidence ? parseFloat(clean.confidence.toFixed(1)) : 95.0;
      source = clean.character ? `Character: ${clean.character}` : 'Official Anime Artwork';
      character = clean.character || null;
    } catch (e) {
      return { rejected: true, reason: 'Could not verify this image. Try a clear anime screenshot.' };
    }
  }

  let anime = null;
  try {
    if (anilistId) anime = await getAnimeDetails(anilistId, null);
    if (!anime && identifiedTitle) {
      const q = `query($search:String){Media(search:$search,type:ANIME){${MEDIA_FIELDS}}}`;
      const d = await anilistQuery(q, { search: identifiedTitle });
      anime = d?.data?.Media || null;
    }
  } catch (e) { /* ignore */ }

  return {
    rejected: false,
    confidence, identifiedTitle, source, episode, timestamp, videoUrl, character,
    anime: anime ? {
      id: anime.id, idMal: anime.idMal,
      title: anime.title?.english || anime.title?.romaji || identifiedTitle,
      coverImage: anime.coverImage?.large || '',
      averageScore: anime.averageScore,
      episodes: anime.episodes,
      description: anime.description ? String(anime.description).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim() : '',
      genres: anime.genres || []
    } : null
  };
}

// ----- Store, News, Music -----
export async function getStoreItems() {
  const snap = await db.collection('storeItems').where('active', '==', true).get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}
export async function getNews() {
  const xml = await fetchNewsRSS();
  if (!xml) return [];
  const items = [];
  const re = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const block = m[1];
    const get = (tag) => {
      const r = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`);
      const mm = block.match(r);
      return mm ? mm[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim() : '';
    };
    items.push({ title: get('title'), link: get('link'), description: get('description'), pubDate: get('pubDate') });
    if (items.length >= 25) break;
  }
  return items;
}
export async function getMusicStations() {
  const data = await radioBrowserStations();
  return Array.isArray(data) ? data.filter(s => s.url_resolved && /^https?:\/\//i.test(s.url_resolved)) : [];
}
export async function uploadAvatar(base64Image) {
  const clean = String(base64Image || '').replace(/^data:image\/\w+;base64,/, '');
  if (!clean) throw new Error('No image data');
  const res = await imgbbUpload(clean);
  if (!res.success) throw new Error('Upload failed');
  return { url: res.data.url };
}
export async function celebrate() {
  try { return await nekosCelebrate(); }
  catch (e) { return null; }
}

export default function handler(req, res) {
  res.status(404).json({ error: 'Not found' });
}

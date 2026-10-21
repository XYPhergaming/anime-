import admin from 'firebase-admin';
import {
  getTodayKey, safeString, validImageUrl, safeId, sanitizeCSS, getFriendlyError
} from './utils.js';

const DEFAULT_CONFIG = {
  dailyBonus: 50, maxUpcoming: 3, maxPrime: 3, maxFavourite: 4,
  rankThresholds: { D: 250, C: 500, B: 750, A: 1000 }
};

// ---------- Firebase Admin init ----------
let _adminInitialized = false;
export function initAdmin() {
  if (_adminInitialized) return;
  if (!admin.apps.length) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON not set');
    const creds = JSON.parse(raw);
    admin.initializeApp({ credential: admin.credential.cert(creds) });
  }
  _adminInitialized = true;
}
export const db = () => { initAdmin(); return admin.firestore(); };
export const authAdmin = () => { initAdmin(); return admin.auth(); };

// ---------- App config ----------
let _cfgCache = null, _cfgTs = 0;
export async function loadAppConfig() {
  if (_cfgCache && Date.now() - _cfgTs < 60_000) return _cfgCache;
  try {
    const snap = await db().doc('meta/config').get();
    if (snap.exists) {
      const d = snap.data();
      _cfgCache = { ...DEFAULT_CONFIG, ...d, rankThresholds: { ...DEFAULT_CONFIG.rankThresholds, ...(d.rankThresholds || {}) } };
    } else _cfgCache = { ...DEFAULT_CONFIG };
  } catch (_) { _cfgCache = { ...DEFAULT_CONFIG }; }
  _cfgTs = Date.now();
  return _cfgCache;
}

// ---------- Rank ----------
export function calculateRank(exp, thresholds) {
  const th = thresholds || DEFAULT_CONFIG.rankThresholds;
  if (exp >= th.A) return { rank: 'A', target: th.A };
  if (exp >= th.B) return { rank: 'B', target: th.A };
  if (exp >= th.C) return { rank: 'C', target: th.B };
  if (exp >= th.D) return { rank: 'D', target: th.C };
  return { rank: 'E', target: th.D };
}

export async function recalculateExpAndRank(uid) {
  const cfg = await loadAppConfig();
  const ref = db().doc(`users/${uid}`);
  const snap = await ref.get();
  if (!snap.exists) return;
  const u = snap.data();
  const exp = Number(u.totalExp) || 0;
  const { rank } = calculateRank(exp, cfg.rankThresholds);
  if (u.rank !== rank) await ref.update({ rank });
  return { totalExp: exp, rank };
}

// ---------- UID ----------
export async function generateNextUID() {
  const cr = db().doc('meta/uidCounter');
  return await db().runTransaction(async (tx) => {
    const snap = await tx.get(cr);
    let n = 1000000000;
    if (snap.exists && snap.data().current) n = snap.data().current + 1;
    tx.set(cr, { current: n }, { merge: true });
    return String(n);
  });
}

// ---------- Bank helpers ----------
async function getBankAndAdmin(tx) {
  const bankRef = db().doc('meta/bank');
  const bankSnap = await tx.get(bankRef);
  if (!bankSnap.exists) throw new Error('Bank not initialized.');
  const bank = bankSnap.data();
  const adminRef = db().doc(`admins/${bank.treasuryAdminUid}`);
  const adminSnap = await tx.get(adminRef);
  if (!adminSnap.exists) throw new Error('Treasury admin missing.');
  return { bankRef, bank, adminRef, admin: adminSnap.data() };
}

// ---------- User creation ----------
export async function createUserRecord(uid, { email, name, avatar }) {
  const customId = await generateNextUID();
  const nu = {
    uid, customId,
    email: email || '', backupEmail: '',
    name: name || 'Gojo Hunter',
    avatar: validImageUrl(avatar),
    totalExp: 0, rank: 'E', coins: 0, lastClaim: '', activeBorder: '',
    isVerified: false, isBanned: false, ownedItems: [],
    upcoming: [], collection: [], prime: [], favourite: [],
    followers: [], following: [], setupCompleted: false,
    createdAt: new Date().toISOString()
  };
  await db().doc(`users/${uid}`).set(nu);
  return nu;
}

// ---------- Sanitize user data ----------
export async function sanitizeUserData(uid) {
  const ref = db().doc(`users/${uid}`);
  const snap = await ref.get();
  if (!snap.exists) return null;
  const u = snap.data();
  let changed = false;
  let maxCap = 1e9;
  try {
    const bankSnap = await db().doc('meta/bank').get();
    if (bankSnap.exists) maxCap = Number(bankSnap.data().totalSupply) || maxCap;
  } catch (_) {}

  const rawCoins = Number(u.coins);
  let safeCoins = rawCoins;
  if (!isFinite(rawCoins) || rawCoins < 0 || rawCoins > maxCap) {
    safeCoins = Math.max(0, Math.min(maxCap, isFinite(rawCoins) ? rawCoins : 0));
    changed = true;
  }

  const fv = (arr) => {
    if (!Array.isArray(arr)) return [];
    const m = new Map();
    arr.forEach((it) => {
      if (it && it.malId && String(it.malId).trim() !== '' && String(it.malId) !== 'undefined')
        m.set(String(it.malId), it);
    });
    return Array.from(m.values());
  };

  const collection = fv(u.collection || []);
  const prime = fv(u.prime || []);
  const favourite = fv(u.favourite || []);
  const cids = new Set(collection.map((c) => String(c.malId)));
  const upcoming = fv(u.upcoming || []).filter((up) => {
    const fin = (up.currentEp || 0) >= (up.totalEps || 12);
    const inc = cids.has(String(up.malId));
    if (fin && !inc) { collection.push({ malId: String(up.malId), anilistId: up.anilistId || null, title: up.title, img: up.img }); cids.add(String(up.malId)); return false; }
    return !fin && !inc;
  });

  const updates = {};
  if (changed) updates.coins = safeCoins;
  if (JSON.stringify(u.collection || []) !== JSON.stringify(collection)) updates.collection = collection;
  if (JSON.stringify(u.upcoming || []) !== JSON.stringify(upcoming)) updates.upcoming = upcoming;
  if (JSON.stringify(u.prime || []) !== JSON.stringify(prime)) updates.prime = prime;
  if (JSON.stringify(u.favourite || []) !== JSON.stringify(favourite)) updates.favourite = favourite;

  if (Object.keys(updates).length) await ref.update(updates);
  return { ...u, ...updates };
}

// ---------- Store ----------
export async function getStoreItems() {
  const snap = await db().collection('storeItems').where('active', '==', true).get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

export async function buyStoreItem(uid, itemId) {
  const cfg = await loadAppConfig();
  const itemSnap = await db().doc(`storeItems/${itemId}`).get();
  if (!itemSnap.exists) throw new Error('Item not found.');
  const item = { id: itemSnap.id, ...itemSnap.data() };
  if (!item.active) throw new Error('Item not available.');
  const durationDays = item.durationDays || 30;
  const expiresAt = Date.now() + durationDays * 86400 * 1000;

  return await db().runTransaction(async (tx) => {
    const { adminRef, admin } = await getBankAndAdmin(tx);
    const userRef = db().doc(`users/${uid}`);
    const userSnap = await tx.get(userRef);
    if (!userSnap.exists) throw new Error('User not found.');
    const userD = userSnap.data();
    if (userD.isBanned) throw new Error('Account banned.');
    if ((Number(userD.coins) || 0) < item.price) throw new Error('Insufficient coins.');

    const newUserCoins = (Number(userD.coins) || 0) - item.price;
    const newAdminCoins = (Number(admin.coins) || 0) + item.price;

    let newOwned = (userD.ownedItems || []).filter((o) => {
      if (typeof o === 'string') return true;
      return o.expiresAt > Date.now() && o.id !== item.id;
    });
    newOwned.push({ id: item.id, expiresAt });

    const upd = { coins: newUserCoins, ownedItems: newOwned };
    if ((item.type || 'border') === 'border') upd.activeBorder = item.cssClass;

    tx.update(userRef, upd);
    tx.update(adminRef, { coins: newAdminCoins });
    tx.set(db().collection('coinTransactions').doc(), {
      type: 'PURCHASE', from: uid, to: 'admin', amount: item.price,
      meta: { itemId: item.id, itemName: item.name, durationDays },
      userBalanceAfter: newUserCoins, timestamp: admin_fs_ts()
    });
    return { newCoins: newUserCoins, activeBorder: upd.activeBorder || userD.activeBorder || '', ownedItems: newOwned };
  });
}

function admin_fs_ts() { return admin.firestore.FieldValue.serverTimestamp(); }
const inc = (n) => admin.firestore.FieldValue.increment(n);
const arrUnion = (x) => admin.firestore.FieldValue.arrayUnion(x);
const arrRemove = (x) => admin.firestore.FieldValue.arrayRemove(x);

// ---------- Daily bonus ----------
export async function claimDailyBonus(uid) {
  const cfg = await loadAppConfig();
  const today = getTodayKey();
  const bonusAmount = Number(cfg.dailyBonus) || 50;
  return await db().runTransaction(async (tx) => {
    const { adminRef, admin } = await getBankAndAdmin(tx);
    const userRef = db().doc(`users/${uid}`);
    const userSnap = await tx.get(userRef);
    if (!userSnap.exists) throw new Error('User not found.');
    const userD = userSnap.data();
    if (userD.isBanned) throw new Error('Account banned.');
    if (userD.lastClaim === today) throw new Error('Already claimed today.');
    if ((Number(admin.coins) || 0) < bonusAmount) throw new Error('Admin has no coins. Wait for admin to withdraw from bank.');

    tx.update(adminRef, { coins: (Number(admin.coins) || 0) - bonusAmount });
    const newCoins = (Number(userD.coins) || 0) + bonusAmount;
    tx.update(userRef, { coins: newCoins, lastClaim: today });
    tx.set(db().collection('coinTransactions').doc(), {
      type: 'DAILY_CLAIM', from: 'admin', to: uid, amount: bonusAmount, meta: {},
      userBalanceAfter: newCoins, timestamp: admin_fs_ts()
    });
    return { newCoins, amount: bonusAmount };
  });
}

// ---------- Episode increment ----------
export async function incrementEpisode(uid, malId) {
  const td = getTodayKey();
  const cfg = await loadAppConfig();
  return await db().runTransaction(async (tx) => {
    const userRef = db().doc(`users/${uid}`);
    const userSnap = await tx.get(userRef);
    if (!userSnap.exists) throw new Error('User not found.');
    const userD = userSnap.data();
    if (userD.isBanned) throw new Error('Account banned.');

    const liveUpcoming = [...(userD.upcoming || [])];
    const idx = liveUpcoming.findIndex((u) => String(u.malId) === String(malId));
    if (idx === -1) throw new Error('Item no longer in upcoming.');
    const item = { ...liveUpcoming[idx] };
    if (item.lastWatchedDate === td) throw new Error('Only 1 episode per day.');
    item.currentEp = (item.currentEp || 0) + 1;
    item.lastWatchedDate = td;
    liveUpcoming[idx] = item;

    const isComplete = item.currentEp >= (item.totalEps || 12);
    if (!isComplete) {
      tx.update(userRef, { upcoming: liveUpcoming });
      return { completed: false, newEp: item.currentEp };
    }

    const { adminRef, admin } = await getBankAndAdmin(tx);
    const rewardCoins = 10;
    const canPay = (Number(admin.coins) || 0) >= rewardCoins;

    const filtered = liveUpcoming.filter((u) => String(u.malId) !== String(malId));
    let cl = [...(userD.collection || [])];
    if (!cl.some((x) => String(x.malId) === String(malId)))
      cl.push({ malId: String(item.malId), anilistId: item.anilistId || null, title: item.title, img: item.img });

    const userUpdate = {
      upcoming: filtered, collection: cl,
      totalExp: inc(50),
      expHistory: arrUnion({ amount: 50, reason: `Completed ${item.title}`, date: new Date().toISOString() })
    };
    if (canPay) userUpdate.coins = inc(rewardCoins);
    tx.update(userRef, userUpdate);

    if (canPay) {
      tx.update(adminRef, { coins: (Number(admin.coins) || 0) - rewardCoins });
      tx.set(db().collection('coinTransactions').doc(), {
        type: 'ANIME_COMPLETE', from: 'admin', to: uid, amount: rewardCoins,
        meta: { animeId: item.malId, animeTitle: item.title },
        userBalanceAfter: (Number(userD.coins) || 0) + rewardCoins, timestamp: admin_fs_ts()
      });
    }

    return {
      completed: true, title: item.title,
      newCoins: canPay ? (Number(userD.coins) || 0) + rewardCoins : (Number(userD.coins) || 0),
      newTotalExp: (Number(userD.totalExp) || 0) + 50,
      coinsPaid: canPay
    };
  });
}

// ---------- Follow ----------
export async function toggleFollow(uid, targetUid) {
  if (uid === targetUid) throw new Error('Cannot follow yourself.');
  return await db().runTransaction(async (tx) => {
    const mr = db().doc(`users/${uid}`), tr = db().doc(`users/${targetUid}`);
    const ms = await tx.get(mr), ts = await tx.get(tr);
    if (!ms.exists || !ts.exists) throw new Error('User not found');
    const following = ms.data().following || [];
    const isFollowing = following.includes(targetUid);
    if (isFollowing) {
      tx.update(mr, { following: arrRemove(targetUid) });
      tx.update(tr, { followers: arrRemove(uid) });
    } else {
      tx.update(mr, { following: arrUnion(targetUid) });
      tx.update(tr, { followers: arrUnion(uid) });
    }
    return { following: !isFollowing };
  });
}

// ---------- Polls ----------
export async function answerPoll(uid, pollId, optionIndex) {
  const pr = db().doc(`polls/${pollId}`);
  const ur = db().doc(`users/${uid}`);
  return await db().runTransaction(async (tx) => {
    const ps = await tx.get(pr);
    if (!ps.exists) throw new Error('Poll gone.');
    const poll = ps.data();
    if (poll.creatorId === uid) throw new Error('Cannot answer own.');
    if ((poll.voters || []).includes(uid)) throw new Error('Already answered.');
    if (optionIndex < 0 || optionIndex >= (poll.options || []).length) throw new Error('Invalid option.');
    const ok = Number(optionIndex) === Number(poll.correctIndex);

    const userSnap = await tx.get(ur);
    if (!userSnap.exists) throw new Error('User not found.');
    const userD = userSnap.data();

    let adminRef = null, admin = null;
    if (ok) { const r = await getBankAndAdmin(tx); adminRef = r.adminRef; admin = r.admin; }

    tx.update(pr, { voters: arrUnion(uid) });
    if (poll.creatorId && poll.creatorId !== uid) {
      tx.update(db().doc(`users/${poll.creatorId}`), { totalExp: inc(15) });
    }

    let awarded = { exp: 0, coins: 0 };
    if (ok && admin && (Number(admin.coins) || 0) >= 5) {
      tx.update(adminRef, { coins: (Number(admin.coins) || 0) - 5 });
      tx.update(ur, {
        totalExp: inc(10), coins: inc(5),
        expHistory: arrUnion({ amount: 10, reason: 'Correct poll answer', date: new Date().toISOString() })
      });
      tx.set(db().collection('coinTransactions').doc(), {
        type: 'POLL_REWARD', from: 'admin', to: uid, amount: 5, meta: { pollId },
        userBalanceAfter: (Number(userD.coins) || 0) + 5, timestamp: admin_fs_ts()
      });
      awarded = { exp: 10, coins: 5 };
    }
    return { ok, awarded };
  });
}

export async function createPoll(uid, payload) {
  const poll = {
    animeId: '',
    animeTitle: safeString(payload.animeTitle, 100),
    question: safeString(payload.question, 300),
    options: (payload.options || []).map((o) => safeString(o, 150)).filter(Boolean),
    correctIndex: Number(payload.correctIndex),
    creatorId: uid,
    creatorName: safeString(payload.creatorName, 60),
    voters: [], flags: [],
    createdAt: new Date().toISOString()
  };
  if (!poll.animeTitle) throw new Error('Anime name required.');
  if (!poll.question) throw new Error('Question required.');
  if (poll.options.length !== 4 || poll.options.some((o) => !o)) throw new Error('All 4 options required.');
  if (isNaN(poll.correctIndex) || poll.correctIndex < 0 || poll.correctIndex > 3) throw new Error('Invalid correct index.');
  const r = await db().collection('polls').add(poll);
  return { id: r.id, ...poll };
}

export async function reportPoll(uid, pollId) {
  await db().doc(`polls/${pollId}`).update({ flags: arrUnion(uid) });
}

export async function listPolls(uid, mode) {
  let q;
  if (mode === 'mine') q = db().collection('polls').where('creatorId', '==', uid);
  else q = db().collection('polls');
  const snap = await q.get();
  let list = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  if (mode !== 'mine') list = list.filter((p) => p.creatorId !== uid);
  return list;
}

// ---------- Leaderboard ----------
export async function getLeaderboard(limitN = 10) {
  const snap = await db().collection('users').orderBy('totalExp', 'desc').limit(limitN).get();
  return snap.docs.map((d, i) => {
    const u = d.data();
    return { rank: i + 1, uid: d.id, name: u.name, avatar: u.avatar, userRank: u.rank || 'E', totalExp: u.totalExp || 0 };
  });
}

// ---------- Backup email (one-time) ----------
export async function setBackupEmailDoc(uid, email) {
  const ref = db().doc(`users/${uid}`);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('User not found.');
  const d = snap.data();
  if ((d.backupEmail || '').trim()) throw new Error('Backup email is permanent and cannot be changed.');
  await ref.update({ backupEmail: email });
}

// ---------- Auth helpers ----------
export async function verifyToken(idToken) {
  return await authAdmin().verifyIdToken(idToken);
}

export async function getUserByUid(uid) {
  const snap = await db().doc(`users/${uid}`).get();
  if (!snap.exists) return null;
  return { id: snap.id, ...snap.data() };
}

export async function getUserByCustomId(customId) {
  const snap = await db().collection('users').where('customId', '==', customId).limit(1).get();
  if (snap.empty) return null;
  const d = snap.docs[0];
  return { id: d.id, ...d.data() };
}
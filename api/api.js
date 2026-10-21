import fetch from 'node-fetch';

export const ANILIST_URL = process.env.ANILIST_GRAPHQL || 'https://graphql.anilist.co';
export const MANGADEX_URL = process.env.MANGADEX_API || 'https://api.mangadex.org';
export const MANGADEX_COVERS = process.env.MANGADEX_COVERS || 'https://uploads.mangadex.org';
export const TRACEMOE_URL = process.env.TRACEMOE_API || 'https://api.trace.moe';
export const KITSU_URL = process.env.KITSU_API || 'https://kitsu.io/api/edge';
export const RADIO_URL = process.env.RADIO_BROWSER_API || 'https://de1.api.radio-browser.info';
export const NEKOS_URL = process.env.NEKOS_BEST_API || 'https://nekos.best/api/v2';
export const NEWS_RSS = process.env.ANIME_NEWS_RSS || 'https://www.animenewsnetwork.com/all/rss.xml';
export const IMGBB_KEY = process.env.IMGBB_KEY;
export const GEMINI_KEY = process.env.GEMINI_KEY;

export const MEDIA_FIELDS = `id idMal title{romaji english} coverImage{extraLarge large} bannerImage averageScore episodes description genres externalLinks{site url type}`;

export async function anilistQuery(query, variables) {
  const r = await fetch(ANILIST_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({ query, variables })
  });
  const data = await r.json();
  return data;
}

export async function fetchAnimeDetails(anilistId, malId) {
  const iv = (id) => id && String(id) !== '0' && String(id) !== 'undefined' && String(id) !== '' && /^\d+$/.test(String(id));
  const im = (id) => id && String(id) !== '0' && /^\d+$/.test(String(id));
  let q, v;
  if (iv(anilistId)) { q = `query($id:Int){Media(id:$id,type:ANIME){${MEDIA_FIELDS}}}`; v = { id: parseInt(anilistId, 10) }; }
  else if (im(malId)) { q = `query($malId:Int){Media(idMal:$malId,type:ANIME){${MEDIA_FIELDS}}}`; v = { malId: parseInt(malId, 10) }; }
  else return null;
  try { const d = await anilistQuery(q, v); return d?.data?.Media || null; } catch (e) { return null; }
}

export async function traceMoeSearch(imageBuffer, filename = 'image.jpg', mimetype = 'image/jpeg') {
  const fd = new FormData();
  fd.append('image', new Blob([imageBuffer], { type: mimetype }), filename);
  const r = await fetch(`${TRACEMOE_URL}/search?anilistInfo`, { method: 'POST', body: fd });
  return await r.json();
}

export async function geminiScan(base64Image, prompt) {
  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${GEMINI_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: 'image/jpeg', data: base64Image } }] }],
        generationConfig: { responseMimeType: 'application/json', temperature: 0.1 }
      })
    }
  );
  return await r.json();
}

export async function uploadToImgBB(blob, mimetype = 'image/jpeg', filename = 'avatar.jpg') {
  const fd = new FormData();
  fd.append('image', new Blob([blob], { type: mimetype }), filename);
  const r = await fetch(`https://api.imgbb.com/1/upload?key=${IMGBB_KEY}`, { method: 'POST', body: fd });
  return await r.json();
}

export async function fetchNewsXml() {
  const proxies = [
    process.env.ALLORIGINS_PROXY,
    process.env.CODETABS_PROXY,
    process.env.CORSPROXY
  ].filter(Boolean);
  for (const p of proxies) {
    try {
      const url = p.includes('url=') ? p + encodeURIComponent(NEWS_RSS) : p + NEWS_RSS;
      const r = await fetch(url);
      if (!r.ok) continue;
      const t = await r.text();
      if (t && (t.includes('<rss') || t.includes('<feed') || t.includes('<channel'))) return t;
    } catch (_) { continue; }
  }
  return null;
}

export async function fetchKitsuEpisodeTitle(title, epNum) {
  try {
    const sr = await fetch(`${KITSU_URL}/anime?filter[text]=${encodeURIComponent(title)}&page[limit]=1`);
    const sd = await sr.json();
    if (!sd.data || sd.data.length === 0) return null;
    const ki = sd.data[0].id;
    const er = await fetch(`${KITSU_URL}/anime/${ki}/episodes?filter[number]=${epNum}`);
    const ed = await er.json();
    if (ed.data && ed.data.length > 0 && ed.data[0].attributes?.canonicalTitle)
      return ed.data[0].attributes.canonicalTitle;
    return null;
  } catch (_) { return null; }
}

export async function fetchRadioStations() {
  const r = await fetch(`${RADIO_URL}/json/stations/bytag/anime?limit=40&hidebroken=true&is_https=true&lastcheckok=1`);
  return await r.json();
}

export async function fetchNekosCelebrate() {
  const r = await fetch(`${NEKOS_URL}/celebrate`);
  return await r.json();
}

// ---------- Identity Toolkit (Firebase Auth REST) ----------
export async function idToolkitSignInEmail(email, password) {
  const r = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${process.env.FIREBASE_API_KEY}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, returnSecureToken: true }) }
  );
  const d = await r.json();
  if (!r.ok) { const e = new Error(d.error?.message || 'Login failed'); e.code = 'auth/invalid-credential'; throw e; }
  return d;
}

export async function idToolkitSignInGoogle(idToken) {
  const r = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithIdp?key=${process.env.FIREBASE_API_KEY}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        postBody: `id_token=${idToken}&providerId=google.com`,
        requestUri: 'http://localhost',
        returnIdpCredential: true,
        returnSecureToken: true
      }) }
  );
  const d = await r.json();
  if (!r.ok) { const e = new Error(d.error?.message || 'Google login failed'); e.code = 'auth/invalid-credential'; throw e; }
  return d;
}

export async function idToolkitRefresh(refreshToken) {
  const r = await fetch(
    `https://securetoken.googleapis.com/v1/token?key=${process.env.FIREBASE_API_KEY}`,
    { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(refreshToken)}` }
  );
  const d = await r.json();
  if (!r.ok) throw new Error('Refresh failed');
  return { idToken: d.id_token, refreshToken: d.refresh_token };
}

export async function idToolkitLinkPassword(firebaseIdToken, email, password) {
  const r = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${process.env.FIREBASE_API_KEY}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, idToken: firebaseIdToken, returnSecureToken: true }) }
  );
  const d = await r.json();
  if (!r.ok) { const e = new Error(d.error?.message || 'Link failed'); e.code = d.error?.message?.toLowerCase().includes('email exists') ? 'auth/email-already-in-use' : 'auth/unknown'; throw e; }
  return d;
}
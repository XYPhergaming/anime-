const ANILIST_URL = process.env.ANILIST_GRAPHQL || 'https://graphql.anilist.co';
const MANGADEX_API = process.env.MANGADEX_API || 'https://api.mangadex.org';
const TRACEMOE_API = process.env.TRACEMOE_API || 'https://api.trace.moe';
const KITSU_API = process.env.KITSU_API || 'https://kitsu.io/api/edge';
const RADIO_BROWSER_API = process.env.RADIO_BROWSER_API || 'https://de1.api.radio-browser.info';
const NEKOS_BEST_API = process.env.NEKOS_BEST_API || 'https://nekos.best/api/v2';
const ANN_RSS = process.env.ANIME_NEWS_RSS || 'https://www.animenewsnetwork.com/all/rss.xml';
const ALLORIGINS = process.env.ALLORIGINS_PROXY || 'https://api.allorigins.win/raw?url=';
const CODETABS = process.env.CODETABS_PROXY || 'https://api.codetabs.com/v1/proxy?quest=';
const CORSPROXY = process.env.CORSPROXY || 'https://corsproxy.io/?url=';

export async function anilistQuery(query, variables) {
  const r = await fetch(ANILIST_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({ query, variables })
  });
  return await r.json();
}

export async function mangadexFetch(path) {
  const r = await fetch(MANGADEX_API + path);
  return await r.json();
}

export async function traceMoeIdentify(base64Jpeg) {
  const buf = Buffer.from(base64Jpeg, 'base64');
  const boundary = '----TraceMoeBoundary' + Date.now();
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="image.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  const body = Buffer.concat([head, buf, tail]);
  const r = await fetch(`${TRACEMOE_API}/search?anilistInfo`, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    body
  });
  return await r.json();
}

export async function geminiVerifyAnime(base64Jpeg) {
  const key = process.env.GEMINI_KEY;
  if (!key) throw new Error('GEMINI_KEY not configured');
  const prompt = 'You are a strict Japanese Anime and Manga verification system. Rules: 1) Is this genuinely a Japanese anime, manga, anime-style art, fan-art, or cosplay? 2) If it is a real photo or Western cartoon, set isAnime to false. 3) If it is anime, identify the exact title with 85 percent or higher confidence. If unsure, set false. 4) Return JSON only with keys: isAnime (boolean), confidence (number), animeTitle (string or null), character (string or null), rejectionReason (string or null).';
  const body = {
    contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: 'image/jpeg', data: base64Jpeg } }] }],
    generationConfig: { responseMimeType: 'application/json', temperature: 0.1 }
  };
  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${key}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
  );
  return await r.json();
}

export async function imgbbUpload(base64Image) {
  const key = process.env.IMGBB_KEY;
  if (!key) throw new Error('IMGBB_KEY not configured');
  const params = new URLSearchParams();
  params.append('image', base64Image);
  const r = await fetch(`https://api.imgbb.com/1/upload?key=${key}`, {
    method: 'POST',
    body: params
  });
  return await r.json();
}

export async function kitsuAnimeSearch(title) {
  const r = await fetch(`${KITSU_API}/anime?filter[text]=${encodeURIComponent(title)}&page[limit]=1`);
  return await r.json();
}

export async function kitsuEpisodeTitle(kitsuId, epNumber) {
  const r = await fetch(`${KITSU_API}/anime/${kitsuId}/episodes?filter[number]=${epNumber}`);
  return await r.json();
}

export async function radioBrowserStations() {
  const r = await fetch(
    `${RADIO_BROWSER_API}/json/stations/bytag/anime?limit=40&hidebroken=true&is_https=true&lastcheckok=1`
  );
  return await r.json();
}

export async function fetchNewsRSS() {
  const proxies = [ALLORIGINS, CODETABS, CORSPROXY];
  for (const p of proxies) {
    try {
      const r = await fetch(p + encodeURIComponent(ANN_RSS));
      if (!r.ok) continue;
      const t = await r.text();
      if (t && (t.includes('<rss') || t.includes('<feed') || t.includes('<channel'))) return t;
    } catch (e) { /* try next */ }
  }
  return null;
}

export async function nekosCelebrate() {
  const r = await fetch(`${NEKOS_BEST_API}/celebrate`);
  return await r.json();
}

export default function handler(req, res) {
  res.status(404).json({ error: 'Not found' });
}

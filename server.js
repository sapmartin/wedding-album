const express = require('express');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const DRIVE_API_KEY  = process.env.GOOGLE_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const FOLDER_ID      = process.env.GDRIVE_FOLDER_ID;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'https://em-our-day.onrender.com';

// ── CORS — only requests from our own frontend ──
app.use((req, res, next) => {
  const origin  = req.headers.origin;
  const referer = req.headers.referer || '';
  const originOk  = !origin  || origin === ALLOWED_ORIGIN;
  const refererOk = !referer || referer.startsWith(ALLOWED_ORIGIN);
  if (!originOk || !refererOk) return res.status(403).json({ error: 'Forbidden' });
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

const PROMPT = `You are a mischievous archivist cataloguing a mysterious photo archive. Look carefully at this photo and write ONE short, absurd, fictional caption (2–3 sentences). Treat everyone in it as complete strangers — invent ridiculous names and a made-up scenario that has absolutely nothing to do with weddings, romance, or formal events. Be deadpan and dry. Examples: "Gerald, seen here moments after accidentally bidding $40,000 on a decorative gourd at auction. His lawyer has advised him not to comment." or "Brenda and Keith, attending what they believed was a free cheese tasting. It was not." Return ONLY the caption — no quotes, no preamble, nothing else.`;

// ── LIST PHOTOS FROM DRIVE FOLDER ──
app.get('/api/photos', async (req, res) => {
  try {
    if (!DRIVE_API_KEY || !FOLDER_ID) {
      return res.status(500).json({ error: 'Server not configured. Set GOOGLE_API_KEY and GDRIVE_FOLDER_ID env vars.' });
    }
    const url = new URL('https://www.googleapis.com/drive/v3/files');
    url.searchParams.set('q', `'${FOLDER_ID}' in parents and mimeType contains 'image/' and trashed = false`);
    url.searchParams.set('key', DRIVE_API_KEY);
    url.searchParams.set('fields', 'files(id,name,mimeType)');
    url.searchParams.set('pageSize', '200');
    url.searchParams.set('orderBy', 'createdTime');

    const r    = await fetch(url.toString());
    const data = await r.json();
    if (!r.ok) throw new Error(data.error?.message || 'Drive API error');

    const files = (data.files || []).map(f => ({
      id: f.id,
      name: f.name,
      mimeType: f.mimeType,
      thumbnailUrl: `https://drive.google.com/thumbnail?id=${f.id}&sz=w600`,
    }));
    res.json(files);
  } catch (err) {
    console.error('Photos error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GENERATE CAPTION ──
app.post('/api/caption', async (req, res) => {
  try {
    const { fileId, mimeType } = req.body;
    if (!fileId)        return res.status(400).json({ error: 'fileId required' });
    if (!GEMINI_API_KEY) return res.status(500).json({ error: 'GEMINI_API_KEY env var not set.' });
    if (!DRIVE_API_KEY)  return res.status(500).json({ error: 'GOOGLE_API_KEY env var not set.' });

    // Fetch image from Drive
    const imgRes = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&key=${DRIVE_API_KEY}`);
    if (!imgRes.ok) throw new Error(`Could not fetch image from Drive (${imgRes.status})`);

    const buffer = await imgRes.arrayBuffer();
    const base64 = Buffer.from(buffer).toString('base64');
    const mime   = (imgRes.headers.get('content-type') || mimeType || 'image/jpeg').split(';')[0];

    // Send to Gemini 1.5 Flash via AI Studio key (free, 1500 req/day)
    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-lite:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [
            { inline_data: { mime_type: mime, data: base64 } },
            { text: PROMPT }
          ]}],
          generationConfig: { maxOutputTokens: 200, temperature: 1.2 }
        })
      }
    );

    const geminiData = await geminiRes.json();
    if (!geminiRes.ok) throw new Error(geminiData.error?.message || 'Gemini error');

    const caption = geminiData.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || 'Caption unavailable.';
    res.json({ caption });
  } catch (err) {
    console.error('Caption error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Wedding album running on port ${PORT}`));

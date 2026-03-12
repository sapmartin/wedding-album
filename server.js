const express = require('express');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const DRIVE_API_KEY = process.env.GOOGLE_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
const FOLDER_ID = process.env.GDRIVE_FOLDER_ID;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'https://em-our-day.onrender.com';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-1.5-flash';
const GEMINI_API_VERSION = process.env.GEMINI_API_VERSION || 'v1beta';

// ── CORS — only allow requests from our own frontend ──
app.use((req, res, next) => {
  const origin = req.headers.origin;
  const referer = req.headers.referer || '';

  const originOk = !origin || origin === ALLOWED_ORIGIN;
  const refererOk = !referer || referer.startsWith(ALLOWED_ORIGIN);

  if (!originOk || !refererOk) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

const PROMPT = `Write one witty caption for this wedding photo.
Rules:
- Base it only on visible details in this exact image (faces, posture, clothing, lighting, background).
- Tone: playful, warm, and clever.
- 1 sentence, max 22 words.
- No random names.
- No surreal nonsense.
Return only the caption.`;

const CAPTION_PROMPT = PROMPT;

const PREFERRED_MODELS = ['gemini-1.5-flash', 'gemini-1.5-flash-latest', 'gemini-2.0-flash'];

async function listSupportedModels(apiVersion) {
  const url = `https://generativelanguage.googleapis.com/${apiVersion}/models?key=${GEMINI_API_KEY}`;
  const response = await fetch(url);
  const data = await response.json();
  if (!response.ok) return [];

  return (data.models || [])
    .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map(m => (m.name || '').replace('models/', ''))
    .filter(Boolean);
}

async function callGemini({ apiVersion, model, base64, mime, fileId }) {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/${apiVersion}/models/${model}:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          role: 'user',
          parts: [
            { text: CAPTION_PROMPT },
            { text: `Photo ID for variation: ${fileId}` },
            { inlineData: { mimeType: mime, data: base64 } }
          ]
        }],
        generationConfig: {
          temperature: 0.95,
          topP: 0.9,
          maxOutputTokens: 90
        }
      })
    }
  );

  const data = await response.json();
  if (!response.ok) {
    const message = data.error?.message || `Gemini error (${response.status})`;
    const err = new Error(message);
    err.status = response.status;
    throw err;
  }

  const caption = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
  if (!caption) throw new Error('Gemini returned an empty caption.');

  return { caption, source: `gemini:${apiVersion}:${model}` };
}

async function generateGeminiCaption({ base64, mime, fileId }) {
  const versionsToTry = Array.from(new Set([GEMINI_API_VERSION, 'v1beta', 'v1']));

  let finalError = 'No supported Gemini model available.';
  for (const version of versionsToTry) {
    const supported = await listSupportedModels(version);
    if (!supported.length) continue;

    const requestedFirst = [GEMINI_MODEL, ...PREFERRED_MODELS, ...supported];
    const modelOrder = Array.from(new Set(requestedFirst)).filter(m => supported.includes(m));

    for (const model of modelOrder) {
      try {
        return await callGemini({ apiVersion: version, model, base64, mime, fileId });
      } catch (err) {
        finalError = err.message;
        if (![404, 429, 500, 503].includes(err.status)) throw err;
      }
    }
  }

  throw new Error(finalError);
}

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

    const r = await fetch(url.toString());
    const data = await r.json();
    if (!r.ok) throw new Error(data.error?.message || 'Drive API error');

    const files = (data.files || []).map(f => ({
      id: f.id,
      name: f.name,
      mimeType: f.mimeType,
      thumbnailUrl: `https://drive.google.com/thumbnail?id=${f.id}&sz=w600`
    }));

    res.json(files);
  } catch (err) {
    console.error('Photos error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GENERATE CAPTION FOR A DRIVE FILE ──
app.post('/api/caption', async (req, res) => {
  try {
    const { fileId, mimeType } = req.body;
    if (!fileId) return res.status(400).json({ error: 'fileId required' });

    if (!DRIVE_API_KEY || !GEMINI_API_KEY) {
      return res.status(500).json({ error: 'Server not configured. Set GOOGLE_API_KEY (and optionally GEMINI_API_KEY).' });
    }

    const imgRes = await fetch(
      `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&key=${DRIVE_API_KEY}`
    );
    if (!imgRes.ok) throw new Error(`Could not fetch image from Drive (${imgRes.status})`);

    const buffer = await imgRes.arrayBuffer();
    const base64 = Buffer.from(buffer).toString('base64');
    const mime = (imgRes.headers.get('content-type') || mimeType || 'image/jpeg').split(';')[0];

    const result = await generateGeminiCaption({ base64, mime, fileId });
    res.json(result);
  } catch (err) {
    console.error('Caption error:', err.message);
    res.status(503).json({ error: `Caption generation failed: ${err.message}` });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Wedding album running on port ${PORT}`));

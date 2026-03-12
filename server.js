const express = require('express');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const DRIVE_API_KEY   = process.env.GOOGLE_API_KEY;
const GEMINI_API_KEY  = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
const FOLDER_ID       = process.env.GDRIVE_FOLDER_ID;
const ALLOWED_ORIGIN  = process.env.ALLOWED_ORIGIN || 'https://em-our-day.onrender.com';

// ── CORS — only allow requests from our own frontend ──
app.use((req, res, next) => {
  const origin = req.headers.origin;
  const referer = req.headers.referer || '';

  // Allow same-origin requests (no origin header) and our frontend
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

const BASE_PROMPT = `You are writing a funny caption for a real wedding gallery photo.
Rules:
- Analyze THIS photo only; mention visible details (people, mood, clothing, gestures, setting, colors, expressions).
- Be witty and warm, not absurd nonsense.
- Keep it to 1-2 sentences, max 35 words.
- Do not invent random names unless visible context strongly implies them.
- Avoid generic lines that could fit any photo.
- Return only the caption text.`;

const GEMINI_TARGETS = [
  { apiVersion: 'v1', model: 'gemini-2.0-flash' },
  { apiVersion: 'v1beta', model: 'gemini-1.5-flash-latest' },
  { apiVersion: 'v1beta', model: 'gemini-1.5-flash' },
  { apiVersion: 'v1beta', model: 'gemini-1.5-flash-8b' }
];

const RECENT_CAPTION_LIMIT = 24;
const recentCaptions = [];
const perPhotoCaptionHistory = new Map();

function normalizeCaption(text = '') {
  return text.toLowerCase().replace(/\s+/g, ' ').replace(/[“”"'`]/g, '').trim();
}

function rememberCaption(fileId, caption) {
  const normalized = normalizeCaption(caption);
  if (!normalized) return;

  recentCaptions.push(normalized);
  if (recentCaptions.length > RECENT_CAPTION_LIMIT) recentCaptions.shift();

  const history = perPhotoCaptionHistory.get(fileId) || [];
  history.push(normalized);
  perPhotoCaptionHistory.set(fileId, history.slice(-6));
}

function isTooSimilar(caption, fileId) {
  const normalized = normalizeCaption(caption);
  if (!normalized) return true;

  const globalDup = recentCaptions.includes(normalized);
  const photoHistory = perPhotoCaptionHistory.get(fileId) || [];
  const localDup = photoHistory.includes(normalized);

  return globalDup || localDup;
}

function buildPrompt(fileId) {
  const recent = recentCaptions.slice(-8);
  const photoHistory = perPhotoCaptionHistory.get(fileId) || [];

  let extra = '';
  if (recent.length > 0) {
    extra += `\nAvoid repeating these recent captions exactly: ${recent.join(' || ')}.`;
  }
  if (photoHistory.length > 0) {
    extra += `\nThis photo has already used these captions, so produce a distinctly different one: ${photoHistory.join(' || ')}.`;
  }

  return `${BASE_PROMPT}${extra}`;
}

function isRetryableGeminiError(message = '', status = 500) {
  const msg = message.toLowerCase();
  if (status === 429 || status >= 500) return true;
  return msg.includes('quota') || msg.includes('not found for api version') || msg.includes('not supported for generatecontent');
}

async function callGemini({ apiVersion, model, base64, mime, prompt, temperature }) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/${apiVersion}/models/${model}:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          role: 'user',
          parts: [
            { text: prompt },
            { inline_data: { mime_type: mime, data: base64 } }
          ]
        }],
        generationConfig: {
          maxOutputTokens: 120,
          temperature,
          topP: 0.9
        }
      })
    }
  );

  const data = await res.json();
  if (!res.ok) {
    const message = data.error?.message || `Gemini request failed (${res.status})`;
    const error = new Error(message);
    error.status = res.status;
    throw error;
  }

  return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
}

async function generateGeminiCaption(base64, mime, fileId) {
  const prompt = buildPrompt(fileId);
  let lastRetryableError = null;

  for (const target of GEMINI_TARGETS) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const caption = await callGemini({
          ...target,
          base64,
          mime,
          prompt,
          temperature: attempt === 1 ? 0.8 : 1.0
        });

        if (!caption) continue;
        if (isTooSimilar(caption, fileId)) continue;

        rememberCaption(fileId, caption);
        return { caption, source: `gemini:${target.apiVersion}:${target.model}` };
      } catch (err) {
        if (isRetryableGeminiError(err.message, err.status)) {
          lastRetryableError = err.message;
          break;
        }
        throw err;
      }
    }
  }

  throw new Error(lastRetryableError || 'No Gemini model produced a usable caption.');
}

const GEMINI_MODELS = [
  'gemini-2.0-flash',
  'gemini-1.5-flash',
  'gemini-1.5-flash-8b'
];

const LOCAL_FALLBACK_CAPTIONS = [
  'Margo and Neil arrived expecting a CPR course and accidentally joined the International Society for Competitive Napping. Their pose scored a 9.4 from the judges.',
  'Seen here: two regional managers seconds before unveiling a 74-slide presentation titled “Soup Forecasting in Unstable Markets.” Nobody was emotionally prepared.',
  'Dale and Priya thought this was a routine passport photo. It was, in fact, evidence submission for the Great Municipal Pigeon Arbitration of 2026.'
];

function makeLocalFallbackCaption() {
  return LOCAL_FALLBACK_CAPTIONS[Math.floor(Math.random() * LOCAL_FALLBACK_CAPTIONS.length)];
}

function isRetryableGeminiError(errorMessage = '') {
  const msg = errorMessage.toLowerCase();
  return msg.includes('quota') || msg.includes('not found for api version') || msg.includes('is not supported for generatecontent');
}

async function generateGeminiCaption(base64, mime) {
  let lastError = 'Gemini request failed';

  for (const model of GEMINI_MODELS) {
    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1/models/${model}:generateContent?key=${GEMINI_API_KEY}`,
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

    if (geminiRes.ok) {
      const caption = geminiData.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
      if (caption) return { caption, source: `gemini:${model}` };
      lastError = `No caption returned by model ${model}`;
      continue;
    }

    lastError = geminiData.error?.message || `Gemini error (${geminiRes.status}) for model ${model}`;
    if (!isRetryableGeminiError(lastError)) {
      throw new Error(lastError);
    }
  }

  return {
    caption: makeLocalFallbackCaption(),
    source: 'local-fallback',
    warning: `Gemini unavailable: ${lastError}`
  };
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

    // Build thumbnail URLs (public Drive thumbnail endpoint — no auth needed for public files)
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

// ── GENERATE CAPTION FOR A DRIVE FILE ──
app.post('/api/caption', async (req, res) => {
  try {
    const { fileId, mimeType } = req.body;
    if (!fileId) return res.status(400).json({ error: 'fileId required' });
    if (!DRIVE_API_KEY || !GEMINI_API_KEY) {
      return res.status(500).json({ error: 'Server not configured. Set GOOGLE_API_KEY, and optionally GEMINI_API_KEY.' });
    }

    // Download image from Drive (works for public files with API key)
    const imgRes = await fetch(
      `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&key=${DRIVE_API_KEY}`
    );
    if (!imgRes.ok) throw new Error(`Could not fetch image from Drive (${imgRes.status})`);

    const buffer = await imgRes.arrayBuffer();
    const base64 = Buffer.from(buffer).toString('base64');
    const mime = (imgRes.headers.get('content-type') || mimeType || 'image/jpeg').split(';')[0];

    const result = await generateGeminiCaption(base64, mime, fileId);
    res.json(result);
  } catch (err) {
    console.error('Caption error:', err.message);
    res.status(503).json({
      error: `Caption AI is temporarily unavailable: ${err.message}`
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Wedding album running on port ${PORT}`));

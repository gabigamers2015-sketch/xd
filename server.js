/**
 * ============================================================================
 * 🚀 OMNIFORGE — v12.0 (SERVER-SIDE IMAGEN)
 * ============================================================================
 * FIX: Google Imagen falla en el browser por CORS.
 *      Todo se genera server-side: Imagen 4.0 → imgBB → Json2Video
 *
 * Pipeline:
 *   1. IA genera guion (GPT-4o Mini → Gemini Flash → Mistral)
 *   2. Servidor llama Google Imagen 4.0 por cada escena (sin CORS)
 *   3. Sube cada imagen a imgBB → URL pública
 *   4. Envía a Json2Video con las URLs reales
 * ============================================================================
 */

const express   = require("express");
const cors      = require("cors");
const axios     = require("axios");
const fs        = require("fs");
const path      = require("path");
const crypto    = require("crypto");
const rateLimit = require("express-rate-limit");

// ============================================================================
// 🛣️  RATE LIMITER — inteligente por endpoint
// ============================================================================
const limiterGenerate = rateLimit({
    windowMs: 2 * 60 * 1000, // 2 min
    max: 5,
    message: { error: "Demasiadas generaciones. Esperá 2 minutos." },
    standardHeaders: true, legacyHeaders: false,
    skip: () => false,
});

const limiterStatus = rateLimit({
    windowMs: 60 * 1000,
    max: 120,
    message: { error: "Demasiadas consultas de status." },
});


// SQLite — graceful fallback if not installed yet
let Database;
try { Database = require("better-sqlite3"); } catch(e) { Database = null; }

const app = express();

// ============================================================================
// ⚙️  KEYS
// ============================================================================
const CONFIG = {
    OPENROUTER_KEY: "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",
    JSON2VIDEO_KEY: "3SCVBQqgJGsVB0eMVUZY15gt5QSQe6CF1C6DdcZV",
    AICC_KEY:       "sk-4Kza9DIAB5AQH1PZ2e1avxBGeDR0M4emu0hoUFt8hrJYAfXc", // AIML API - Qwen Image
    GOOGLE_AI_KEY:  "AIzaSyDHVbsxIDjjz7vYwFx6qTWW0HxENRphZ5Q",
    IMGBB_KEY:      "ace263f5b12a89fed6913c31acdd34b9",
    PORT:           3000,
    LOG_FILE:       path.join(__dirname, "omni_audit.log"),
    VERSION:        "13.0.0",
    IMG_DELAY_MS:   4000,   // delay entre imágenes (rate limit Imagen free tier)
};

// ============================================================================
// 🎨  LOG
// ============================================================================
const C = { reset:"\x1b[0m", bold:"\x1b[1m", green:"\x1b[32m", yellow:"\x1b[33m", red:"\x1b[31m", cyan:"\x1b[36m", magenta:"\x1b[35m", fg2:"\x1b[2m" };
const ts  = () => new Date().toLocaleTimeString("es-AR");
const appendLog = l => { try { fs.appendFileSync(CONFIG.LOG_FILE, l + "\n"); } catch {} };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const log = {
    header: t  => { console.log(`\n${C.magenta}${"═".repeat(62)}\n  ${t.toUpperCase()}\n${"═".repeat(62)}${C.reset}`); },
    ok:     m  => { const d=ts(); console.log(`${C.green}[${d}] ✅ ${m}${C.reset}`);                                    appendLog(`[${d}] OK: ${m}`); },
    info:   m  => { const d=ts(); console.log(`${C.cyan}[${d}] ℹ  ${m}${C.reset}`);                                    appendLog(`[${d}] INFO: ${m}`); },
    warn:   m  => { const d=ts(); console.log(`${C.yellow}[${d}] ⚠  ${m}${C.reset}`);                                  appendLog(`[${d}] WARN: ${m}`); },
    error:  (m,s="") => { const d=ts(); console.log(`${C.red}[${d}] ❌ ${m} ${String(s).slice(0,300)}${C.reset}`);     appendLog(`[${d}] ERROR: ${m} ${s}`); },
    retry:  (a,b)    => { const d=ts(); console.log(`${C.yellow}[${d}] 🔄 FAILOVER: ${a} → ${b}${C.reset}`); },
};

// ============================================================================
// 🧹  cleanPrompt
// ============================================================================
function cleanPrompt(t) {
    return t
        .replace(/[\u{1F000}-\u{1FFFF}]/gu, "")
        .replace(/[\u{2600}-\u{27BF}]/gu,   "")
        .replace(/[^\x00-\x7F]/g,           " ")
        .replace(/[<>{}[\]|\\^`"']/g,       "")
        .replace(/\s+/g,                    " ")
        .trim();
}

// ============================================================================
// 🤖  CAPA 1: TEXTO — failover OpenRouter
// ============================================================================
const TEXT_MODELS = [
    { id: "openai/gpt-4o-mini",                            label: "GPT-4o Mini"   },
    { id: "google/gemini-2.0-flash-lite-001",              label: "Gemini Flash"  },
    { id: "mistralai/mistral-small-3.1-24b-instruct:free", label: "Mistral Small" },
];

async function callAI(modelId, system, user) {
    const r = await axios.post(
        "https://openrouter.ai/api/v1/chat/completions",
        { model:modelId, messages:[{role:"system",content:system},{role:"user",content:user}],
          response_format:{type:"json_object"}, temperature:0.8, max_tokens:2000 },
        { headers:{ "Authorization":`Bearer ${CONFIG.OPENROUTER_KEY}`,
          "Content-Type":"application/json","HTTP-Referer":"http://localhost:3000","X-Title":"OmniForge" },
          timeout:30000 }
    );
    return JSON.parse(r.data.choices[0].message.content);
}

async function getScript(userPrompt, count, tone="epic and dramatic", opts={}) {
    log.header("Capa 1: Guion con IA");

    const withChapters    = opts.withChapters  || false;
    const withDocShots    = opts.withDocShots  || false;
    const multiVoice      = opts.multiVoice    || false;
    const withKaraoke     = opts.withKaraoke   || false;

    // Shot types for documentary mode — cycle through them
    const DOC_SHOTS = ["extreme close-up shot", "close-up shot", "medium shot",
                       "wide shot", "extreme wide shot", "over-the-shoulder shot", "low angle shot"];

    // Chapter structure — divide scenes into acts
    const chapterMap = withChapters ? buildChapterMap(count) : null;

    const sys = `Eres un director de cine profesional. Responde SOLO con JSON valido, sin markdown.
Formato exacto:
{
  "mood": "epic",
  "title": "Titulo cinematografico del video en espanol",
  "subject": "descripcion del personaje principal para continuidad visual",
  "narrator_voice": "primary",
  "scenes": [
    {
      "chapter": "intro",
      "text": "Frase narracion en espanol, max 15 palabras",
      "visual": "English image description max 90 chars",
      "sfx": "wind",
      "lower": "Texto barra inferior max 4 palabras",
      "voice_role": "narrator",
      "intensity": "low",
      "shot_type": "wide shot"
    }
  ]
}
Reglas:
- mood: epic | suspense | futuristic | action | calm | romantic | horror | documentary
- chapter: intro | development | climax | outro  (${withChapters ? "REQUERIDO, divide los "+count+" scenes entre los 4 actos" : "usa siempre 'main'"})
- intensity: low | medium | high | peak  (para dinamica de musica)
- shot_type: usa ${withDocShots ? "variedad cinematografica: close-up, wide shot, medium shot, low angle, over-the-shoulder" : "cinematic wide shot"}
- voice_role: ${multiVoice ? '"narrator" para narrador principal, "character" para personaje secundario (alterna cada 2 escenas)' : 'siempre "narrator"'}
- text: espanol, max 15 palabras, sin emojis
- visual: English, VERY specific subject description first (what/who + action + environment), max 100 chars, no emojis. Example: "orange tabby cat touching glowing orb, explosion particles around, dark room" NOT "cinematic cat scene" 
- Exactamente ${count} escenas
- Tono: ${tone}`;

    for (let i = 0; i < TEXT_MODELS.length; i++) {
        const m = TEXT_MODELS[i];
        try {
            log.info(`Intentando ${m.label}...`);
            const p = await callAI(m.id, sys, `Video de ${count} escenas: "${userPrompt}"`);
            if (!Array.isArray(p.scenes) || !p.scenes.length) throw new Error("Sin scenes");

            // Inject documentary shots if not generated by AI
            if (withDocShots) {
                p.scenes = p.scenes.map((s, i) => ({
                    ...s,
                    shot_type: s.shot_type || DOC_SHOTS[i % DOC_SHOTS.length],
                    visual: `${DOC_SHOTS[i % DOC_SHOTS.length]}, ${s.visual}`
                }));
            }

            // Assign chapters if not in response
            if (withChapters && chapterMap) {
                p.scenes = p.scenes.map((s, i) => ({
                    ...s,
                    chapter: s.chapter || chapterMap[i] || "main"
                }));
            }

            log.ok(`Guion: ${p.scenes.length} escenas | mood: ${p.mood} | "${p.title}" | via: ${m.label}`);
            return p;
        } catch(e) {
            if (i < TEXT_MODELS.length-1) log.retry(m.label, TEXT_MODELS[i+1].label);
            else log.error("Todos los modelos fallaron", e.message);
            await sleep(1000);
        }
    }
    throw new Error("Todos los modelos fallaron.");
}

// Divide N scenes into 4 acts (Intro/Development/Climax/Outro)
function buildChapterMap(total) {
    const map = {};
    const acts = ["intro","development","climax","outro"];
    const sizes = [
        Math.max(1, Math.floor(total * 0.15)),  // intro  ~15%
        Math.max(1, Math.floor(total * 0.45)),  // dev    ~45%
        Math.max(1, Math.floor(total * 0.30)),  // climax ~30%
        0                                        // outro  = resto
    ];
    sizes[3] = total - sizes[0] - sizes[1] - sizes[2];
    let idx = 0;
    acts.forEach((act, a) => {
        for (let i = 0; i < sizes[a]; i++) map[idx++] = act;
    });
    return map;
}


// ============================================================================
// 🔬  A/B TESTING DE PROMPTS — IA elige el mejor prompt visual (feat. #21)
//     Reemplaza Stable Diffusion XL / MidJourney Pro A/B testing
//     Implementación propia: pedimos 2 prompts a GPT y dejamos que critique
// ============================================================================
async function improveVisualPrompt(basePrompt, style, mood) {
    try {
        const sys = `Eres un director de fotografía experto. Dado un prompt de imagen base,
genera DOS versiones mejoradas y elige la MEJOR. Responde SOLO con JSON:
{"winner": "..prompt ganador..", "reason": "why"}
El prompt ganador debe ser cinematografico, max 100 chars, sin emojis.`;
        const user = `Prompt base: "${basePrompt}" | Estilo: ${style} | Mood: ${mood}`;
        const p    = await callAI(TEXT_MODELS[0].id, sys, user);
        if (p.winner && p.winner.length > 10) {
            log.info(`  A/B winner: "${p.winner.slice(0,60)}..." (${p.reason?.slice(0,40)||""})`);
            return p.winner;
        }
    } catch(e) {
        log.warn(`  A/B testing fallo (${e.message.slice(0,60)}) — usando prompt original`);
    }
    return basePrompt;
}

// ============================================================================
// 🎵  BEAT SYNC — sincroniza duración de escenas al BPM de la música (feat. #19)
//     Reemplaza AudioLDM / Suno beat detection
//     Implementación propia: BPM por mood → duración alineada a compases musicales
// ============================================================================
const MOOD_BPM = {
    epic:       138,  // compás de 4/4 = ~1.74s por beat, 4 beats = ~6.9s ≈ 7s
    action:     160,  // 4 beats = ~6s
    suspense:   80,   // lento, tenso → 8 beats = ~12s
    futuristic: 120,  // 4 beats = ~8s
    calm:       72,   // 8 beats = ~13s → clamped a max 10
    romantic:   90,   // 4 beats = ~10s
    horror:     60,   // lentísimo → 4 beats = ~16s clamped a 10
    documentary:95,   // 4 beats = ~10s
    default:    120,
};

function beatSyncDuration(mood, preferredDur) {
    if (preferredDur) return preferredDur; // si el usuario especifica, respetar
    const bpm        = MOOD_BPM[mood] || MOOD_BPM.default;
    const beatSec    = 60 / bpm;
    const beats      = bpm >= 120 ? 8 : 4;   // rápido=8 beats, lento=4 beats
    const synced     = Math.round(beatSec * beats * 10) / 10;
    const clamped    = Math.max(4, Math.min(10, synced));
    log.info(`  Beat sync: ${bpm} BPM → ${synced}s → clamped ${clamped}s`);
    return clamped;
}

// ============================================================================
// 🔊  SFX LAYER — efectos de sonido ambient (feat. #7)
//     Reemplaza AudioLDM / ElevenLabs Sound Effects
//     Implementación propia: librería de URLs de audio libre Creative Commons
// ============================================================================
// ─── CDN: Mixkit (fuente original — se descarga y re-hostea, NO se usa directo) ──
// ─── SFX — soundhelix.com (mismo CDN que la música, sin hotlink protection ✅) ──
// Pistas 5 y 10-17 libres (1-4,6-9 las usa el sistema de música).
const SFX_LIBRARY = {
    wind:        "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-5.mp3",
    rain:        "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-10.mp3",
    fire:        "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-11.mp3",
    ocean:       "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-12.mp3",
    crowd:       "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-13.mp3",
    thunder:     "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-14.mp3",
    space:       "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-15.mp3",
    silence:     null,
    // Por mood
    epic:        "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-5.mp3",
    suspense:    "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-16.mp3",
    futuristic:  "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-15.mp3",
    action:      "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-5.mp3",
    calm:        "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-12.mp3",
    horror:      "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-16.mp3",
    documentary: "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-10.mp3",
    romantic:    "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-17.mp3",
    // Transiciones
    trans_zoom:        "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-5.mp3",
    trans_slide_left:  "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-5.mp3",
    trans_slide_right: "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-5.mp3",
    trans_flip:        "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-11.mp3",
};

// warmSfxCache — solo valida con HEAD, no descarga
const sfxCache = new Map();
async function warmSfxCache() {
    const keys = Object.keys(SFX_LIBRARY).filter(k => SFX_LIBRARY[k]);
    const unique = [...new Set(keys.map(k => SFX_LIBRARY[k]))];
    let ok = 0;
    await Promise.allSettled(unique.map(async url => {
        try { await axios.head(url, { timeout: 5000 }); ok++; } catch {}
    }));
    // Poblar caché directo desde SFX_LIBRARY (no depende del HEAD)
    keys.forEach(k => sfxCache.set(k, SFX_LIBRARY[k]));
    log.ok(`SFX: listo — ${keys.length} keys mapeados (soundhelix ${ok}/${unique.length} URLs activas)`);
}

function getSFX(sfxKey, mood) {
    if (sfxCache.size > 0) return sfxCache.get(sfxKey) || sfxCache.get(mood) || null;
    return SFX_LIBRARY[sfxKey] || SFX_LIBRARY[mood] || null;
}

// ============================================================================
// 🌍  AUTO-TRADUCCIÓN — genera guion en 5 idiomas (feat. #17)
//     Reemplaza servicios de traducción de pago (DeepL Pro, Google Translate API)
//     Implementación propia: GPT-4o Mini vía OpenRouter (gratis en su tier)
// ============================================================================
const TRANSLATE_LANGS = {
    en: "English",
    pt: "Portuguese (Brazilian)",
    fr: "French",
    de: "German",
    ja: "Japanese",
};

async function translateScenes(scenes, targetLang) {
    try {
        const sys  = `Translate the "text" field of each scene to ${TRANSLATE_LANGS[targetLang]}.
Keep it short, impactful, max 10 words. Return ONLY JSON: {"scenes":[{"text":"..."}]}`;
        const user = JSON.stringify({ scenes: scenes.map(s => ({ text: s.text })) });
        const p    = await callAI(TEXT_MODELS[0].id, sys, user);
        return p.scenes?.map((t, i) => ({ ...scenes[i], text: t.text || scenes[i].text })) || scenes;
    } catch(e) {
        log.warn(`Traducción a ${targetLang} fallo: ${e.message.slice(0,60)}`);
        return scenes;
    }
}

// ============================================================================
// 🎬  PARALLAX SIMULATION — simula profundidad visual (feat. #2)
//     Reemplaza segmentación IA (Segment Anything / RunwayML)
//     Implementación propia: doble capa de texto con ligero offset → ilusión parallax
// ============================================================================
function makeParallaxOverlay(text, dur) {
    return [
        // Sombra ligeramente desplazada — simula capa de fondo
        {
            type: "text", text: text.toUpperCase(),
            position: "bottom-center", duration: dur,
            settings: {
                "font-size":"46px", "font-family":"Montserrat", "font-weight":"800",
                "font-color":"rgba(0,0,0,0.6)", "background-color":"transparent",
                "padding":"22px 42px", "width":"920px", "text-align":"center",
                "transform":"translateY(4px) translateX(3px)",
            }
        },
        // Texto principal — capa frontal
        {
            type: "text", text: text.toUpperCase(),
            position: "bottom-center", duration: dur,
            settings: {
                "font-size":"46px", "font-family":"Montserrat", "font-weight":"800",
                "font-color":"#ffffff", "background-color":"transparent",
                "padding":"20px 40px", "width":"920px", "text-align":"center",
                "text-shadow":"0 2px 20px rgba(0,0,0,0.8)",
            }
        },
    ];
}

// ============================================================================
// ✨  GLITCH TRANSITION — efecto digital futurista (feat. #4)
//     Implementación propia via Json2Video: usamos "flip" + overlay de texto
//     con caracteres glitch para simular interferencia digital
// ============================================================================
function getGlitchTransition(idx) {
    return {
        style:    "flip",
        duration: 0.5,
    };
}


// ============================================================================
// 🎬  CAPA 2: VIDEO — Tier 0 (primero intentamos video real por escena)
// ============================================================================
// PIPELINE DE VIDEO:
//   1° veo-3.1-fast-generate-preview  (Google Veo vía AIML API)
//   2° sora-2                         (OpenAI Sora vía AIML API)
//   ❌ Si ambos fallan → caemos a imagen (Tier 1+)
// NOTA: AIML usa polling async → POST crea job, GET /status lo espera
// ============================================================================

const VIDEO_MODELS = [
    { id: "google/veo-3.1-t2v-fast", label: "Veo 3.1 Fast" },
    { id: "openai/sora-2-t2v",       label: "Sora 2"       },
];

const AICC_VIDEO_BASE = "https://api.aimlapi.com/v2/video/generations";

// ── Polling helper — espera hasta que el job esté listo ──────────────────────
async function pollVideoJob(generationId, label, maxWaitMs = 120000) {
    const start    = Date.now();
    const interval = 6000; // cada 6s
    while (Date.now() - start < maxWaitMs) {
        await sleep(interval);
        const r = await axios.get(
            AICC_VIDEO_BASE,
            {
                headers: { "Authorization": `Bearer ${CONFIG.AICC_KEY}` },
                timeout: 15000,
                params: { generation_id: generationId },
            }
        );
        const status = r.data?.status;
        log.info(`  Video poll [${label}] → ${status}`);
        if (status === "completed" || status === "succeeded" || status === "done") {
            const url = r.data?.video?.url || r.data?.url || r.data?.output?.[0] || r.data?.result?.url;
            if (url) return url;
            throw new Error(`${label}: job completado pero sin URL`);
        }
        if (status === "failed" || status === "error" || status === "cancelled") {
            const reason = r.data?.error || r.data?.message || "sin detalle";
            throw new Error(`${label}: job falló — ${reason}`);
        }
        // status "pending" | "processing" | "queued" → seguir esperando
    }
    throw new Error(`${label}: timeout (${maxWaitMs/1000}s)`);
}

// ── Tier 0-A: Veo 3.1 Fast (Google vía AIML) ─────────────────────────────────
async function tryVeo31(prompt, idx) {
    const clean = cleanPrompt(prompt).slice(0, 300);
    log.info(`  [${idx+1}] Veo 3.1 Fast → "${clean.slice(0,70)}..."`);
    const r = await axios.post(
        AICC_VIDEO_BASE,
        {
            model:  "google/veo-3.1-t2v-fast",
            prompt: clean,
        },
        {
            headers: { "Authorization": `Bearer ${CONFIG.AICC_KEY}`, "Content-Type": "application/json" },
            timeout: 20000,
        }
    );
    const genId = r.data?.id || r.data?.generation_id;
    if (!genId) throw new Error("Veo 3.1: no devolvió generation_id");
    log.info(`  [${idx+1}] Veo 3.1 job creado → ${genId}`);
    const videoUrl = await pollVideoJob(genId, "Veo 3.1 Fast");
    log.ok(`  [${idx+1}] ✓ Veo 3.1 Fast → ${videoUrl}`);
    return videoUrl;
}

// ── Tier 0-B: Sora 2 (OpenAI vía AIML) ───────────────────────────────────────
async function trySora2(prompt, idx) {
    const clean = cleanPrompt(prompt).slice(0, 300);
    log.info(`  [${idx+1}] Sora 2 → "${clean.slice(0,70)}..."`);
    const r = await axios.post(
        AICC_VIDEO_BASE,
        {
            model:  "openai/sora-2-t2v",
            prompt: clean,
        },
        {
            headers: { "Authorization": `Bearer ${CONFIG.AICC_KEY}`, "Content-Type": "application/json" },
            timeout: 20000,
        }
    );
    const genId = r.data?.id || r.data?.generation_id;
    if (!genId) throw new Error("Sora 2: no devolvió generation_id");
    log.info(`  [${idx+1}] Sora 2 job creado → ${genId}`);
    const videoUrl = await pollVideoJob(genId, "Sora 2");
    log.ok(`  [${idx+1}] ✓ Sora 2 → ${videoUrl}`);
    return videoUrl;
}

// ============================================================================
// 🖼️  CAPA 2: IMAGEN — Cadena de 10+ fuentes sin API key
// ============================================================================
// ARQUITECTURA CLAVE:
//   ✅ buildPassiveUrl() → construye URL sin hacer ningún request
//   ✅ Json2Video descarga la imagen con SUS IPs (limpias, sin ban)
//   ✅ NUNCA hacemos axios.get a generadores de imagen desde nuestro server
//   ✅ on_error:"ignore" → si una falla, Json2Video sigue con la siguiente escena
// ============================================================================

// ── Tier 1: AIML imagen — cascada de modelos confirmados ─────────────────────
const AIML_IMAGE_MODELS = [
    "black-forest-labs/FLUX.1-schnell",
    "black-forest-labs/FLUX.1-dev",
    "stabilityai/stable-diffusion-xl-base-1.0",
];

async function tryQwen(prompt, idx) {
    const clean = cleanPrompt(prompt).slice(0, 200);
    let lastErr = null;
    for (const model of AIML_IMAGE_MODELS) {
        try {
            const r = await axios.post(
                "https://api.aimlapi.com/v1/images/generations",
                { model, prompt: clean, num_images: 1 },
                { headers: { "Authorization": `Bearer ${CONFIG.AICC_KEY}`, "Content-Type": "application/json" }, timeout: 30000 }
            );
            const url = r.data?.data?.[0]?.url || r.data?.images?.[0]?.url || r.data?.output?.[0];
            if (!url || !url.startsWith("http")) throw new Error("Sin URL valida");
            log.ok(`  [${idx+1}] AIML OK (${model.split("/").pop()})`);
            return url;
        } catch(e) {
            lastErr = e;
            log.warn(`  [${idx+1}] AIML ${model.split("/").pop()} fallo: ${e.message.slice(0,50)}`);
        }
    }
    throw lastErr || new Error("AIML imagen: todos los modelos fallaron");
}

// ── Tier 2: URLs pasivas — construidas, NO descargadas por nuestro server ─────
// Json2Video las descarga con sus IPs limpias durante el render
// buildPassiveUrls — ya no se usa en el pipeline principal (reemplazada por getImageUrl)
// Se mantiene como helper para re-render manual si se necesita
function buildPassiveUrls(prompt, idx, width, height) {
    const clean = cleanPrompt(prompt).slice(0, 180);
    const enc   = encodeURIComponent(clean + ", cinematic, photorealistic");
    const seed  = crypto.randomInt(10000, 999999);
    const kw    = clean
        .toLowerCase()
        .replace(/\b(a|an|the|with|and|of|in|on|at|for|shot|cinematic)\b/g, " ")
        .replace(/\s+/g, " ").trim()
        .split(" ").filter(w => w.length > 3).slice(0, 4).join(",");
    const kwEnc = encodeURIComponent(kw || "cinematic scene");

    return [
        `https://image.pollinations.ai/prompt/${enc}?width=${width}&height=${height}&nologo=true&seed=${seed}&model=flux`,
        `https://image.pollinations.ai/prompt/${enc}?width=${width}&height=${height}&nologo=true&seed=${seed+1}&model=flux-realism`,
        `https://loremflickr.com/${width}/${height}/${kwEnc}?random=${seed}`,
        `https://picsum.photos/seed/${seed}/${width}/${height}.jpg`,
    ];
}

// ── Descarga imagen de una URL y la sube a imgBB (CDN estable) ───────────────
// Esto garantiza que Json2Video siempre encuentra la imagen
async function downloadAndUpload(url, idx, seed=0) {
    log.info(`  [${idx+1}] Descargando imagen...`);
    const r = await axios.get(url, {
        responseType: "arraybuffer",
        timeout:      25000, // timeout duro — si no responde en 25s, caemos a Picsum
        headers:      { "User-Agent": "Mozilla/5.0 (compatible; OmniForge/13.0)" },
        maxRedirects: 5,
    });
    if (!r.data || r.data.byteLength < 5000) throw new Error(`Imagen inválida (${r.data?.byteLength||0} bytes)`);

    // Nombre único: escena + seed + hash parcial del contenido → imgBB nunca deduplica
    const hashSlice = crypto.createHash("md5").update(Buffer.from(r.data)).digest("hex").slice(0, 8);
    const imgName   = `omni_s${idx}_${seed}_${hashSlice}`;

    const base64 = Buffer.from(r.data).toString("base64");
    log.ok(`  [${idx+1}] OK (${Math.round(r.data.byteLength/1024)} KB, ${imgName}) → imgBB...`);

    const form = new URLSearchParams();
    form.append("key",   CONFIG.IMGBB_KEY);
    form.append("image", base64);
    form.append("name",  imgName);
    const bb = await axios.post("https://api.imgbb.com/1/upload", form.toString(), {
        headers: { "Content-Type": "application/x-www-form-urlencoded" }, timeout: 30000
    });
    if (!bb.data?.data?.url) throw new Error("imgBB sin URL");
    log.ok(`  [${idx+1}] imgBB → ${bb.data.data.url}`);
    return bb.data.data.url;
}

async function getImageUrl(visualPrompt, idx, width=720, height=1280) {
    // Seed matemáticamente único por escena: tiempo + idx + random
    // Es IMPOSIBLE que dos escenas distintas tengan el mismo seed
    const sceneSeed = Date.now() + idx * 99991 + crypto.randomInt(1000, 99999);
    const cleanFull = cleanPrompt(visualPrompt).slice(0, 180);
    const enc       = encodeURIComponent(cleanFull + ", cinematic, photorealistic");

    log.info(`  [${idx+1}] seed:${sceneSeed} | "${cleanFull.slice(0,70)}..."`);

    // ── Tier 0: Video IA (Veo 3.1 → Sora 2) ──────────────────────────────────
    // Activo por default. Requiere créditos AIML. Para deshabilitar: SKIP_VIDEO_TIER=true
    if (process.env.SKIP_VIDEO_TIER !== 'true') {
        try {
            const url = await tryVeo31(cleanFull, idx);
            return { primary: url, fallback: url, type: "video" };
        } catch(e) {
            log.warn(`  [${idx+1}] Veo 3.1 falló: ${e.message.slice(0,80)}`);
        }
        try {
            const url = await trySora2(cleanFull, idx);
            return { primary: url, fallback: url, type: "video" };
        } catch(e) {
            log.warn(`  [${idx+1}] Sora 2 falló: ${e.message.slice(0,80)}`);
        }
    }

    // ── Tier 1: AIML / Flux Dev ──────────────────────────────────────────────
    try {
        const url = await tryQwen(cleanFull, idx);
        log.ok(`  [${idx+1}] ✓ AIML/Flux`);
        return { primary: url, fallback: url };
    } catch(e) {
        log.warn(`  [${idx+1}] AIML fallo: ${e.message.slice(0,60)}`);
    }

    // ── Tier 2: Pollinations → descarga → imgBB ──────────────────────────────
    // 2 intentos máx. 10s de espera antes de descargar (Pollinations tarda en generar).
    // 404 = imagen aún no lista → esperar 8s más y reintentar con seed diferente.
    // 429 = ban temporal → skip inmediato a Picsum.
    for (let attempt = 0; attempt < 2; attempt++) {
        const polSeed = sceneSeed + 7777 + attempt * 54321;
        const polUrl  = `https://image.pollinations.ai/prompt/${enc}?width=${width}&height=${height}&nologo=true&seed=${polSeed}&model=flux&enhance=true`;
        log.info(`  [${idx+1}] Pollinations intento ${attempt+1}/2 (seed ${polSeed})...`);
        try {
            await sleep(attempt === 0 ? 8000 : 10000); // 8s primer intento, 10s segundo (más chances de estar lista)
            const stableUrl = await downloadAndUpload(polUrl, idx, polSeed);
            log.ok(`  [${idx+1}] ✓ Pollinations (intento ${attempt+1})`);
            return { primary: stableUrl, fallback: stableUrl };
        } catch(e) {
            const is429 = e.message.includes("429") || e.message.includes("Too Many");
            const is404 = e.message.includes("404") || e.message.includes("Not Found");
            log.warn(`  [${idx+1}] Pollinations${is429?" 429-ban":is404?" 404-notready":""}: ${e.message.slice(0,60)}`);
            if (is429) break; // ban → no reintentar
            if (is404) await sleep(5000); // imagen no lista → pausa extra antes del retry
        }
    }

    // ── Tier 3: Picsum — JPG directo, seed único, sin redirects, sin auth ────
    // picsum.photos/seed/{N}/{W}/{H}.jpg → URL estable, JPG real, único por seed.
    // Json2Video lo descarga directo SIN necesidad de imgBB.
    // Math.abs() para evitar seeds negativos. Único por escena garantizado.
    const picsumSeed = Math.abs(sceneSeed % 999999999);
    const picsumUrl  = `https://picsum.photos/seed/${picsumSeed}/${width}/${height}.jpg`;
    log.info(`  [${idx+1}] Picsum directo seed=${picsumSeed}`);
    return { primary: picsumUrl, fallback: picsumUrl };
}

// ============================================================================
// 🎵  MÚSICA — mapeo rico por mood
// ============================================================================
const MUSIC = {
    epic:         "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3",
    suspense:     "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-2.mp3",
    futuristic:   "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-3.mp3",
    action:       "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-4.mp3",
    calm:         "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-9.mp3",
    romantic:     "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-7.mp3",
    horror:       "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-8.mp3",
    documentary:  "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-6.mp3",
    default:      "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3",
};

// ============================================================================
// 🎨  ESTILOS VISUALES — sufijos de prompt por estilo
// ============================================================================
const STYLE_PROMPTS = {
    cinematic:    "photorealistic, sharp focus, high detail",
    anime:        "anime illustration, sharp lines, vivid",
    documentary:  "RAW photo, sharp, real",
    cyberpunk:    "neon lights, dark, sharp detail",
    fantasy:      "fantasy art, detailed, vivid",
    vintage:      "35mm film, warm tones, nostalgic",
};

// ============================================================================
// 🎬  TRANSICIONES — pool completo de efectos
// ============================================================================
const TRANSITIONS = {
    cinematic:   ["fade", "fade", "zoom", "fade", "zoom"],
    dynamic:     ["slide-left", "slide-right", "zoom", "flip", "wipe-left"],
    smooth:      ["fade", "fade", "fade", "fade", "fade"],
    random:      ["fade", "zoom", "slide-left", "slide-right", "wipe-left", "wipe-right", "flip"],
};

function getTransition(style, idx) {
    const pool = TRANSITIONS[style] || TRANSITIONS.cinematic;
    return { style: pool[idx % pool.length], duration: 1 };
}

// ============================================================================
// 📝  SUBTÍTULOS — estilos por mood/estilo visual
// ============================================================================
function getTextSettings(mood, visualStyle, position, idx) {
    const positions = {
        "bottom":        "bottom-center",
        "top":           "top-center",
        "center":        "center-center",
        "cinematic-bot": "bottom-center",
    };

    const pos = positions[position] || "bottom-center";

    const styleMap = {
        cinematic: {
            "font-size": "44px", "font-family": "Playfair Display", "font-weight": "700",
            "font-color": "#ffffff", "background-color": "transparent",
            "text-shadow": "2px 2px 8px rgba(0,0,0,0.9)",
            "padding": "20px 40px", "width": "1000px", "text-align": "center",
            "letter-spacing": "2px",
        },
        anime: {
            "font-size": "48px", "font-family": "Nunito", "font-weight": "900",
            "font-color": "#ffffff", "background-color": "#000000cc",
            "padding": "15px 35px", "width": "900px", "text-align": "center",
            "border-radius": "8px", "border": "2px solid rgba(255,200,0,0.6)",
        },
        documentary: {
            "font-size": "38px", "font-family": "Source Sans Pro", "font-weight": "400",
            "font-color": "#f0f0f0", "background-color": "#000000aa",
            "padding": "18px 36px", "width": "950px", "text-align": "left",
            "border-left": "4px solid #ffffff",
        },
        cyberpunk: {
            "font-size": "46px", "font-family": "Share Tech Mono", "font-weight": "400",
            "font-color": "#00f5ff", "background-color": "rgba(0,0,20,0.85)",
            "padding": "20px 40px", "width": "950px", "text-align": "center",
            "border": "1px solid #00f5ff", "text-shadow": "0 0 10px #00f5ff",
        },
        fantasy: {
            "font-size": "50px", "font-family": "Cinzel", "font-weight": "700",
            "font-color": "#ffd700", "background-color": "rgba(0,0,0,0.75)",
            "padding": "25px 50px", "width": "900px", "text-align": "center",
            "border": "1px solid rgba(255,215,0,0.4)",
        },
        vintage: {
            "font-size": "42px", "font-family": "Libre Baskerville", "font-weight": "400",
            "font-color": "#f5e6c8", "background-color": "rgba(20,10,0,0.8)",
            "padding": "20px 40px", "width": "880px", "text-align": "center",
        },
    };

    return { position: pos, settings: styleMap[visualStyle] || styleMap.cinematic };
}

// ============================================================================
// 📽️  ENSAMBLADOR — 30 FEATURES EXTREME EDITION
// ============================================================================

// ── Director de Fotografía — añade términos cinematográficos al prompt ────────
function directorPrompt(base, style) {
    // REGLA CLAVE: el SUJETO va primero y ocupa ~70% del prompt.
    // Los modificadores cinematográficos van al final, cortos.
    // Flux/SDXL: lo primero que lee tiene más peso.
    const suffix = {
        cinematic:   "cinematic lighting, film grain, photorealistic",
        anime:       "anime style, vibrant colors, expressive",
        documentary: "documentary, natural light, photorealistic",
        cyberpunk:   "cyberpunk, neon lights, high contrast",
        fantasy:     "fantasy art, dramatic lighting, painterly",
        vintage:     "vintage film, warm tones, soft focus",
    };
    return `${base}, ${suffix[style] || suffix.cinematic}`;
}

// ── Color grading por mood (overlay de color) ─────────────────────────────────
const MOOD_GRADE = {
    epic:       { color: "#ff4400", opacity: 0.08 },
    suspense:   { color: "#001133", opacity: 0.15 },
    futuristic: { color: "#003366", opacity: 0.10 },
    action:     { color: "#cc2200", opacity: 0.10 },
    calm:       { color: "#002200", opacity: 0.06 },
    romantic:   { color: "#660022", opacity: 0.08 },
    horror:     { color: "#000011", opacity: 0.20 },
    documentary:{ color: "#221100", opacity: 0.07 },
    default:    { color: "#000000", opacity: 0.0  },
};

// ── HUD Overlay — marco futurista con coordenadas ─────────────────────────────
function makeHUD(sceneIndex, total, dur) {
    const coord   = `${(sceneIndex * 13.7 + 22.4).toFixed(2)}°N  ${(sceneIndex * 8.3 + 45.1).toFixed(2)}°W`;
    const pct     = Math.round(((sceneIndex + 1) / total) * 100);
    const bar     = "█".repeat(Math.round(pct / 10)) + "░".repeat(10 - Math.round(pct / 10));
    const tcFrame = String(sceneIndex * 24).padStart(2,"0");
    const tc      = `00:00:${String(sceneIndex * Math.ceil(dur)).padStart(2,"0")}:${tcFrame}`;
    return [
        // Esquina superior izquierda — scene counter
        {
            type: "text",
            text: `◈ SCENE ${String(sceneIndex+1).padStart(2,"0")} / ${String(total).padStart(2,"0")}`,
            position: "top-left", duration: dur,
            settings: { "font-size":"17px", "font-family":"Share Tech Mono", "font-color":"#00f5ff",
                        "background-color":"rgba(0,5,20,0.65)", "padding":"10px 18px",
                        "text-shadow":"0 0 12px #00f5ff", "border-left":"2px solid #00f5ff" }
        },
        // Esquina superior derecha — coordenadas GPS
        {
            type: "text", text: coord,
            position: "top-right", duration: dur,
            settings: { "font-size":"15px", "font-family":"Share Tech Mono", "font-color":"rgba(0,245,255,0.8)",
                        "background-color":"rgba(0,5,20,0.55)", "padding":"10px 18px" }
        },
        // Esquina inferior izquierda — timecode
        {
            type: "text", text: `TC ${tc}`,
            position: "bottom-left", duration: dur,
            settings: { "font-size":"13px", "font-family":"Share Tech Mono", "font-color":"rgba(0,245,255,0.5)",
                        "background-color":"rgba(0,0,0,0)", "padding":"14px 18px" }
        },
        // Esquina inferior derecha — progress bar
        {
            type: "text", text: `${bar} ${pct}%`,
            position: "bottom-right", duration: dur,
            settings: { "font-size":"13px", "font-family":"Share Tech Mono", "font-color":"rgba(0,245,255,0.6)",
                        "background-color":"rgba(0,0,0,0)", "padding":"14px 18px" }
        },
    ];
}

// ── Lower Third — barra de info en la parte inferior ──────────────────────────
function makeLowerThird(text, dur) {
    return {
        type: "text", text: text,
        position: "bottom-left", duration: dur,
        settings: {
            "font-size":"22px", "font-family":"Montserrat", "font-weight":"600",
            "font-color":"#ffffff", "background-color":"rgba(0,0,0,0.75)",
            "padding":"10px 24px", "border-left":"3px solid #ff2d78",
            "width":"680px", "text-align":"left",
        }
    };
}

// ── Overlay de color (color grading) ──────────────────────────────────────────
function makeColorGrade(mood, dur) {
    const grade = MOOD_GRADE[mood] || MOOD_GRADE.default;
    if (grade.opacity === 0) return null;
    // Overlay de color sobre toda la escena (LUT simulado)
    return {
        type: "text", text: " ",
        position: "center-center", duration: dur,
        settings: {
            "font-size":"1px",
            "background-color": grade.color,
            "width":"100%", "height":"100%",
            "opacity": String(grade.opacity),
            "mix-blend-mode": "multiply",
        }
    };
}

async function assembleProject(guion, width=720, height=1280, opts={}) {
    // ── Extraer TODAS las opciones (FIX: withParallax y withSFX faltaban) ──────
    const transStyle   = opts.transStyle   || "cinematic";
    const visualStyle  = opts.visualStyle  || "cinematic";
    const voice        = opts.voice        || "es-MX-DaliaNeural";
    const textPos      = opts.textPos      || "bottom";
    const fps          = opts.fps          || 30;
    const moodOvr      = opts.moodOvr      || "auto";
    const withIntro    = opts.withIntro    || false;
    const withOutro    = opts.withOutro    || false;
    const withHUD      = opts.withHUD      || false;
    const withLower    = opts.withLower    || false;
    const withGrade    = opts.withGrade    !== false; // default true
    const kenBurns     = opts.kenBurns     !== false; // default true
    const withParallax = opts.withParallax || false;  // FIX: faltaba
    const withSFX      = opts.withSFX      !== false; // FIX: faltaba, default true
    const withABTest   = opts.withABTest   || false;
    const withKaraoke  = opts.withKaraoke  || false;
    const withChain    = opts.withChain    || false;
    const withCohere   = opts.withCohere   !== false; // default true
    const withThumb    = opts.withThumb    !== false; // default true
    const multiVoice   = opts.multiVoice   || false;
    const withDynMus   = opts.withChapters || false;  // música dinámica activa con capítulos

    // Beat sync: duración ajustada al BPM del mood
    const dur = beatSyncDuration(guion.mood, opts.duration);

    const stylePrompt = STYLE_PROMPTS[visualStyle] || STYLE_PROMPTS.cinematic;
    const musicUrl    = (moodOvr && moodOvr !== "auto")
        ? (MUSIC[moodOvr] || MUSIC.default) : (MUSIC[guion.mood] || MUSIC.default);

    let scenes = (guion.scenes || []).slice(0, 10);

    // Prompt chaining — cada escena referencia la anterior para coherencia narrativa
    if (withChain) {
        scenes = chainVisualPrompts(scenes);
        log.info("Prompt chaining: ON");
    }

    // Visual coherence seed — misma base de paleta para todas las escenas
    const baseSeed      = withCohere ? crypto.randomInt(1000, 99999) : null;
    const coherentSeeds = withCohere ? buildCoherentSeeds(scenes.length, baseSeed) : null;

    const imageUrls = [];

    const localOrderId = opts.orderId || null;
    log.header(`Capa 2: Imágenes | ${visualStyle} | ${transStyle} | Ken Burns: ${kenBurns} | Coherence: ${withCohere}`);

    // Continuidad de personaje — extraer descripción del sujeto principal
    const mainSubject    = guion.subject || "";
    const continuityHint = mainSubject
        ? `same subject: ${mainSubject.slice(0, 50)}`
        : "";

    for (let i = 0; i < scenes.length; i++) {
        // Director de Fotografía — enriquecer el prompt
        let basePrompt  = scenes[i].visual || scenes[i].text || "cinematic scene";

        // A/B Testing — IA elige el mejor prompt visual
        if (withABTest) {
            basePrompt = await improveVisualPrompt(basePrompt, visualStyle, guion.mood);
        }

        const dirPrompt  = directorPrompt(basePrompt, visualStyle);
        // SUJETO PRIMERO: el visual específico de la escena lidera el prompt.
        // stylePrompt va al final como calidad/técnica, no como tema.
        // Estructura: "[lo que pide la escena], [términos cinematográficos], [calidad]"
        const sceneCore  = basePrompt.slice(0, 150); // descripción específica de la escena
        const cinTerms   = directorPrompt("", visualStyle).replace(/^, /, ""); // solo los términos técnicos
        const fullPrompt = sceneCore + ", " + cinTerms.slice(0, 80) + ", " + stylePrompt.slice(0, 60)
            + (continuityHint ? `, ${continuityHint.slice(0, 40)}` : "");
        log.info(`  [${i+1}] Prompt: "${fullPrompt.slice(0,100)}..."`);

        const result  = await getImageUrl(fullPrompt, i, width, height);
        const imgUrl  = typeof result === "string" ? result : result.primary;
        const imgFall = typeof result === "string" ? result : (result.fallbacks?.[0] || result.primary);
        imageUrls.push({ url: imgUrl, fallback: imgFall });

        // SSE — enviar preview en tiempo real al frontend
        if (localOrderId) {
            sseEmit(localOrderId, { type:"image", scene: i+1, total: scenes.length, url: imgUrl });
        }

        if (i < scenes.length - 1) {
            log.info(`  [${i+1}/${scenes.length}] Pausa ${CONFIG.IMG_DELAY_MS/1000}s...`);
            await sleep(CONFIG.IMG_DELAY_MS);
        }
    }

    const real = imageUrls.filter(u => !u.url.includes("loremflickr") && !u.url.includes("dummyimage")).length;
    log.ok(`Imágenes: ${real}/${scenes.length} IA | ${scenes.length - real} fallback | Director mode ON`);
    log.header(`Capa 3: Ensamblaje | Karaoke:${withKaraoke} | MultiVoice:${multiVoice} | DynMusic:${withDynMus} | ABTest:${withABTest}`);

    const assembledScenes = [];

    // ── INTRO ───────────────────────────────────────────────────────────────
    if (withIntro) {
        assembledScenes.push({
            duration: 3,
            elements: [
                { type:"image", src: imageUrls[0]?.url||"", on_error:"ignore", duration:3,
                  extra:{"object-fit":"cover","filter":"blur(10px) brightness(0.3)"} },
                { type:"text", text: guion.title || "OMNIFORGE PRESENTA", position:"center-center", duration:3,
                  settings:{ "font-size":"32px","font-family":"Montserrat","font-weight":"300",
                             "font-color":"#ffffff","background-color":"transparent",
                             "text-align":"center","letter-spacing":"10px","width":"900px" } }
            ]
        });
    }

    // ── ESCENAS PRINCIPALES ─────────────────────────────────────────────────
    scenes.forEach((s, i) => {
        const { position, settings } = getTextSettings(guion.mood, visualStyle, textPos, i);

        // Glitch transitions para estilo cyberpunk, dinámico = flip
        let transition;
        if (i === 0 && !withIntro) {
            transition = null;
        } else if (transStyle === "dynamic" && visualStyle === "cyberpunk") {
            transition = getGlitchTransition(i);
        } else {
            transition = getTransition(transStyle, i);
        }

        // Ken Burns — zoom alternado
        const zoomDir = kenBurns ? (i % 2 === 0 ? "zoom-in" : "zoom-out") : null;

        // Beat sync — duración por intensidad de escena
        const sceneDur = beatSyncDuration(s.intensity === "peak" ? "action" : (s.intensity === "low" ? "calm" : guion.mood), opts.duration) || dur;

        const elements = [
            // ── Imagen principal con Ken Burns ───────────────────────────────
            {
                type:     "image",
                src:      imageUrls[i].url,
                fallback: imageUrls[i].fallback,
                on_error: "ignore",
                duration: sceneDur,
                extra: {
                    "object-fit": "cover",
                    ...(zoomDir ? { "animation": zoomDir, "animation-duration": `${sceneDur}s` } : {}),
                },
            },
        ];

        // ── Viñeta cinematográfica — bordes oscuros en todas las escenas ─────
        // Simula el efecto de lente de cine (vignette) con 4 overlays laterales
        elements.push(
            { type:"text", text:" ", position:"top-center", duration:sceneDur,
              settings:{ "font-size":"1px","background-color":"rgba(0,0,0,0)",
                         "width":"100%","height":"120px",
                         "background":"linear-gradient(to bottom, rgba(0,0,0,0.55), transparent)" }},
            { type:"text", text:" ", position:"bottom-center", duration:sceneDur,
              settings:{ "font-size":"1px","background-color":"rgba(0,0,0,0)",
                         "width":"100%","height":"180px",
                         "background":"linear-gradient(to top, rgba(0,0,0,0.75), transparent)" }},
        );

        // ── Color grading (feat. #14) ─────────────────────────────────────────
        if (withGrade) {
            const grade = makeColorGrade(guion.mood, sceneDur);
            if (grade) elements.push(grade);
        }

        // ── HUD Overlay (feat. #12) ───────────────────────────────────────────
        if (withHUD) {
            elements.push(...makeHUD(i, scenes.length, sceneDur));
        }

        // ── Subtítulos — Karaoke > Parallax > estándar con fade-in ───────────
        if (textPos !== "none") {
            if (withKaraoke) {
                elements.push(...buildKaraokeElements(s.text || "", sceneDur, position, settings));
            } else if (withParallax) {
                elements.push(...makeParallaxOverlay(s.text || "", sceneDur));
            } else {
                // Versión mejorada: el texto aparece a los 0.4s con fade (start)
                elements.push({
                    type:"text", text:(s.text||"").toUpperCase(),
                    position, duration: sceneDur - 0.4, start: 0.4,
                    settings: {
                        ...settings,
                        "animation": "fade-in",
                        "animation-duration": "0.6s",
                    }
                });
            }
        }

        // ── Número de escena flotante (siempre visible, esquina top-right) ───
        if (!withHUD) {
            elements.push({
                type:"text",
                text: `${String(i+1).padStart(2,"0")} / ${String(scenes.length).padStart(2,"0")}`,
                position:"top-right", duration:sceneDur,
                settings:{
                    "font-size":"16px","font-family":"Share Tech Mono",
                    "font-color":"rgba(255,255,255,0.35)","background-color":"transparent",
                    "padding":"16px 20px",
                }
            });
        }

        // ── Shot type label (solo en modo documentary) ────────────────────────
        if (visualStyle === "documentary" && s.shot_type) {
            elements.push({
                type:"text", text: s.shot_type.toUpperCase(),
                position:"top-left", duration: 1.8, start: 0.2,
                settings:{
                    "font-size":"14px","font-family":"Share Tech Mono","font-weight":"400",
                    "font-color":"rgba(255,255,255,0.7)","background-color":"rgba(0,0,0,0.5)",
                    "padding":"8px 16px","letter-spacing":"3px",
                }
            });
        }

        // ── Lower Third con animación de entrada ──────────────────────────────
        if (withLower && s.lower) {
            const lt = makeLowerThird(s.lower, sceneDur - 0.5);
            lt.start = 0.5; // entra 0.5s después del inicio de escena
            elements.push(lt);
        }

        // ── SFX ambient (feat. #7) ─────────────────────────────────────────────
        if (withSFX) {
            const sfxUrl = getSFX(s.sfx, guion.mood);
            if (sfxUrl) elements.push({ type:"audio", src:sfxUrl, volume:0.07, duration:sceneDur, start:0.2 });
        }

        // ── SFX en transición ──────────────────────────────────────────────────
        if (transition && withSFX) {
            const tsfx = getTransitionSFX(transition.style);
            if (tsfx) elements.push(tsfx);
        }

        // ── Voz narradora ──────────────────────────────────────────────────────
        const sceneVoice = multiVoice
            ? getVoiceForRole(s.voice_role || "narrator", voice)
            : voice;
        elements.push({
            type:"voice", model:"azure", voice:sceneVoice,
            text: s.text || "", volume: 1.5,
            duration: sceneDur, start: 0.3,  // 0.3s de entrada antes de hablar
        });

        // ── Música dinámica por capítulo (feat. v13) ───────────────────────────
        const sceneMusic = withDynMus ? getMusicForScene(s, guion.mood) : null;
        if (sceneMusic && i === 0) {
            elements.unshift({ type:"audio", src:sceneMusic.url, volume:0.12, loop:1 });
        }

        assembledScenes.push({
            duration:   sceneDur,
            transition: transition ? { style: transition.style, duration: transition.duration } : undefined,
            elements,
        });
    });

    // ── OUTRO / CRÉDITOS (feat. #20) ────────────────────────────────────────
    if (withOutro) {
        const lastImg = imageUrls[imageUrls.length-1]?.url || "";
        assembledScenes.push({
            duration: 5,
            transition: { style: "fade", duration: 1.2 },
            elements: [
                // Fondo — última imagen muy oscurecida
                { type:"image", src: lastImg, on_error:"ignore", duration:5,
                  extra:{"object-fit":"cover","filter":"brightness(0.15) blur(4px)"} },
                // Overlay negro semi-trans para profundidad
                { type:"text", text:" ", position:"center-center", duration:5,
                  settings:{ "font-size":"1px","background-color":"rgba(0,0,0,0.6)",
                             "width":"100%","height":"100%" } },
                // Línea decorativa superior
                { type:"text", text:"─".repeat(32), position:"center-center", duration:5, start:0.3,
                  settings:{ "font-size":"18px","font-family":"Share Tech Mono",
                             "font-color":"rgba(255,45,120,0.6)","background-color":"transparent",
                             "text-align":"center","width":"900px",
                             "transform":"translateY(-80px)" } },
                // Título del video
                { type:"text", text:(guion.title||"OMNIFORGE").toUpperCase(), position:"center-center", duration:5, start:0.5,
                  settings:{ "font-size":"38px","font-family":"Montserrat","font-weight":"700",
                             "font-color":"#ffffff","background-color":"transparent",
                             "text-align":"center","letter-spacing":"4px","width":"900px",
                             "text-shadow":"0 0 30px rgba(255,45,120,0.8)",
                             "transform":"translateY(-20px)" } },
                // Sub-crédito
                { type:"text", text:"GENERADO CON  OMNIFORGE AI", position:"center-center", duration:5, start:0.8,
                  settings:{ "font-size":"18px","font-family":"Share Tech Mono","font-weight":"400",
                             "font-color":"rgba(0,245,255,0.7)","background-color":"transparent",
                             "text-align":"center","letter-spacing":"8px","width":"900px",
                             "transform":"translateY(30px)" } },
                // Stats bar inferior
                { type:"text",
                  text:`${(guion.mood||"").toUpperCase()}  ·  ${scenes.length} ESCENAS  ·  ${fps} FPS  ·  ${visualStyle.toUpperCase()}`,
                  position:"bottom-center", duration:5, start:1.0,
                  settings:{ "font-size":"14px","font-family":"Share Tech Mono",
                             "font-color":"rgba(255,255,255,0.35)","background-color":"transparent",
                             "padding":"24px","text-align":"center","width":"900px","letter-spacing":"3px" } },
            ]
        });
    }

    // ── Música en la primera escena real (solo si no usa dynamic music) ──────
    const firstIdx = withIntro ? 1 : 0;
    if (!withDynMus && assembledScenes[firstIdx]) {
        assembledScenes[firstIdx].elements.unshift({ type:"audio", src:musicUrl, volume:0.12, loop:1 });
    }

    // ── Thumbnail — generateThumbnail para mejor calidad, o fallback a escena central ──
    let thumbnailUrl = imageUrls[Math.floor(imageUrls.length / 2)]?.url || imageUrls[0]?.url || null;
    if (withThumb && baseSeed) {
        const generated = await generateThumbnail(scenes, guion.title, visualStyle, baseSeed);
        if (generated) thumbnailUrl = generated;
    }

    const totalDuration = assembledScenes.reduce((s, sc) => s + (sc.duration || 6), 0);
    log.ok(`Ensamblado: ${assembledScenes.length} escenas | ${totalDuration}s total | Grade:${withGrade} HUD:${withHUD} Karaoke:${withKaraoke} MultiVoice:${multiVoice}`);

    // ── Payload completo para Json2Video ─────────────────────────────────────
    // Campos verificados contra la documentación oficial de Json2Video v2.
    // ELIMINADOS: fonts, exports, cache (no son campos válidos → error 400).
    const projectPayload = {
        // ── Resolución personalizada ─────────────────────────────────────────
        resolution: "custom",
        width,
        height,

        // ── Calidad y rendimiento ─────────────────────────────────────────────
        quality: "high",       // "high" = bitrate máximo, sin compresión lossy extra
        fps,                   // 24 | 30 | 60

        // ── Escenas ───────────────────────────────────────────────────────────
        scenes: assembledScenes,
    };

    // Log del payload para diagnóstico (sin las URLs de imagen para no ensuciar)
    const payloadSummary = {
        resolution: `${width}x${height}`,
        quality: projectPayload.quality,
        fps,
        scenes: assembledScenes.length,
        totalDuration: `${totalDuration}s`,
        elementsPerScene: assembledScenes.map((sc,i) => `s${i+1}:${sc.elements.length}el`).join(" "),
    };
    log.info(`Payload J2V: ${JSON.stringify(payloadSummary)}`);

    return {
        projectPayload,
        thumbnailUrl,
        sceneCount: assembledScenes.length,
        totalDuration,
        mood:       guion.mood,
        title:      guion.title,
    };
}



// SSE — progreso en tiempo real de generación de imágenes (feat. #23)
const sseClients = new Map();

app.get("/progress/:orderId", (req, res) => {
    res.setHeader("Content-Type",  "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection",    "keep-alive");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.flushHeaders();

    const id = req.params.orderId;
    sseClients.set(id, res);

    req.on("close", () => sseClients.delete(id));
});

function sseEmit(orderId, data) {
    const client = sseClients.get(orderId);
    if (client) client.write(`data: ${JSON.stringify(data)}\n\n`);
}

// ============================================================================
// 🌐  MIDDLEWARES
// ============================================================================
app.use(cors());
app.use(express.json({ limit:"10mb" }));
app.use(express.static(__dirname));

// ============================================================================
// 🛣️  ENDPOINT PRINCIPAL
// ============================================================================
app.post("/generate", limiterGenerate, async (req, res) => {
    const { text, numEscenas } = req.body;
    if (!text || String(text).trim().length < 3) return res.status(400).json({ error:"Prompt invalido." });

    const count       = Math.min(Math.max(parseInt(numEscenas)||3, 1), 10);
    const fmt         = req.body.format        || "portrait";
    const duration    = req.body.duration      ? Math.min(Math.max(parseInt(req.body.duration),3),12) : null;
    const transStyle  = req.body.transStyle    || "cinematic";
    const visualStyle = req.body.visualStyle   || "cinematic";
    const voice       = req.body.voice         || "es-MX-DaliaNeural";
    const moodOvr     = req.body.musicOverride || "auto";
    const textPos     = req.body.textPos       || "bottom";
    const fps         = [24,30,60].includes(+req.body.fps) ? +req.body.fps : 30;
    const tone        = req.body.tone          || "epic and dramatic";
    const withIntro   = req.body.withIntro     === true || req.body.withIntro  === "true";
    const withOutro   = req.body.withOutro     === true || req.body.withOutro  === "true";
    const withHUD     = req.body.withHUD       === true || req.body.withHUD    === "true";
    const withLower   = req.body.withLower     !== false && req.body.withLower !== "false";
    const withGrade   = req.body.withGrade     !== false && req.body.withGrade !== "false";
    const kenBurns    = req.body.kenBurns      !== false && req.body.kenBurns  !== "false";
    const withABTest  = req.body.withABTest    === true  || req.body.withABTest=== "true";
    const withSFX     = req.body.withSFX       !== false && req.body.withSFX   !== "false";
    const withParallax= req.body.withParallax  === true  || req.body.withParallax==="true";
    const targetLang  = req.body.targetLang    || null;
    const webhookUrl  = req.body.webhookUrl    || null;
    const withChapters= req.body.withChapters  === true  || req.body.withChapters==="true";
    const withDocShots= req.body.withDocShots  === true  || req.body.withDocShots==="true";
    const multiVoice  = req.body.multiVoice    === true  || req.body.multiVoice==="true";
    const withKaraoke = req.body.withKaraoke   === true  || req.body.withKaraoke==="true";
    const withChain   = req.body.withChain     === true  || req.body.withChain==="true";
    const withCohere  = req.body.withCohere    !== false && req.body.withCohere!=="false";
    const withThumb   = req.body.withThumb     !== false && req.body.withThumb !=="false";
    const useQueue    = req.body.useQueue      === true  || req.body.useQueue  ==="true";
    const templateId  = req.body.templateId    || null;

    const FORMATS  = { portrait:{w:720,h:1280}, landscape:{w:1280,h:720}, square:{w:1080,h:1080} };
    const { w, h } = FORMATS[fmt] || FORMATS.portrait;
    const orderId  = crypto.randomBytes(3).toString("hex").toUpperCase();

    const opts = {
        duration, transStyle, visualStyle, voice, moodOvr, textPos, fps, tone,
        withIntro, withOutro, withHUD, withLower, withGrade, kenBurns,
        withABTest, withSFX, withParallax, targetLang, webhookUrl,
        withChapters, withDocShots, multiVoice, withKaraoke, withChain,
        withCohere, withThumb, orderId,
    };

    log.header(`NUEVA ORDEN: OMNI-${orderId}`);
    log.info(`${fmt} ${w}x${h} | ${count} escenas | ${fps}fps | ${visualStyle} | ${transStyle}`);
    log.info(`Caps:${withChapters} Doc:${withDocShots} Karaoke:${withKaraoke} Chain:${withChain} Thumb:${withThumb} Queue:${useQueue}`);

    // Si useQueue, no espera — responde inmediato
    if (useQueue) {
        const result = await enqueueJob({ text: text.trim(), numEscenas: count, opts });
        return res.json({ queued: true, ...result });
    }

    try {
        const guion = await getScript(text.trim(), count, tone, opts);
        if (!guion) throw new Error("Sin guion.");

        // Guardar en DB
        dbSaveProject({ id:orderId, prompt:text, mood:guion.mood, title:guion.title,
                        scenes:count, format:fmt, style:visualStyle, status:"generating", opts });

        const { projectPayload, thumbnailUrl, sceneCount } = await assembleProject(guion, w, h, opts);

        dbUpdateProject(orderId, { status: "rendering" });

        log.header("Fase Final: Json2Video");
        const resp = await axios.post("https://api.json2video.com/v2/movies", projectPayload,
            { headers:{ "x-api-key":CONFIG.JSON2VIDEO_KEY, "Content-Type":"application/json" }, timeout:45000 });

        const pid = resp.data.project || resp.data.id;
        if (!pid) throw new Error(`Sin Project ID: ${JSON.stringify(resp.data).slice(0,200)}`);

        dbUpdateProject(orderId, { j2v_id: pid, thumbnail: thumbnailUrl || null });
        log.ok(`${C.bold}EXITO! ID: ${pid}${C.reset}`);

        // Webhook
        if (webhookUrl) {
            axios.post(webhookUrl, { content:`🎬 **OmniForge** — Video en render!\n**ID:** ${pid}\n**Mood:** ${guion.mood}\n**Título:** ${guion.title||""}` })
                .then(() => log.ok("Webhook enviado"))
                .catch(e => log.warn("Webhook fallo: " + e.message));
        }

        res.json({ success:true, project:pid, orderId, scenes:guion.scenes,
                   mood:guion.mood, title:guion.title, thumbnail:thumbnailUrl, sceneCount });

    } catch(e) {
        const detail = e.response?.data ? JSON.stringify(e.response.data).slice(0,500) : e.message;
        log.error("Fallo en /generate", detail);
        dbUpdateProject(orderId, { status:"error" });
        res.status(500).json({ error:detail });
    }
});

async function runFullPipeline(job) {
    // Used by the queue processor — same as /generate but without HTTP context
    const { text, numEscenas=3, opts={} } = job;
    const FORMATS = { portrait:{w:720,h:1280}, landscape:{w:1280,h:720}, square:{w:1080,h:1080} };
    const { w, h } = FORMATS[opts.format] || FORMATS.portrait;
    const guion = await getScript(text, numEscenas, opts.tone||"epic and dramatic", opts);
    const { projectPayload } = await assembleProject(guion, w, h, opts);
    const resp = await axios.post("https://api.json2video.com/v2/movies", projectPayload,
        { headers:{ "x-api-key":CONFIG.JSON2VIDEO_KEY, "Content-Type":"application/json" }, timeout:45000 });
    const pid = resp.data.project || resp.data.id;
    log.ok(`Cola job ${job.jobId} completado: ${pid}`);
    if (db) dbUpdateProject(job.jobId, { status:"done", j2v_id:pid });
}


app.get("/status/:id", limiterStatus, async (req, res) => {
    try {
        const r     = await axios.get(`https://api.json2video.com/v2/movies?project=${req.params.id}`, { headers:{ "x-api-key":CONFIG.JSON2VIDEO_KEY }, timeout:15000 });
        // Loggear la respuesta cruda para diagnosticar statuses desconocidos
        const raw   = r.data;
        const movie = raw.movie || (raw.movies && raw.movies[0]) || raw;
        log.info(`Status [${req.params.id}]: raw_status="${movie.status}" has_url=${!!movie.url} keys=${Object.keys(movie).join(",")}`);
        if (!movie || !movie.status) return res.json({ status:"inprogress", url:null });
        if (movie.status === "error" || movie.status === "failed") {
            log.error(`Render fallido [${req.params.id}]`, movie.message || movie.error || JSON.stringify(movie).slice(0,200));
        }
        res.json({ status: movie.status, url: movie.url || movie.download_url || movie.video_url || null });
    } catch(e) {
        log.warn(`Status poll fallo [${req.params.id}]: ${e.message}`);
        res.status(500).json({ error:e.message });
    }
});


// ============================================================================
// 🩺  HEALTH DETAIL — estado real de cada servicio (para el panel del frontend)
// ============================================================================
app.get("/health/detail", async (req, res) => {
    const checks = [
        {
            key: "openrouter",
            label: "OpenRouter",
            icon: "🤖",
            test: () => axios.get("https://openrouter.ai/api/v1/models",
                { headers: { "Authorization": `Bearer ${CONFIG.OPENROUTER_KEY}` }, timeout: 7000 })
        },
        {
            key: "aiml_image",
            label: "AIML / Imagen",
            icon: "🖼",
            test: () => axios.get("https://api.aimlapi.com/v1/models",
                { headers: { "Authorization": `Bearer ${CONFIG.AICC_KEY}` }, timeout: 7000 })
        },
        {
            key: "aiml_video",
            label: "AIML / Video",
            icon: "🎬",
            test: () => axios.get("https://api.aimlapi.com/v2/video/generations",
                { headers: { "Authorization": `Bearer ${CONFIG.AICC_KEY}` }, timeout: 7000 })
        },
        {
            key: "json2video",
            label: "Json2Video",
            icon: "🎞",
            test: () => axios.get("https://api.json2video.com/v2/movies",
                { headers: { "x-api-key": CONFIG.JSON2VIDEO_KEY }, timeout: 7000 })
        },
        {
            key: "imgbb",
            label: "ImgBB",
            icon: "📸",
            test: () => axios.head(`https://api.imgbb.com/1/upload?key=${CONFIG.IMGBB_KEY}`, { timeout: 6000 })
        },
        {
            key: "pollinations",
            label: "Pollinations",
            icon: "🌸",
            test: () => axios.head("https://image.pollinations.ai/", { timeout: 6000 })
        },
        {
            key: "picsum",
            label: "Picsum CDN",
            icon: "🎨",
            test: () => axios.head("https://picsum.photos/10/10.jpg", { timeout: 5000 })
        },
        {
            key: "soundhelix",
            label: "SoundHelix",
            icon: "🎵",
            test: () => axios.head("https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3", { timeout: 5000 })
        },
    ];

    const t0 = Date.now();
    const results = await Promise.allSettled(
        checks.map(async c => {
            const start = Date.now();
            try {
                const r = await c.test();
                return { key: c.key, label: c.label, icon: c.icon,
                         ok: true, ms: Date.now() - start,
                         status: r.status || 200 };
            } catch(e) {
                // 4xx != service down for POST-only endpoints (like imgBB HEAD)
                const code = e.response?.status;
                const ok = code && code < 500;
                return { key: c.key, label: c.label, icon: c.icon,
                         ok, ms: Date.now() - start,
                         status: code || 0, error: ok ? null : e.message.slice(0, 80) };
            }
        })
    );

    const services = results.map(r => r.value || r.reason);
    const allOk = services.every(s => s.ok);
    res.json({
        ok: allOk,
        version: CONFIG.VERSION,
        uptime: Math.floor(process.uptime()),
        totalMs: Date.now() - t0,
        services,
        videoModels: [
            { id: "google/veo-3.1-t2v-fast", label: "Veo 3.1 Fast", tier: "video", endpoint: "https://api.aimlapi.com/v2/video/generations" },
            { id: "openai/sora-2-t2v",        label: "Sora 2",        tier: "video", endpoint: "https://api.aimlapi.com/v2/video/generations" },
        ],
        imageModels: [
            { id: "black-forest-labs/FLUX.1-schnell", label: "Flux Schnell", tier: "image" },
            { id: "black-forest-labs/FLUX.1-dev",     label: "Flux Dev",     tier: "image" },
        ],
    });
});

app.get("/health", (req, res) => res.json({ ok:true, version:CONFIG.VERSION }));

// ============================================================================
// 🗄️  DATABASE — SQLite para historial, plantillas, cola
// ============================================================================
let db = null;

function initDB() {
    if (!Database) { log.warn("better-sqlite3 no instalado — historial deshabilitado. Corre: npm install"); return; }
    try {
        fs.mkdirSync(path.join(__dirname, "data"), { recursive: true });
        db = new Database(path.join(__dirname, "data", "omniforge.db"));
        db.exec(`
            CREATE TABLE IF NOT EXISTS projects (
                id          TEXT PRIMARY KEY,
                created_at  TEXT NOT NULL,
                prompt      TEXT NOT NULL,
                mood        TEXT,
                title       TEXT,
                scenes      INTEGER,
                format      TEXT,
                style       TEXT,
                status      TEXT DEFAULT 'pending',
                j2v_id      TEXT,
                video_url   TEXT,
                thumbnail   TEXT,
                duration_s  INTEGER,
                opts        TEXT
            );
            CREATE TABLE IF NOT EXISTS templates (
                id          TEXT PRIMARY KEY,
                name        TEXT NOT NULL,
                description TEXT,
                created_at  TEXT NOT NULL,
                opts        TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS queue (
                id          TEXT PRIMARY KEY,
                position    INTEGER,
                prompt      TEXT NOT NULL,
                opts        TEXT,
                status      TEXT DEFAULT 'waiting',
                created_at  TEXT NOT NULL
            );
        `);
        log.ok("Base de datos SQLite inicializada");
    } catch(e) {
        log.warn("DB init fallo: " + e.message);
        db = null;
    }
}

function dbSaveProject(data) {
    if (!db) return;
    try {
        db.prepare(`INSERT OR REPLACE INTO projects
            (id,created_at,prompt,mood,title,scenes,format,style,status,j2v_id,video_url,thumbnail,duration_s,opts)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(data.id, new Date().toISOString(), data.prompt, data.mood, data.title,
             data.scenes, data.format, data.style, data.status, data.j2v_id,
             data.video_url, data.thumbnail, data.duration_s, JSON.stringify(data.opts||{}));
    } catch(e) { log.warn("DB save fallo: " + e.message); }
}

function dbUpdateProject(id, fields) {
    if (!db) return;
    try {
        const sets = Object.keys(fields).map(k => `${k}=?`).join(",");
        db.prepare(`UPDATE projects SET ${sets} WHERE id=?`)
          .run(...Object.values(fields), id);
    } catch(e) { log.warn("DB update fallo: " + e.message); }
}

// ============================================================================
// 📋  JOB QUEUE — cola de videos
// ============================================================================
const jobQueue = [];
let isProcessing = false;

async function enqueueJob(jobData) {
    const jobId = crypto.randomBytes(4).toString("hex").toUpperCase();
    jobQueue.push({ ...jobData, jobId, status: "waiting", addedAt: Date.now() });
    log.info(`Cola: job ${jobId} agregado (posición ${jobQueue.length})`);

    if (!isProcessing) processQueue();
    return { jobId, position: jobQueue.length };
}

async function processQueue() {
    isProcessing = true;
    while (jobQueue.length > 0) {
        const job = jobQueue.shift();
        job.status = "processing";
        log.header(`COLA: Procesando job ${job.jobId}`);
        try {
            await runFullPipeline(job);
        } catch(e) {
            log.error(`Cola: job ${job.jobId} fallo`, e.message);
        }
    }
    isProcessing = false;
}

// ============================================================================
// 🎬  KARAOKE SUBTITLES — word-by-word timing
// ============================================================================
// Json2Video no soporta word-level timing nativo, así que simulamos
// dividiendo el texto en chunks y usando múltiples elementos de texto
// con duraciones proporcionales a la cantidad de palabras
function buildKaraokeElements(text, totalDur, position, baseSettings) {
    const words = (text || "").split(" ").filter(Boolean);
    if (words.length === 0) return [];

    const chunks = [];
    const chunkSize = Math.max(2, Math.ceil(words.length / 4)); // 4 chunks max
    for (let i = 0; i < words.length; i += chunkSize) {
        chunks.push(words.slice(i, i + chunkSize).join(" "));
    }

    const chunkDur = totalDur / chunks.length;
    return chunks.map((chunk, i) => ({
        type:     "text",
        text:     chunk.toUpperCase(),
        position: position,
        start:    i * chunkDur,
        duration: chunkDur,
        settings: {
            ...baseSettings,
            "font-size":   i === Math.floor(chunks.length / 2) ? "52px" : "44px",  // destaca el centro
            "font-color":  i === Math.floor(chunks.length / 2) ? "#ffe033" : "#ffffff",
            "transition":  "fade",
        }
    }));
}

// ============================================================================
// 🎵  DYNAMIC MUSIC — intensidad por capítulo/escena
// ============================================================================
const MUSIC_BY_INTENSITY = {
    low:    "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-9.mp3",
    medium: "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-2.mp3",
    high:   "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3",
    peak:   "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-4.mp3",
};

const CHAPTER_INTENSITY = {
    intro:       "low",
    development: "medium",
    climax:      "peak",
    outro:       "low",
    main:        "medium",
};

function getMusicForScene(scene, globalMood) {
    const intensity = scene.intensity || CHAPTER_INTENSITY[scene.chapter || "main"] || "medium";
    return { url: MUSIC_BY_INTENSITY[intensity] || MUSIC[globalMood] || MUSIC.default, intensity };
}

// ============================================================================
// 💥  SFX ON TRANSITIONS — whoosh, glitch, impact
// ============================================================================
// TRANSITION_SFX_KEYS — lee sfxCache (fuentes en SFX_LIBRARY)
const TRANSITION_SFX_KEYS = {
    "fade":        null,
    "zoom":        "trans_zoom",
    "slide-left":  "trans_slide_left",
    "slide-right": "trans_slide_right",
    "flip":        "trans_flip",
    "wipe-left":   null,
    "wipe-right":  null,
};

function getTransitionSFX(transStyle) {
    const key = TRANSITION_SFX_KEYS[transStyle];
    if (!key) return null;
    const url = sfxCache.get(key);
    if (!url) return null;
    return { type:"audio", src:url, volume:0.15, duration:0.8 };
}

// ============================================================================
// 🎨  VISUAL COHERENCE — mismo seed base para paleta consistente
// ============================================================================
function buildCoherentSeeds(sceneCount, baseSeed) {
    // Variaciones pequeñas del seed base para mantener la paleta pero variar la imagen
    return Array.from({length: sceneCount}, (_, i) => baseSeed + (i * 137));  // 137 = número primo para distribuir
}

// ============================================================================
// 🔗  PROMPT CHAINING — cada escena referencia la anterior
// ============================================================================
function chainVisualPrompts(scenes) {
    return scenes.map((s, i) => {
        if (i === 0) return s;
        const prev = scenes[i - 1];
        const prevKeyword = (prev.visual || "").split(",")[0].trim().split(" ").slice(-2).join(" ");
        return {
            ...s,
            visual: `Continuing from ${prevKeyword}, ${s.visual}`
        };
    });
}

// ============================================================================
// 🖼️  THUMBNAIL GENERATOR — escena central con título dramático
// ============================================================================
async function generateThumbnail(scenes, title, visualStyle, baseSeed) {
    const centerIdx = Math.floor(scenes.length / 2);
    const scene     = scenes[centerIdx];
    if (!scene) return null;

    try {
        const stylePrompt = STYLE_PROMPTS[visualStyle] || STYLE_PROMPTS.cinematic;
        const thumbPrompt = cleanPrompt(scene.visual || scene.text).slice(0, 120);
        const seed        = baseSeed + 9999;
        const enc         = encodeURIComponent(thumbPrompt + ", cinematic, high contrast, thumbnail composition");
        const thumbUrl    = `https://image.pollinations.ai/prompt/${enc}?width=1280&height=720&nologo=true&seed=${seed}&model=flux`;

        log.info(`Thumbnail: generando para "${title?.slice(0,40) || "video"}"`);
        await sleep(8000); // Pollinations necesita tiempo para generar
        const stableUrl = await downloadAndUpload(thumbUrl, 99);
        log.ok(`Thumbnail listo: ${stableUrl}`);
        return stableUrl;
    } catch(e) {
        log.warn(`Thumbnail fallo: ${e.message.slice(0,60)}`);
        return null;
    }
}

// ============================================================================
// 🎭  MULTI-VOICE — narrador + personaje secundario
// ============================================================================
const VOICE_MAP = {
    narrator:  "es-MX-DaliaNeural",
    character: "es-MX-JorgeNeural",
    narrator_m:"es-MX-JorgeNeural",
    character_f:"es-MX-DaliaNeural",
};

function getVoiceForRole(role, overrideVoice) {
    if (overrideVoice && overrideVoice !== "auto") return overrideVoice;
    return VOICE_MAP[role] || VOICE_MAP.narrator;
}

// ============================================================================
// 📡  ENDPOINTS NUEVOS
// ============================================================================

// ── PREVIEW — genera solo la primera escena ──────────────────────────────────
app.post("/preview", async (req, res) => {
    const { text, visualStyle="cinematic", format="portrait" } = req.body;
    if (!text) return res.status(400).json({ error: "Falta el prompt." });

    const FORMATS = { portrait:{w:720,h:1280}, landscape:{w:1280,h:720}, square:{w:1080,h:1080} };
    const { w, h } = FORMATS[format] || FORMATS.portrait;
    const orderId  = crypto.randomBytes(3).toString("hex").toUpperCase();
    log.header(`PREVIEW: OMNI-${orderId}`);

    try {
        const guion = await getScript(text, 1, "cinematic neutral tone");
        if (!guion?.scenes?.[0]) throw new Error("Sin escena");

        const scene  = guion.scenes[0];
        const style  = STYLE_PROMPTS[visualStyle] || STYLE_PROMPTS.cinematic;
        const prompt = directorPrompt(scene.visual || scene.text, visualStyle) + ", " + style;
        const result = await getImageUrl(prompt, 0, w, h);
        const url    = typeof result === "string" ? result : result.primary;

        log.ok(`Preview listo: ${url}`);
        res.json({ success: true, imageUrl: url, scene: scene, title: guion.title });
    } catch(e) {
        res.status(500).json({ error: e.message });
    }
});

// ── RE-RENDER ESCENA INDIVIDUAL ──────────────────────────────────────────────
app.post("/rerender-scene", async (req, res) => {
    const { sceneIdx, visual, style="cinematic", format="portrait" } = req.body;
    if (!visual) return res.status(400).json({ error: "Falta el prompt visual." });

    const FORMATS = { portrait:{w:720,h:1280}, landscape:{w:1280,h:720}, square:{w:1080,h:1080} };
    const { w, h } = FORMATS[format] || FORMATS.portrait;

    log.info(`Re-render escena ${sceneIdx}: "${visual.slice(0,60)}"`);
    try {
        const prompt = directorPrompt(cleanPrompt(visual), style) + ", " + (STYLE_PROMPTS[style] || STYLE_PROMPTS.cinematic);
        const result = await getImageUrl(prompt, sceneIdx || 0, w, h);
        const url    = typeof result === "string" ? result : result.primary;
        log.ok(`Re-render listo: ${url}`);
        res.json({ success: true, imageUrl: url });
    } catch(e) {
        res.status(500).json({ error: e.message });
    }
});

// ── HISTORIAL ────────────────────────────────────────────────────────────────
app.get("/history", (req, res) => {
    if (!db) return res.json({ projects: [], message: "DB no disponible" });
    try {
        const projects = db.prepare(
            "SELECT id,created_at,prompt,mood,title,scenes,format,style,status,video_url,thumbnail FROM projects ORDER BY created_at DESC LIMIT 50"
        ).all();
        res.json({ projects });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete("/history/:id", (req, res) => {
    if (!db) return res.status(503).json({ error: "DB no disponible" });
    try {
        db.prepare("DELETE FROM projects WHERE id=?").run(req.params.id);
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── PLANTILLAS ───────────────────────────────────────────────────────────────
app.get("/templates", (req, res) => {
    if (!db) return res.json({ templates: getDefaultTemplates() });
    try {
        const saved = db.prepare("SELECT * FROM templates ORDER BY created_at DESC").all()
            .map(t => ({ ...t, opts: JSON.parse(t.opts) }));
        res.json({ templates: [...getDefaultTemplates(), ...saved] });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post("/templates", (req, res) => {
    if (!db) return res.status(503).json({ error: "DB no disponible" });
    const { name, description, opts } = req.body;
    if (!name || !opts) return res.status(400).json({ error: "Faltan name u opts" });
    try {
        const id = crypto.randomBytes(4).toString("hex");
        db.prepare("INSERT INTO templates (id,name,description,created_at,opts) VALUES (?,?,?,?,?)")
          .run(id, name, description||"", new Date().toISOString(), JSON.stringify(opts));
        res.json({ success: true, id });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete("/templates/:id", (req, res) => {
    if (!db) return res.status(503).json({ error: "DB no disponible" });
    try {
        db.prepare("DELETE FROM templates WHERE id=?").run(req.params.id);
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

function getDefaultTemplates() {
    return [
        { id:"tpl-cinema",  name:"🎬 Cinematográfico",  description:"Hollywood, bokeh, film grain",  opts:{visualStyle:"cinematic",transStyle:"cinematic",fps:24,withGrade:true,kenBurns:true,withHUD:false} },
        { id:"tpl-cyber",   name:"⚡ Cyberpunk",        description:"Neon, glitch, futurista",        opts:{visualStyle:"cyberpunk", transStyle:"dynamic",  fps:30,withGrade:true,kenBurns:true,withHUD:true} },
        { id:"tpl-anime",   name:"🌸 Anime",            description:"Studio Ghibli, vibrant colors",  opts:{visualStyle:"anime",     transStyle:"smooth",   fps:24,withGrade:false,kenBurns:false} },
        { id:"tpl-docu",    name:"📷 Documental",       description:"National Geographic style",      opts:{visualStyle:"documentary",transStyle:"smooth",  fps:30,withDocShots:true,withLower:true} },
        { id:"tpl-horror",  name:"😱 Terror",           description:"Horror, oscuro, tenso",          opts:{visualStyle:"cinematic", transStyle:"dynamic",  fps:24,withGrade:true,tone:"scary and terrifying",moodOvr:"horror"} },
        { id:"tpl-fantasy", name:"🔮 Fantasía Épica",  description:"Magia, dragones, épico",          opts:{visualStyle:"fantasy",   transStyle:"cinematic",fps:30,withChapters:true,withIntro:true,withOutro:true} },
    ];
}

// ── COLA ─────────────────────────────────────────────────────────────────────
app.post("/queue", limiterGenerate, async (req, res) => {
    const { text, numEscenas, ...rest } = req.body;
    if (!text) return res.status(400).json({ error: "Falta el prompt." });
    const result = await enqueueJob({ text, numEscenas: parseInt(numEscenas)||3, opts: rest });
    res.json({ success: true, ...result, queueLength: jobQueue.length });
});

app.get("/queue", (req, res) => {
    res.json({
        length:      jobQueue.length,
        processing:  isProcessing,
        jobs:        jobQueue.map(j => ({ id:j.jobId, status:j.status, addedAt:j.addedAt }))
    });
});

// ── SWAGGER DOCS ─────────────────────────────────────────────────────────────
const swaggerDoc = {
    openapi: "3.0.0",
    info: { title: "OmniForge API", version: CONFIG.VERSION, description: "Pipeline de video IA" },
    servers: [{ url: `http://localhost:${CONFIG.PORT}` }],
    paths: {
        "/generate":      { post: { summary: "Genera un video completo", tags:["Core"] } },
        "/preview":       { post: { summary: "Preview de la primera escena (rápido)", tags:["Core"] } },
        "/rerender-scene":{ post: { summary: "Re-renderiza una escena individual", tags:["Core"] } },
        "/status/{id}":   { get:  { summary: "Consulta estado del render en Json2Video", tags:["Status"] } },
        "/history":       { get:  { summary: "Historial de proyectos generados", tags:["History"] } },
        "/templates":     { get:  { summary: "Plantillas de configuración", tags:["Templates"] },
                           post:  { summary: "Guarda una nueva plantilla", tags:["Templates"] } },
        "/queue":         { get:  { summary: "Estado de la cola de procesamiento", tags:["Queue"] },
                           post:  { summary: "Agrega un job a la cola", tags:["Queue"] } },
        "/health":        { get:  { summary: "Estado del servidor", tags:["System"] } },
    }
};

app.get("/api-docs.json", (req, res) => res.json(swaggerDoc));
app.get("/api-docs", (req, res) => {
    res.send(`<!DOCTYPE html><html><head><title>OmniForge API Docs</title>
<link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist/swagger-ui.css">
</head><body>
<div id="swagger-ui"></div>
<script src="https://unpkg.com/swagger-ui-dist/swagger-ui-bundle.js"></script>
<script>SwaggerUIBundle({url:"/api-docs.json",dom_id:"#swagger-ui",presets:[SwaggerUIBundle.presets.apis,SwaggerUIBundle.SwaggerUIStandalonePreset]})</script>
</body></html>`);
});

// ── GENERATE PRINCIPAL (con todas las nuevas features) ─────────────────────

// ============================================================================
// 🚀  ARRANQUE
// ============================================================================
initDB();
warmSfxCache();

// ── Startup diagnóstico: verifica conectividad de cada servicio ────────────
async function runStartupChecks() {
    const checks = [
        { name: "OpenRouter",   url: "https://openrouter.ai/api/v1/models",                   headers: { "Authorization": `Bearer ${CONFIG.OPENROUTER_KEY}` } },
        { name: "AIML API",     url: "https://api.aimlapi.com/v1/models",                      headers: { "Authorization": `Bearer ${CONFIG.AICC_KEY}` } },
        { name: "imgBB",        url: `https://api.imgbb.com/1/upload?key=${CONFIG.IMGBB_KEY}`, headers: {} },
        { name: "Json2Video",   url: "https://api.json2video.com/v2/movies",                   headers: { "x-api-key": CONFIG.JSON2VIDEO_KEY } },
        { name: "Pollinations", url: "https://image.pollinations.ai/",                         headers: {} },
        { name: "Picsum",       url: "https://picsum.photos/10/10.jpg",                        headers: {} },
        { name: "SoundHelix",   url: "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3", headers: {} },
    ];
    const results = await Promise.allSettled(
        checks.map(c => axios.head(c.url, { headers: c.headers, timeout: 6000 }).then(() => ({ ...c, ok: true })).catch(e => ({ ...c, ok: e.response?.status < 500 })))
    );
    return results.map(r => r.value || r.reason);
}

const server = app.listen(CONFIG.PORT, async () => {
    console.clear();

    // ── BANNER ──────────────────────────────────────────────────────────────
    const W = 70;
    const drawLine = (ch) => `${C.magenta}${ch.repeat(W)}${C.reset}`;
    const blank = () => console.log(`${C.magenta}║${C.reset}${" ".repeat(W-2)}${C.magenta}║${C.reset}`);
    const row   = (txt, color=C.reset) => {
        const pad = W - 4 - txt.replace(/\x1b\[[0-9;]*m/g,"").length;
        console.log(`${C.magenta}║${C.reset}  ${color}${txt}${C.reset}${" ".repeat(Math.max(0,pad))}${C.magenta}║${C.reset}`);
    };

    console.log(`${C.magenta}╔${"═".repeat(W-2)}╗${C.reset}`);
    blank();
    row(`  ██████╗ ███╗   ███╗███╗   ██╗██╗    ███████╗ ██████╗ ██████╗  ██████╗ ███████╗`, C.magenta);
    row(` ██╔═══██╗████╗ ████║████╗  ██║██║    ██╔════╝██╔═══██╗██╔══██╗██╔════╝ ██╔════╝`, C.magenta);
    row(` ██║   ██║██╔████╔██║██╔██╗ ██║██║    █████╗  ██║   ██║██████╔╝██║  ███╗█████╗  `, C.cyan);
    row(` ██║   ██║██║╚██╔╝██║██║╚██╗██║██║    ██╔══╝  ██║   ██║██╔══██╗██║   ██║██╔══╝  `, C.cyan);
    row(` ╚██████╔╝██║ ╚═╝ ██║██║ ╚████║██║    ██║     ╚██████╔╝██║  ██║╚██████╔╝███████╗`, C.magenta);
    row(`  ╚═════╝ ╚═╝     ╚═╝╚═╝  ╚═══╝╚═╝    ╚═╝      ╚═════╝ ╚═╝  ╚═╝ ╚═════╝ ╚══════╝`, C.magenta);
    blank();
    row(`  AI VIDEO PIPELINE ENGINE  ·  v${CONFIG.VERSION}  ·  node ${process.version}`, C.yellow);
    row(`  ${new Date().toLocaleString("es-AR")}  ·  PID ${process.pid}  ·  port ${CONFIG.PORT}`, C.fg2);
    blank();
    console.log(`${C.magenta}╠${"═".repeat(W-2)}╣${C.reset}`);
    blank();

    // ── PIPELINE ────────────────────────────────────────────────────────────
    row("  📽  PIPELINE DE GENERACIÓN", C.cyan);
    blank();
    row(`  ${C.bold}TEXTO${C.reset}   ${TEXT_MODELS.map(m=>`${C.green}${m.label}${C.reset}`).join(` ${C.fg2}→${C.reset} `)}`);
    row(`  ${C.bold}VIDEO${C.reset}   ${VIDEO_MODELS.map(m=>`${C.magenta}${m.label}${C.reset}`).join(` ${C.fg2}→${C.reset} `)} ${C.fg2}(Tier 0 — AIML)${C.reset}`);
    row(`  ${C.bold}IMAGEN${C.reset}  ${C.green}AIML/Flux${C.reset} ${C.fg2}→${C.reset} ${C.green}Pollinations/flux${C.reset} ${C.fg2}→${C.reset} ${C.green}Picsum CDN${C.reset} ${C.fg2}(fallback)${C.reset}`);
    row(`  ${C.bold}AUDIO${C.reset}   ${C.green}Azure TTS${C.reset} ${C.fg2}+${C.reset} ${C.green}SoundHelix Music${C.reset} ${C.fg2}+${C.reset} ${C.green}SFX Layer${C.reset}`);
    row(`  ${C.bold}RENDER${C.reset}  ${C.green}Json2Video API${C.reset} ${C.fg2}(cloud render, HD)${C.reset}`);
    blank();
    console.log(`${C.magenta}╠${"═".repeat(W-2)}╣${C.reset}`);
    blank();

    // ── FEATURES ────────────────────────────────────────────────────────────
    row("  ⚡ FEATURES ACTIVAS", C.yellow);
    blank();
    const feats = [
        ["Ken Burns", "zoom-in/out alternado por escena"],
        ["Color Grading", "overlay LUT por mood (8 moods)"],
        ["Beat Sync", "duración alineada al BPM del mood"],
        ["Director Mode", "prompt enriquecido por estilo visual"],
        ["Karaoke Subs", "word-by-word con highlight central"],
        ["Multi-Voice", "narrador + personaje con voces Azure"],
        ["HUD Overlay", "coords + scene counter futurista"],
        ["Lower Thirds", "barra de info generada por IA"],
        ["Parallax Text", "doble capa con offset para profundidad"],
        ["A/B Prompt",   "GPT elige el mejor prompt visual"],
        ["Prompt Chain", "cada escena referencia la anterior"],
        ["Visual Seed",  "paleta coherente entre escenas"],
        ["Dynamic Music","intensidad por capítulo/acto"],
        ["SFX Layer",    "ambient audio por mood + transición"],
        ["SSE Preview",  "preview de imágenes en tiempo real"],
        ["Job Queue",    "cola async, respuesta inmediata"],
        ["SQLite DB",    "historial + plantillas persistentes"],
        ["Intro/Outro",  "slate de título + créditos finales"],
        ["Thumbnail",    "frame central dedicado para miniatura"],
        ["Webhook",      "Discord/Telegram al completar"],
    ];
    const half = Math.ceil(feats.length / 2);
    for (let i = 0; i < half; i++) {
        const [n1,d1] = feats[i] || ["",""];
        const [n2,d2] = feats[i+half] || ["",""];
        const col1 = `  ${C.green}✦${C.reset} ${C.bold}${n1.padEnd(14)}${C.reset}${C.fg2}${d1}${C.reset}`;
        const col2 = n2 ? `  ${C.green}✦${C.reset} ${C.bold}${n2.padEnd(14)}${C.reset}${C.fg2}${d2}${C.reset}` : "";
        // print two columns
        const clean1 = col1.replace(/\x1b\[[0-9;]*m/g,"");
        const pad = Math.max(0, 35 - clean1.length);
        console.log(`${C.magenta}║${C.reset}${col1}${" ".repeat(pad)}${col2}${C.magenta}║${C.reset}`);
    }
    blank();
    console.log(`${C.magenta}╠${"═".repeat(W-2)}╣${C.reset}`);
    blank();

    // ── SERVICE CHECKS ──────────────────────────────────────────────────────
    row("  🌐 VERIFICANDO SERVICIOS...", C.cyan);
    blank();
    const checks = await runStartupChecks();
    for (const c of checks) {
        const icon   = c.ok ? `${C.green}✅` : `${C.red}❌`;
        const status = c.ok ? `${C.green}ONLINE${C.reset}` : `${C.red}OFFLINE${C.reset}`;
        row(`  ${icon} ${C.reset}${c.name.padEnd(14)}${status}`);
    }
    blank();
    console.log(`${C.magenta}╠${"═".repeat(W-2)}╣${C.reset}`);
    blank();

    // ── ENDPOINTS ───────────────────────────────────────────────────────────
    row("  🛣  ENDPOINTS", C.yellow);
    blank();
    const eps = [
        ["POST /generate",       "Pipeline completo → video"],
        ["POST /preview",        "Preview escena 1 (rápido)"],
        ["POST /rerender-scene", "Re-render escena individual"],
        ["GET  /status/:id",     "Estado del render Json2Video"],
        ["GET  /progress/:id",   "SSE live preview de imágenes"],
        ["GET  /history",        "Historial de proyectos (SQLite)"],
        ["GET  /templates",      "Plantillas (6 default + custom)"],
        ["POST /queue",          "Agregar job a la cola async"],
        ["GET  /health",         "Health check del servidor"],
        ["GET  /api-docs",       "Swagger UI documentación"],
    ];
    for (const [ep, desc] of eps) {
        row(`  ${C.cyan}${ep.padEnd(24)}${C.reset}${C.fg2}${desc}${C.reset}`);
    }
    blank();
    console.log(`${C.magenta}╠${"═".repeat(W-2)}╣${C.reset}`);
    blank();
    row(`  🚀  LISTO  →  http://localhost:${CONFIG.PORT}`, C.green + C.bold);
    row(`  📖  DOCS   →  http://localhost:${CONFIG.PORT}/api-docs`, C.cyan);
    blank();
    console.log(`${C.magenta}╚${"═".repeat(W-2)}╝${C.reset}`);
    console.log();
});

server.setTimeout(600000);
server.keepAliveTimeout = 300000;
server.headersTimeout   = 305000;

process.on("uncaughtException",  e => log.error("EXCEPCION", e.stack));
process.on("unhandledRejection", r => log.error("PROMESA",   String(r)));
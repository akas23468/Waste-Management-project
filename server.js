require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const path    = require('path');
const https   = require('https');
const http    = require('http');
const { createClient } = require('@supabase/supabase-js');

const app  = express();
const PORT = process.env.PORT || 8000;

app.use(cors({
    origin: '*',
    credentials: true,
    methods: ['GET','POST','PUT','DELETE','OPTIONS'],
    allowedHeaders: ['Content-Type','Authorization']
}));
app.use(express.json({ limit: '20mb' }));  // large limit for base64 photos

// ── STATIC FILES ──────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'frontend')));
app.use(express.static(path.join(__dirname)));

app.get('/map.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'frontend', 'map.html'), err => {
        if (err) res.status(404).send('map.html not found in frontend/');
    });
});

app.get('/complaints.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'frontend', 'complaints.html'), err => {
        if (err) res.status(404).send('complaints.html not found in frontend/');
    });
});

app.get('/districts.json', (req, res) => {
    res.sendFile(path.join(__dirname, 'districts.json'), err => {
        if (err) res.status(404).send('districts.json not found');
    });
});

// ── SUPABASE ──────────────────────────────────────────────────────
let supabaseUrl = (process.env.SUPABASE_URL || '').replace(/[\[\]'"]/g,'').trim();
let supabaseKey = (process.env.SUPABASE_KEY || '').replace(/[\[\]'"]/g,'').trim();
let supabase;
try {
    if (!supabaseUrl || !supabaseKey) throw new Error("Supabase env vars missing in .env!");
    supabase = createClient(supabaseUrl, supabaseKey);
    console.log("✅ Supabase client initialized");
} catch (err) {
    console.error("❌ Supabase init failed:", err.message);
    supabase = null;
}

// ── IN-MEMORY COMPLAINTS STORE ────────────────────────────────────
// Used as fallback when Supabase is unavailable.
// In production, all reads/writes go to Supabase.
const complaintsMemory = [];

// ── OTP STORE ─────────────────────────────────────────────────────
const otpDatabase = {};

// ── HELPERS ───────────────────────────────────────────────────────
function generateCitizenId() {
    const L = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', D = '0123456789';
    const r = s => s[Math.floor(Math.random() * s.length)];
    return `${r(L)}${r(D)}${r(L)}${r(D)}${r(L)}${r(D)}`;
}

function fetchUrl(url) {
    return new Promise((resolve, reject) => {
        const mod = url.startsWith('https') ? https : http;
        const req = mod.get(url, {
            headers: { 'User-Agent': 'SmartWasteMap/1.0 (educational project)' }
        }, res => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => resolve(data));
        });
        req.on('error', reject);
        req.setTimeout(12000, () => { req.destroy(); reject(new Error('Timeout')); });
    });
}

// ── GROQ AI ANALYSIS ENDPOINT ─────────────────────────────────────
// POST /api/ai-analyse
// Body: { imageBase64, category, description, priority, zoneId }
// Uses GROQ_API_KEY from .env — key never exposed to browser
app.post('/api/ai-analyse', async (req, res) => {
    const { imageBase64, category, description, priority, zoneId } = req.body;

    if (!imageBase64) {
        return res.status(400).json({ detail: 'imageBase64 is required.' });
    }

    const groqKey = (process.env.GROQ_API_KEY || '').replace(/[\[\]'"]/g, '').trim();
    if (!groqKey) {
        return res.status(500).json({ detail: 'GROQ_API_KEY not set in .env — add it and restart the server.' });
    }

    const prompt = `You are an AI waste management analyst for a Smart City system in India.
Carefully look at the uploaded waste image and analyze it together with these details:
- Category reported: ${category || 'General Waste'}
- Citizen description: ${description || 'No description provided'}
- Citizen priority: ${priority || 'Medium'}
- Zone ID: ${zoneId || 'Unknown'} (5 km x 5 km grid zone)

Based ONLY on what you actually see in the image, respond in this exact JSON format (no markdown, no extra text, no code fences):
{
  "wasteType": "Precise waste type visible in image (e.g. Organic Waste, Plastic, Mixed MSW, Sewage, Construction Debris)",
  "severity": "Low | Medium | High | Critical",
  "cleanlinessImpact": "e.g. -18 Score",
  "suggestedAction": "Urgent Cleaning Needed | Deploy Team Immediately | Schedule Routine Cleanup | Emergency Response Required | Monitor and Report",
  "resolution": "Within 2 Hours | Within 6 Hours | Within 24 Hours | Within 72 Hours",
  "summary": "3 sentences — describe exactly what you see in the image, the health or environment risk, and the recommended action for zone ${zoneId || 'this area'}."
}`;

    try {
        const groqResponse = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${groqKey}`
            },
            body: JSON.stringify({
                model: 'meta-llama/llama-4-scout-17b-16e-instruct',
                messages: [
                    {
                        role: 'user',
                        content: [
                            {
                                type: 'image_url',
                                image_url: {
                                    url: `data:image/jpeg;base64,${imageBase64}`
                                }
                            },
                            {
                                type: 'text',
                                text: prompt
                            }
                        ]
                    }
                ],
                temperature: 0.2,
                max_tokens: 600,
                response_format: { type: 'json_object' }
            })
        });

        if (!groqResponse.ok) {
            const errBody = await groqResponse.json().catch(() => ({}));
            const msg = errBody?.error?.message || `Groq HTTP ${groqResponse.status}`;
            console.error(`❌ Groq API error: ${msg}`);
            return res.status(502).json({ detail: `Groq API error: ${msg}` });
        }

        const groqData = await groqResponse.json();
        const raw      = groqData.choices?.[0]?.message?.content || '';

        if (!raw.trim()) {
            return res.status(502).json({ detail: 'Groq returned an empty response. Please try again.' });
        }

        // Parse JSON — strip any accidental markdown fences
        let result;
        try {
            const cleaned = raw.replace(/```json|```/g, '').trim();
            result = JSON.parse(cleaned);
        } catch {
            const match = raw.match(/\{[\s\S]*\}/);
            if (!match) return res.status(502).json({ detail: 'Groq response was not valid JSON. Please try again.' });
            result = JSON.parse(match[0]);
        }

        console.log(`✅ AI Analysis done — Zone: ${zoneId} | Severity: ${result.severity} | Action: ${result.suggestedAction}`);
        return res.json({ success: true, result });

    } catch (err) {
        console.error(`❌ /api/ai-analyse error:`, err.message);
        return res.status(500).json({ detail: `Server error during AI analysis: ${err.message}` });
    }
});

// ── GEMINI KEY ENDPOINT (kept for backward compat, now unused) ────
app.get('/api/gemini-key', (req, res) => {
    return res.status(410).json({ error: 'Gemini replaced by Groq. See /api/ai-analyse.' });
});

// ══════════════════════════════════════════════════════════════════
// COMPLAINTS API
// ══════════════════════════════════════════════════════════════════

// POST /api/complaints  — submit a new complaint
// Body: { id, zoneId, category, description, priority, lat, lng, photo (base64), submittedAt, timeline }
app.post('/api/complaints', async (req, res) => {
    const complaint = req.body;

    if (!complaint || !complaint.id || !complaint.category) {
        return res.status(400).json({ detail: 'id and category are required.' });
    }

    console.log(`\n📋 NEW COMPLAINT`);
    console.log(`   ID       : ${complaint.id}`);
    console.log(`   Zone     : ${complaint.zoneId || '—'}`);
    console.log(`   Category : ${complaint.category}`);
    console.log(`   Priority : ${complaint.priority}`);
    console.log(`   Location : ${complaint.lat}, ${complaint.lng}`);
    console.log(`   Time     : ${complaint.submittedAt}\n`);

    // ── Try Supabase first ──
    if (supabase) {
        try {
            const { error } = await supabase.from('complaints').insert([{
                complaint_id:  complaint.id,
                zone_id:       complaint.zoneId        || null,
                category:      complaint.category,
                description:   complaint.description   || '',
                priority:      complaint.priority      || 'Medium',
                lat:           complaint.lat,
                lng:           complaint.lng,
                photo_base64:  complaint.photo         || null,
                status:        complaint.status        || 'submitted',
                submitted_at:  complaint.submittedAt,
                timeline:      JSON.stringify(complaint.timeline || {}),
            }]);
            if (error) throw error;
            console.log(`✅ Complaint ${complaint.id} saved to Supabase`);
            return res.status(201).json({ success: true, id: complaint.id, message: 'Complaint saved to database.' });
        } catch (e) {
            console.error(`⚠️  Supabase insert failed (${e.message}), falling back to memory store`);
        }
    }

    // ── Fallback: in-memory store ──
    complaintsMemory.unshift(complaint);
    console.log(`💾 Complaint ${complaint.id} saved to memory (${complaintsMemory.length} total)`);
    return res.status(201).json({ success: true, id: complaint.id, message: 'Complaint saved (in-memory fallback).' });
});

// GET /api/complaints  — list all complaints (latest first)
app.get('/api/complaints', async (req, res) => {
    // Optional query params: ?zoneId=MH-PAL-A001&priority=High&status=submitted&limit=50
    const { zoneId, priority, status, limit = 100 } = req.query;

    if (supabase) {
        try {
            let query = supabase
                .from('complaints')
                .select('*')
                .order('submitted_at', { ascending: false })
                .limit(Number(limit));

            if (zoneId)   query = query.eq('zone_id', zoneId);
            if (priority) query = query.eq('priority', priority);
            if (status)   query = query.eq('status', status);

            const { data, error } = await query;
            if (error) throw error;
            return res.json({ complaints: data, count: data.length, source: 'supabase' });
        } catch (e) {
            console.error(`⚠️  Supabase fetch failed: ${e.message}`);
        }
    }

    // Fallback: filter memory
    let list = [...complaintsMemory];
    if (zoneId)   list = list.filter(c => c.zoneId   === zoneId);
    if (priority) list = list.filter(c => c.priority === priority);
    if (status)   list = list.filter(c => c.status   === status);
    list = list.slice(0, Number(limit));

    return res.json({ complaints: list, count: list.length, source: 'memory' });
});

// GET /api/complaints/:id  — get single complaint by ID
app.get('/api/complaints/:id', async (req, res) => {
    const { id } = req.params;

    if (supabase) {
        try {
            const { data, error } = await supabase
                .from('complaints')
                .select('*')
                .eq('complaint_id', id)
                .single();
            if (error) throw error;
            return res.json({ complaint: data, source: 'supabase' });
        } catch (e) {
            console.error(`⚠️  Supabase lookup failed: ${e.message}`);
        }
    }

    const complaint = complaintsMemory.find(c => c.id === id);
    if (!complaint) return res.status(404).json({ detail: `Complaint ${id} not found.` });
    return res.json({ complaint, source: 'memory' });
});

// PUT /api/complaints/:id/status  — update complaint status & timeline
// Body: { status: 'verified'|'assigned'|'progress'|'resolved', note: '...' }
app.put('/api/complaints/:id/status', async (req, res) => {
    const { id }             = req.params;
    const { status, note }   = req.body;

    const validStatuses = ['submitted','verified','assigned','progress','resolved'];
    if (!status || !validStatuses.includes(status)) {
        return res.status(400).json({ detail: `status must be one of: ${validStatuses.join(', ')}` });
    }

    const timeNow = new Date().toLocaleString('en-IN', { hour:'2-digit', minute:'2-digit', day:'2-digit', month:'short' });

    if (supabase) {
        try {
            // Fetch existing timeline
            const { data: existing, error: fetchErr } = await supabase
                .from('complaints')
                .select('timeline')
                .eq('complaint_id', id)
                .single();
            if (fetchErr) throw fetchErr;

            const tl = JSON.parse(existing.timeline || '{}');
            tl[status] = { done: true, time: timeNow, note: note || '' };

            const { error: updateErr } = await supabase
                .from('complaints')
                .update({ status, timeline: JSON.stringify(tl) })
                .eq('complaint_id', id);
            if (updateErr) throw updateErr;

            console.log(`🔄 Complaint ${id} → status: ${status}`);
            return res.json({ success: true, id, status, time: timeNow });
        } catch (e) {
            console.error(`⚠️  Supabase update failed: ${e.message}`);
        }
    }

    // Fallback: memory
    const idx = complaintsMemory.findIndex(c => c.id === id);
    if (idx < 0) return res.status(404).json({ detail: `Complaint ${id} not found.` });
    if (!complaintsMemory[idx].timeline) complaintsMemory[idx].timeline = {};
    complaintsMemory[idx].timeline[status] = { done: true, time: timeNow, note: note || '' };
    complaintsMemory[idx].status = status;

    return res.json({ success: true, id, status, time: timeNow });
});

// DELETE /api/complaints/:id  — remove a complaint (admin)
app.delete('/api/complaints/:id', async (req, res) => {
    const { id } = req.params;

    if (supabase) {
        try {
            const { error } = await supabase.from('complaints').delete().eq('complaint_id', id);
            if (error) throw error;
            return res.json({ success: true, message: `Complaint ${id} deleted.` });
        } catch (e) {
            console.error(`⚠️  Supabase delete failed: ${e.message}`);
        }
    }

    const idx = complaintsMemory.findIndex(c => c.id === id);
    if (idx < 0) return res.status(404).json({ detail: `Complaint ${id} not found.` });
    complaintsMemory.splice(idx, 1);
    return res.json({ success: true, message: `Complaint ${id} deleted (memory).` });
});

// GET /api/complaints/zone/:zoneId  — all complaints for a specific zone
app.get('/api/complaints/zone/:zoneId', async (req, res) => {
    const { zoneId } = req.params;

    if (supabase) {
        try {
            const { data, error } = await supabase
                .from('complaints')
                .select('complaint_id, category, priority, status, submitted_at, lat, lng')
                .eq('zone_id', zoneId)
                .order('submitted_at', { ascending: false });
            if (error) throw error;
            return res.json({ zoneId, complaints: data, count: data.length });
        } catch (e) {
            console.error(`⚠️  Supabase zone query failed: ${e.message}`);
        }
    }

    const list = complaintsMemory.filter(c => c.zoneId === zoneId);
    return res.json({ zoneId, complaints: list, count: list.length });
});

// GET /api/complaints/stats  — summary stats for dashboard
app.get('/api/complaints/stats', async (req, res) => {
    if (supabase) {
        try {
            const { data, error } = await supabase.from('complaints').select('priority, status');
            if (error) throw error;
            return res.json(buildStats(data.map(d => ({
                priority: d.priority,
                status:   d.status
            }))));
        } catch (e) {
            console.error(`⚠️  Supabase stats failed: ${e.message}`);
        }
    }
    return res.json(buildStats(complaintsMemory));
});

function buildStats(list) {
    const stats = {
        total:     list.length,
        byPriority:   { Low:0, Medium:0, High:0, Emergency:0 },
        byStatus:     { submitted:0, verified:0, assigned:0, progress:0, resolved:0 },
    };
    list.forEach(c => {
        if (stats.byPriority[c.priority]  !== undefined) stats.byPriority[c.priority]++;
        if (stats.byStatus[c.status]      !== undefined) stats.byStatus[c.status]++;
    });
    return stats;
}

// ══════════════════════════════════════════════════════════════════
// EXISTING ROUTES (unchanged)
// ══════════════════════════════════════════════════════════════════

// ── STATIC ZONE DATA ──────────────────────────────────────────────
const ZONE_DATA = {
  N: {
    "01": {
      MUM: [
        { code:"Z-01", name:"Churchgate Central",  lat:18.9322, lng:72.8264, score:88, garbage:"Low",    cleaned:"Today 06:30 AM", collected:1.2, complaints:1,  bins:28, recycling:70 },
        { code:"Z-02", name:"CST Heritage Zone",   lat:18.9400, lng:72.8356, score:75, garbage:"Medium", cleaned:"Today 07:00 AM", collected:2.1, complaints:3,  bins:20, recycling:55 },
      ],
      ANE: [
        { code:"A-01", name:"Andheri East Zone 1", lat:19.1158, lng:72.8753, score:58, garbage:"Medium", cleaned:"Today 07:15 AM", collected:4.1, complaints:5,  bins:22, recycling:42 },
        { code:"A-02", name:"MIDC Industrial",     lat:19.1100, lng:72.8900, score:45, garbage:"High",   cleaned:"Today 05:00 AM", collected:5.8, complaints:8,  bins:14, recycling:30 },
      ],
      BWE: [
        { code:"B-01", name:"Bandra Linking Road", lat:19.0544, lng:72.8290, score:82, garbage:"Low",    cleaned:"Today 09:30 AM", collected:1.9, complaints:2,  bins:18, recycling:60 },
        { code:"B-02", name:"Bandra Reclamation",  lat:19.0450, lng:72.8180, score:77, garbage:"Low",    cleaned:"Today 08:00 AM", collected:1.5, complaints:1,  bins:16, recycling:65 },
      ],
      DHV: [
        { code:"D-01", name:"Dharavi Zone North",  lat:19.0430, lng:72.8570, score:35, garbage:"High",   cleaned:"Today 05:00 AM", collected:6.8, complaints:12, bins:14, recycling:22 },
        { code:"D-02", name:"Dharavi Zone South",  lat:19.0320, lng:72.8500, score:38, garbage:"High",   cleaned:"Today 04:30 AM", collected:7.1, complaints:15, bins:10, recycling:18 },
      ],
      BOR: [
        { code:"V-01", name:"Borivali West Mkt",   lat:19.2307, lng:72.8567, score:68, garbage:"Medium", cleaned:"Today 08:00 AM", collected:3.1, complaints:4,  bins:16, recycling:48 },
      ],
    },
    "05": {
      PAN: [
        { code:"P-01", name:"Panchavati Core",     lat:20.0160, lng:73.7990, score:65, garbage:"Medium", cleaned:"Today 08:30 AM", collected:2.4, complaints:3,  bins:15, recycling:48 },
        { code:"P-02", name:"Godavari Ghat",       lat:20.0200, lng:73.8050, score:70, garbage:"Low",    cleaned:"Today 09:00 AM", collected:1.8, complaints:2,  bins:18, recycling:52 },
      ],
    },
  },
  K: {
    "01": {
      IND: [
        { code:"I-01", name:"Indiranagar 100ft Rd", lat:12.9719, lng:77.6412, score:91, garbage:"Low",    cleaned:"Today 07:30 AM", collected:1.4, complaints:2,  bins:20, recycling:72 },
        { code:"I-02", name:"Indiranagar CMH Road", lat:12.9650, lng:77.6450, score:86, garbage:"Low",    cleaned:"Today 08:00 AM", collected:1.1, complaints:1,  bins:18, recycling:68 },
      ],
      WFD: [
        { code:"W-01", name:"Whitefield IT Sector", lat:12.9698, lng:77.7500, score:64, garbage:"Medium", cleaned:"Today 08:15 AM", collected:3.9, complaints:7,  bins:16, recycling:45 },
        { code:"W-02", name:"EPIP Zone",            lat:12.9800, lng:77.7600, score:59, garbage:"Medium", cleaned:"Today 09:00 AM", collected:4.2, complaints:6,  bins:14, recycling:40 },
      ],
    },
  },
  A: {
    "01": {
      GAJ: [
        { code:"G-01", name:"Gajuwaka Industrial",  lat:17.6896, lng:83.2185, score:72, garbage:"Medium", cleaned:"Today 08:30 AM", collected:4.1, complaints:2,  bins:14, recycling:52 },
        { code:"G-02", name:"Steel Plant Area",     lat:17.6800, lng:83.2300, score:55, garbage:"High",   cleaned:"Today 06:00 AM", collected:5.5, complaints:7,  bins:10, recycling:35 },
      ],
      RKB: [
        { code:"R-01", name:"RK Beach Front",       lat:17.7144, lng:83.3228, score:94, garbage:"Low",    cleaned:"Today 06:15 AM", collected:1.1, complaints:0,  bins:25, recycling:68 },
      ],
    },
  },
  M: {
    "01": {
      RAJ: [
        { code:"R-01", name:"Rajwada Palace Zone",  lat:22.7196, lng:75.8577, score:98, garbage:"Low",    cleaned:"Today 06:00 AM", collected:0.7, complaints:0,  bins:45, recycling:90 },
      ],
    },
  },
  X: {
    "01": {
      GAC: [
        { code:"G-01", name:"Gachibowli Corridor",  lat:17.4401, lng:78.3489, score:92, garbage:"Low",    cleaned:"Today 07:00 AM", collected:1.7, complaints:1,  bins:32, recycling:70 },
        { code:"G-02", name:"Financial District",   lat:17.4300, lng:78.3400, score:89, garbage:"Low",    cleaned:"Today 07:30 AM", collected:1.4, complaints:0,  bins:28, recycling:72 },
      ],
    },
  },
  W: {
    "01": {
      ADY: [
        { code:"A-01", name:"Adyar Market Zone",    lat:13.0033, lng:80.2550, score:85, garbage:"Low",    cleaned:"Today 08:30 AM", collected:2.0, complaints:1,  bins:24, recycling:66 },
        { code:"A-02", name:"Adyar River Front",    lat:13.0060, lng:80.2600, score:80, garbage:"Low",    cleaned:"Today 09:00 AM", collected:1.5, complaints:1,  bins:20, recycling:60 },
      ],
    },
  },
  T: {
    "01": {
      GLD: [
        { code:"G-01", name:"Golden Temple Area",   lat:31.6200, lng:74.8765, score:94, garbage:"Low",    cleaned:"Today 05:30 AM", collected:1.5, complaints:1,  bins:30, recycling:72 },
      ],
    },
  },
};

// ── GEOCODE DISTRICT via Nominatim ────────────────────────────────
app.get('/api/geocode/district', async (req, res) => {
    const { name, state } = req.query;
    if (!name || !state) return res.status(400).json({ error: 'name and state required' });
    const queries = [
        `${name} district, ${state}, India`,
        `${name}, ${state}, India`,
        `${name}, India`
    ];
    for (const q of queries) {
        try {
            const url  = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=1&countrycodes=in`;
            const raw  = await fetchUrl(url);
            const data = JSON.parse(raw);
            if (data && data.length > 0) {
                console.log(`📍 Geocoded: ${name}, ${state} → ${data[0].lat}, ${data[0].lon}`);
                return res.json({ lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon), display: data[0].display_name });
            }
        } catch (e) { /* try next */ }
        await new Promise(r => setTimeout(r, 200));
    }
    return res.status(404).json({ error: 'Could not geocode district' });
});

// ── LOCALITIES via Overpass API ────────────────────────────────────
app.get('/api/localities', async (req, res) => {
    const { lat, lng } = req.query;
    if (!lat || !lng) return res.status(400).json({ error: 'lat and lng required' });
    const radius = 30000;
    const overpassQuery = `
[out:json][timeout:25];
(
  node["place"~"^(city|town|suburb|village|quarter|neighbourhood)$"](around:${radius},${lat},${lng});
);
out body 80;`.trim();
    try {
        const url  = `https://overpass-api.de/api/interpreter?data=${encodeURIComponent(overpassQuery)}`;
        const raw  = await fetchUrl(url);
        const data = JSON.parse(raw);
        const TYPE_PRIORITY = { city:1, town:2, suburb:3, village:4, quarter:5, neighbourhood:6 };
        const localities = (data.elements || [])
            .filter(e => e.tags && e.tags.name)
            .map(e => ({ name: e.tags.name, type: e.tags.place, lat: e.lat, lng: e.lon }))
            .sort((a, b) => (TYPE_PRIORITY[a.type] || 9) - (TYPE_PRIORITY[b.type] || 9))
            .slice(0, 80);
        console.log(`🏘  Localities for (${lat},${lng}): ${localities.length} found`);
        return res.json({ localities, count: localities.length });
    } catch (e) {
        console.error('Overpass error:', e.message);
        return res.status(500).json({ error: 'Overpass fetch failed', detail: e.message });
    }
});

// ── ZONE ROUTES ───────────────────────────────────────────────────
app.get('/api/zones/:state/:district/:city', (req, res) => {
    const sk = req.params.state.toUpperCase();
    const dk = req.params.district;
    const ck = req.params.city.toUpperCase();
    const zones = ZONE_DATA?.[sk]?.[dk]?.[ck];
    if (!zones) return res.status(404).json({ detail: `No zone data for ${sk}/${dk}/${ck}` });
    return res.json({ state: sk, district: dk, city: ck, zones });
});

app.get('/api/zones/:state/:district', (req, res) => {
    const sk = req.params.state.toUpperCase();
    const dk = req.params.district;
    const districtData = ZONE_DATA?.[sk]?.[dk];
    if (!districtData) return res.status(404).json({ detail: `No zone data for ${sk}/${dk}` });
    return res.json({ state: sk, district: dk, cities: districtData });
});

app.get('/api/zones/:state', (req, res) => {
    const sk = req.params.state.toUpperCase();
    const stateData = ZONE_DATA?.[sk];
    if (!stateData) return res.status(404).json({ detail: `No zone data for state ${sk}` });
    return res.json({ state: sk, districts: stateData });
});

app.post('/api/zones', (req, res) => {
    const { state, district, city, zones } = req.body;
    if (!state || !district || !city || !Array.isArray(zones)) {
        return res.status(400).json({ detail: "state, district, city (strings) and zones (array) required." });
    }
    const sk = state.toUpperCase(), ck = city.toUpperCase();
    if (!ZONE_DATA[sk])           ZONE_DATA[sk] = {};
    if (!ZONE_DATA[sk][district]) ZONE_DATA[sk][district] = {};
    ZONE_DATA[sk][district][ck] = zones;
    console.log(`✅ Zone data updated: ${sk}/${district}/${ck} — ${zones.length} zone(s)`);
    return res.json({ success: true, message: `${zones.length} zones saved for ${sk}/${district}/${ck}` });
});

// ── OTP REQUEST ───────────────────────────────────────────────────
app.post('/api/otp/request', (req, res) => {
    const { phone_number } = req.body;
    if (!phone_number || !String(phone_number).trim()) {
        return res.status(400).json({ detail: "Phone number cannot be empty." });
    }
    const clean = String(phone_number).trim();
    const otp   = String(Math.floor(100000 + Math.random() * 900000));
    otpDatabase[clean] = otp;
    console.log("\n" + "=".repeat(50));
    console.log("🔔  OTP REQUEST");
    console.log(`📱  Phone: +91 ${clean}`);
    console.log(`🔑  OTP:   ${otp}`);
    console.log("=".repeat(50) + "\n");
    return res.json({ success: true, message: "OTP generated successfully." });
});

// ── OTP VERIFY + REGISTER ─────────────────────────────────────────
app.post('/api/otp/verify', async (req, res) => {
    if (!supabase) return res.status(500).json({ detail: "Database client uninitialized." });
    const { phone_number, otp, email, first_name, last_name, password } = req.body;
    if (!phone_number || !otp || !email || !first_name || !last_name || !password)
        return res.status(400).json({ detail: "Missing required registration fields." });
    const clean = phone_number.trim();
    if (!otpDatabase[clean])               return res.status(400).json({ detail: "No active OTP session found." });
    if (otp.trim() !== otpDatabase[clean]) return res.status(400).json({ detail: "Wrong OTP. Try again." });
    let citizenId = "";
    try {
        for (let i = 0; i < 10; i++) {
            const candidate = generateCitizenId();
            const { data, error } = await supabase.from('citizens').select('citizen_id').eq('citizen_id', candidate);
            if (error) throw error;
            if (!data || data.length === 0) { citizenId = candidate; break; }
        }
    } catch (e) { return res.status(500).json({ detail: "ID lookup failure." }); }
    if (!citizenId) return res.status(500).json({ detail: "Could not generate unique Citizen ID." });
    try {
        const { error } = await supabase.from('citizens').insert([{
            citizen_id:    citizenId,
            phone_number:  clean,
            email:         email.trim().toLowerCase(),
            first_name:    first_name.trim(),
            last_name:     last_name.trim(),
            password_hash: password
        }]);
        if (error) throw error;
    } catch (e) {
        const msg = e.message || String(e);
        if (msg.includes("duplicate key") || msg.includes("already exists"))
            return res.status(400).json({ detail: "Account with this phone/email already exists." });
        return res.status(500).json({ detail: msg });
    }
    delete otpDatabase[clean];
    return res.json({ success: true, citizen_id: citizenId, message: "Registered successfully!" });
});

// ── LOGIN ─────────────────────────────────────────────────────────
app.post('/api/login', async (req, res) => {
    if (!supabase) return res.status(500).json({ detail: "Database unavailable." });
    const { citizen_id, password } = req.body;
    if (!citizen_id || !password) return res.status(400).json({ detail: "Both citizen_id and password required." });
    try {
        const { data, error } = await supabase
            .from('citizens')
            .select('citizen_id, first_name, last_name')
            .eq('citizen_id', citizen_id.trim().toUpperCase())
            .eq('password_hash', password);
        if (error) throw error;
        if (!data || data.length === 0) return res.status(401).json({ detail: "Invalid Citizen ID or Password." });
        return res.json({ success: true, ...data[0] });
    } catch (e) {
        return res.status(500).json({ detail: "Database lookup error." });
    }
});

// ── 404 for /api routes ───────────────────────────────────────────
app.use('/api', (req, res) => res.status(404).json({ detail: "Endpoint not found." }));

// ── START ─────────────────────────────────────────────────────────
app.listen(PORT, () => {
    console.log(`\n🚀  Smart Waste Server on http://localhost:${PORT}`);
    console.log(`📍  Map          : http://localhost:${PORT}/map.html`);
    console.log(`📋  Complaints   : http://localhost:${PORT}/complaints.html`);
    console.log(`🔑  Groq key    : ${process.env.GROQ_API_KEY ? '✅ set in .env' : '❌ NOT SET — add GROQ_API_KEY=... to .env'}`);
    console.log(`🤖  AI Model    : meta-llama/llama-4-scout-17b-16e-instruct (vision)`);
    console.log(`🗄️   Supabase    : ${supabase ? '✅ connected' : '❌ offline (using memory fallback)'}\n`);
    console.log(`── Complaints API ──────────────────────────────────`);
    console.log(`   POST   /api/complaints`);
    console.log(`   GET    /api/complaints`);
    console.log(`   GET    /api/complaints/:id`);
    console.log(`   PUT    /api/complaints/:id/status`);
    console.log(`   DELETE /api/complaints/:id`);
    console.log(`   GET    /api/complaints/zone/:zoneId`);
    console.log(`   GET    /api/complaints/stats`);
    console.log(`   POST   /api/ai-analyse  ← Groq vision AI`);
    console.log(`────────────────────────────────────────────────────\n`);
});

/* git add .
git commit -m "Added complaint dashboard"
git push */
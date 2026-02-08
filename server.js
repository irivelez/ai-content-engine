/**
 * Content Engine Server
 * A local platform for generating publication-ready how-to guides
 * 
 * Run: node server.js
 * Access: http://localhost:3847
 */

require('dotenv').config();

const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const { generate } = require('./lib/openclaw-client');

// Check for gateway token
if (!process.env.OPENCLAW_GATEWAY_TOKEN) {
  console.error('\n❌ OPENCLAW_GATEWAY_TOKEN not found!\n');
  console.error('This should be auto-configured. Check .env file.\n');
  process.exit(1);
}

const { 
  GUIA_PRACTICA_SYSTEM,
  EXPERIMENTO_SYSTEM,
  COMPARACION_SYSTEM,
  CONTRARIO_SYSTEM,
  CURACION_SYSTEM,
  AUTONOMOUS_SYSTEM,
  DRAFT_SYSTEM, 
  TOPIC_EXPANSION_SYSTEM,
  ANGLE_GENERATOR_SYSTEM,
  DISCOVERY_GENERATION_SYSTEM
} = require('./lib/prompts');

// Format selector
const FORMAT_SYSTEMS = {
  guia_practica: GUIA_PRACTICA_SYSTEM,
  experimento: EXPERIMENTO_SYSTEM,
  comparacion: COMPARACION_SYSTEM,
  contrario: CONTRARIO_SYSTEM,
  curacion: CURACION_SYSTEM,
};

const discovery = require('./lib/discovery');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3847;
const DATA_DIR = path.join(__dirname, 'data');
const OUTPUT_DIR = path.join(__dirname, 'output');

// Ensure directories exist
async function ensureDirs() {
  const dirs = [
    DATA_DIR,
    path.join(OUTPUT_DIR, 'ready'),
    path.join(OUTPUT_DIR, 'review'),
    path.join(__dirname, 'input')
  ];
  for (const dir of dirs) {
    await fs.mkdir(dir, { recursive: true });
  }
}

// Load voice profile
async function loadVoiceProfile() {
  try {
    const profilePath = path.join(__dirname, '..', 'irina-voice-profile.md');
    return await fs.readFile(profilePath, 'utf-8');
  } catch (e) {
    return '';
  }
}

// Load topic bank
async function loadTopicBank() {
  try {
    const data = await fs.readFile(path.join(DATA_DIR, 'topics.json'), 'utf-8');
    return JSON.parse(data);
  } catch (e) {
    return { topics: [], generated: [] };
  }
}

// Save topic bank
async function saveTopicBank(bank) {
  await fs.writeFile(
    path.join(DATA_DIR, 'topics.json'), 
    JSON.stringify(bank, null, 2)
  );
}

// Generate content using OpenClaw gateway (routes through Ari)
async function generateContent(systemPrompt, userPrompt, options = {}) {
  return generate(userPrompt, {
    system: systemPrompt,
    maxTokens: options.maxTokens || 4096,
    model: options.model
  });
}

// ============ API ENDPOINTS ============

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Available formats
app.get('/api/formats', (req, res) => {
  res.json({
    formats: [
      { id: 'guia_practica', name: '📘 Guía Práctica', desc: 'Concepto → Analogía → Demo → Ejercicio (tu formato signature)' },
      { id: 'experimento', name: '🧪 Experimento Personal', desc: '"Probé X por 2 semanas..." — narrativa en primera persona' },
      { id: 'comparacion', name: '⚖️ Comparación de Herramientas', desc: 'Por tarea: qué usar, cuándo y por qué' },
      { id: 'contrario', name: '🔥 Take Contrario', desc: '"Deja de usar X" — desafía lo convencional con evidencia' },
      { id: 'curacion', name: '🌎 Curación con Ángulo', desc: 'Tendencia en inglés → adaptada para LATAM con tu perspectiva' },
    ]
  });
});

// ---- TOPIC BANK ----

// Get all topics
app.get('/api/topics', async (req, res) => {
  try {
    const bank = await loadTopicBank();
    res.json(bank);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Add topic idea
app.post('/api/topics', async (req, res) => {
  try {
    const { idea, source = 'manual', notes = '' } = req.body;
    const bank = await loadTopicBank();
    
    const topic = {
      id: Date.now().toString(36),
      idea,
      source,
      notes,
      status: 'raw', // raw, expanded, generating, done
      createdAt: new Date().toISOString()
    };
    
    bank.topics.push(topic);
    await saveTopicBank(bank);
    res.json(topic);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Expand a topic into a full brief
app.post('/api/topics/:id/expand', async (req, res) => {
  try {
    const bank = await loadTopicBank();
    const topic = bank.topics.find(t => t.id === req.params.id);
    if (!topic) return res.status(404).json({ error: 'Topic not found' });

    const voiceProfile = await loadVoiceProfile();
    const prompt = `
Topic idea: ${topic.idea}
${topic.notes ? `Notes: ${topic.notes}` : ''}

Expand this into a complete content brief for a how-to guide.
Return valid JSON only.
`;

    const result = await generateContent(TOPIC_EXPANSION_SYSTEM, prompt);
    
    // Parse JSON from response
    let brief;
    try {
      const jsonMatch = result.match(/\{[\s\S]*\}/);
      brief = jsonMatch ? JSON.parse(jsonMatch[0]) : { raw: result };
    } catch (e) {
      brief = { raw: result };
    }

    topic.brief = brief;
    topic.status = 'expanded';
    topic.expandedAt = new Date().toISOString();
    await saveTopicBank(bank);
    
    res.json(topic);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Generate angles for a topic
app.post('/api/topics/:id/angles', async (req, res) => {
  try {
    const bank = await loadTopicBank();
    const topic = bank.topics.find(t => t.id === req.params.id);
    if (!topic) return res.status(404).json({ error: 'Topic not found' });

    const prompt = `Topic: ${topic.idea}\n\nGenerate 5 different angles for this topic.`;
    const result = await generateContent(ANGLE_GENERATOR_SYSTEM, prompt);
    
    topic.angles = result;
    await saveTopicBank(bank);
    
    res.json({ angles: result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Delete topic
app.delete('/api/topics/:id', async (req, res) => {
  try {
    const bank = await loadTopicBank();
    bank.topics = bank.topics.filter(t => t.id !== req.params.id);
    await saveTopicBank(bank);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- AUTONOMOUS MODE ----

// Generate complete guide from topic
app.post('/api/generate/autonomous', async (req, res) => {
  try {
    const { topicId, topic, format = 'guia_practica', customInstructions = '' } = req.body;
    
    let topicData = topic;
    
    // If topicId provided, load from bank
    if (topicId) {
      const bank = await loadTopicBank();
      const found = bank.topics.find(t => t.id === topicId);
      if (found) {
        topicData = found.brief?.title || found.idea;
      }
    }

    if (!topicData) {
      return res.status(400).json({ error: 'Topic required' });
    }

    const selectedSystem = FORMAT_SYSTEMS[format] || GUIA_PRACTICA_SYSTEM;
    
    const prompt = `
Create a complete, publication-ready newsletter edition for Beehiiv.

Topic: ${topicData}
Format: ${format}

${customInstructions ? `Additional instructions: ${customInstructions}` : ''}

Write the complete newsletter edition now:
`;

    const guide = await generateContent(selectedSystem, prompt, { maxTokens: 6000 });
    
    // Save to output
    const filename = `guide-${Date.now()}.md`;
    await fs.writeFile(
      path.join(OUTPUT_DIR, 'ready', filename),
      `# Generated: ${new Date().toISOString()}\n# Topic: ${topicData}\n\n${guide}`
    );

    // Update topic status if from bank
    if (topicId) {
      const bank = await loadTopicBank();
      const topic = bank.topics.find(t => t.id === topicId);
      if (topic) {
        topic.status = 'done';
        topic.generatedAt = new Date().toISOString();
        topic.outputFile = filename;
        bank.generated.push({
          topicId,
          filename,
          generatedAt: new Date().toISOString()
        });
        await saveTopicBank(bank);
      }
    }

    res.json({ 
      success: true, 
      guide,
      filename,
      wordCount: guide.split(/\s+/).length
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- DISCOVERY-POWERED GENERATION ----

// Generate from a full discovery object (uses rich context)
app.post('/api/generate/from-discovery', async (req, res) => {
  try {
    const { discoveryId, customInstructions = '' } = req.body;

    if (!discoveryId) {
      return res.status(400).json({ error: 'discoveryId required' });
    }

    // Load the full discovery object
    const { items } = await discovery.getDiscoveries();
    const disc = items.find(i => i && i.id === discoveryId);
    if (!disc) {
      return res.status(404).json({ error: 'Discovery not found' });
    }

    const voiceProfile = await loadVoiceProfile();

    const prompt = `
Create a complete, publication-ready how-to guide for Beehiiv newsletter.
Use the discovery analysis below as your foundation.

## ORIGINAL VIRAL CONTENT
Title: ${disc.originalTitle || 'N/A'}
Content: ${disc.raw?.content || disc.raw?.text || 'N/A'}
Author: ${disc.raw?.author || 'N/A'}
Engagement: ${disc.raw?.likes ? disc.raw.likes + ' likes' : ''} ${disc.raw?.retweets ? disc.raw.retweets + ' RTs' : ''}

## ANALYSIS
Core idea: ${disc.coreIdea || 'N/A'}
Why it went viral: ${disc.viralReason || 'N/A'}
LATAM relevance: ${disc.latamScore || '?'}/10

## REPURPOSE BRIEF
Angle: ${disc.repurposeAngle || 'N/A'}
Suggested topic: ${disc.suggestedTopic || 'N/A'}
Suggested hook: ${disc.suggestedHook || 'N/A'}
Tags: ${(disc.tags || []).join(', ')}

${customInstructions ? `## ADDITIONAL INSTRUCTIONS\n${customInstructions}` : ''}

Now write the complete guide. Use the viral reason to hit the same emotional nerve. Use the repurpose angle to adapt for LATAM professionals. The guide must stand alone — the reader should never need to see the original content.
`;

    const guide = await generateContent(DISCOVERY_GENERATION_SYSTEM, prompt, { maxTokens: 6000 });

    // Save to output
    const filename = `guide-disc-${Date.now()}.md`;
    const metadata = `# Generated: ${new Date().toISOString()}
# Source: Discovery ${discoveryId}
# Original: ${disc.originalTitle || 'N/A'}
# Topic: ${disc.suggestedTopic || disc.coreIdea || 'N/A'}
# LATAM Score: ${disc.latamScore || '?'}/10

`;
    await fs.writeFile(
      path.join(OUTPUT_DIR, 'ready', filename),
      metadata + guide
    );

    // Update discovery status
    await discovery.updateDiscovery(discoveryId, { 
      status: 'generated',
      outputFile: filename 
    });

    res.json({
      success: true,
      guide,
      filename,
      wordCount: guide.split(/\s+/).length,
      discovery: {
        id: disc.id,
        originalTitle: disc.originalTitle,
        suggestedTopic: disc.suggestedTopic,
        latamScore: disc.latamScore
      }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- DRAFT MODE ----

// Polish a draft
app.post('/api/generate/draft', async (req, res) => {
  try {
    const { draft, instructions = '' } = req.body;
    
    if (!draft) {
      return res.status(400).json({ error: 'Draft required' });
    }

    const voiceProfile = await loadVoiceProfile();
    
    const prompt = `
Here is a draft that needs to be polished into a publication-ready how-to guide:

---DRAFT START---
${draft}
---DRAFT END---

${instructions ? `Additional instructions: ${instructions}` : ''}

Polish this draft:
1. Strengthen the hook
2. Improve structure and flow
3. Add actionable elements where missing
4. Ensure it sounds like Irina (direct, personal, actionable)
5. Format for email newsletter

Output the polished version, then a brief "## Cambios Realizados" section summarizing what you changed.
`;

    const result = await generateContent(DRAFT_SYSTEM, prompt, { maxTokens: 6000 });
    
    // Save to review folder
    const filename = `draft-polished-${Date.now()}.md`;
    await fs.writeFile(
      path.join(OUTPUT_DIR, 'review', filename),
      `# Polished: ${new Date().toISOString()}\n\n${result}`
    );

    res.json({ 
      success: true, 
      polished: result,
      filename,
      wordCount: result.split(/\s+/).length
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- OUTPUT MANAGEMENT ----

// List generated content
app.get('/api/output', async (req, res) => {
  try {
    const readyFiles = await fs.readdir(path.join(OUTPUT_DIR, 'ready')).catch(() => []);
    const reviewFiles = await fs.readdir(path.join(OUTPUT_DIR, 'review')).catch(() => []);
    
    res.json({
      ready: readyFiles.filter(f => f.endsWith('.md')),
      review: reviewFiles.filter(f => f.endsWith('.md'))
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get specific output file
app.get('/api/output/:folder/:filename', async (req, res) => {
  try {
    const { folder, filename } = req.params;
    if (!['ready', 'review'].includes(folder)) {
      return res.status(400).json({ error: 'Invalid folder' });
    }
    const content = await fs.readFile(
      path.join(OUTPUT_DIR, folder, filename),
      'utf-8'
    );
    res.json({ content, filename, folder });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Move from review to ready
app.post('/api/output/approve/:filename', async (req, res) => {
  try {
    const { filename } = req.params;
    const src = path.join(OUTPUT_DIR, 'review', filename);
    const dest = path.join(OUTPUT_DIR, 'ready', filename);
    await fs.rename(src, dest);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- DISCOVERY ENGINE ----

// Check if bird CLI is authenticated
app.get('/api/discover/status', async (req, res) => {
  try {
    const xOk = discovery.isXAvailable();
    const config = await discovery.loadConfig();
    const { items, lastSearch } = await discovery.getDiscoveries();
    res.json({ 
      birdAuthenticated: xOk, 
      config,
      discoveryCount: items.length,
      lastSearch
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Run automated discovery (requires bird auth)
app.post('/api/discover/search', async (req, res) => {
  try {
    const result = await discovery.runDiscovery();
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Manual feed: submit content for analysis
app.post('/api/discover/feed', async (req, res) => {
  try {
    const { items } = req.body;
    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'Provide items array with {title, content/text, url?, author?, likes?, retweets?}' });
    }
    const result = await discovery.feedContent(items);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get all discoveries
app.get('/api/discover/results', async (req, res) => {
  try {
    const { status, minScore, priority } = req.query;
    const result = await discovery.getDiscoveries({
      status,
      minScore: minScore ? parseInt(minScore) : undefined,
      priority
    });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Import discovery to topic bank
app.post('/api/discover/:id/import', async (req, res) => {
  try {
    const result = await discovery.importToTopicBank(req.params.id);
    if (!result) return res.status(404).json({ error: 'Discovery not found' });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Dismiss a discovery
app.delete('/api/discover/:id', async (req, res) => {
  try {
    const ok = await discovery.dismissDiscovery(req.params.id);
    if (!ok) return res.status(404).json({ error: 'Discovery not found' });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- BRIEFINGS ----

// Generate consolidated briefing from all discoveries
app.post('/api/briefings/generate', async (req, res) => {
  try {
    const { items } = await discovery.getDiscoveries();
    const activeItems = items.filter(d => d.status !== 'dismissed');
    
    if (activeItems.length === 0) {
      return res.status(400).json({ error: 'No discoveries to brief. Run a search first.' });
    }

    // Build raw content summary for Claude
    const rawSummary = activeItems.map((d, i) => {
      const raw = d.raw || {};
      return `--- Source ${i + 1} ---
Title: ${d.originalTitle || ''}
Author: ${raw.author || 'Unknown'}
Source: ${raw.source || 'web'}
Engagement: ${raw.likes || 0} likes, ${raw.retweets || 0} RTs
Content: ${raw.content || raw.text || d.coreIdea || ''}
URL: ${raw.url || ''}`;
    }).join('\n\n');

    const briefingPrompt = `You are a senior tech analyst preparing a weekly AI intelligence briefing for Irina, a LATAM-focused AI educator.

Below are ${activeItems.length} pieces of raw content collected from X, Reddit, Hacker News, and the web.

YOUR JOB: Produce a consolidated intelligence briefing — NOT individual summaries. Synthesize across sources.

## FORMAT:

### 🌊 The Big Picture
2-3 sentences: What's the dominant narrative in AI this week? What's the mood?

### 🔑 Key Themes
Group the content into 3-5 themes. For each theme:
- **Theme name** (bold, clear)
- What's happening (2-3 sentences synthesizing MULTIPLE sources)
- Key voices: who's saying what (with engagement numbers)
- Notable data points or claims

### 📊 Numbers That Matter
Bullet list of the most impactful stats, numbers, and data points across all sources. Only the ones that tell a story.

### 🔥 Hottest Takes
The 2-3 most provocative or contrarian opinions — direct quotes or paraphrases with attribution.

### 🌎 LATAM Relevance
Which of these themes matter MOST for Latin American professionals? Why? What's the local angle? (IN SPANISH)

### ⚡ Quick Hits
Anything noteworthy that doesn't fit the themes above — one line each.

RULES:
- Write in English EXCEPT the LATAM Relevance section (Spanish)
- Be opinionated — flag what's signal vs noise
- Include specific numbers and names, don't generalize
- This should read like a sharp analyst's memo, not a generic summary

RAW CONTENT:
${rawSummary}`;

    const result = await generate(briefingPrompt, {
      system: 'You are a senior tech intelligence analyst. Be sharp, specific, and opinionated. No filler.',
      maxTokens: 4096
    });

    // Build sources list
    const sources = activeItems.map(d => {
      const raw = d.raw || {};
      return {
        title: d.originalTitle || raw.title || '',
        author: raw.author || 'Unknown',
        source: raw.source || 'web',
        url: raw.url || '',
        likes: raw.likes || 0,
        retweets: raw.retweets || 0,
      };
    });

    // Save briefing
    const briefing = {
      id: `brief-${Date.now()}`,
      generatedAt: new Date().toISOString(),
      sourceCount: activeItems.length,
      sources,
      content: result
    };

    // Load existing briefings
    const briefingsPath = path.join(DATA_DIR, 'briefings.json');
    let briefings = [];
    try {
      briefings = JSON.parse(await fs.readFile(briefingsPath, 'utf-8'));
    } catch {}
    
    briefings.unshift(briefing);
    // Keep last 20 briefings
    if (briefings.length > 20) briefings = briefings.slice(0, 20);
    await fs.writeFile(briefingsPath, JSON.stringify(briefings, null, 2));

    res.json(briefing);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get saved briefings
app.get('/api/briefings', async (req, res) => {
  try {
    const briefingsPath = path.join(DATA_DIR, 'briefings.json');
    const briefings = JSON.parse(await fs.readFile(briefingsPath, 'utf-8'));
    res.json({ briefings });
  } catch {
    res.json({ briefings: [] });
  }
});

// ============ START SERVER ============

ensureDirs().then(() => {
  app.listen(PORT, () => {
    console.log(`
╔══════════════════════════════════════════════════════════════╗
║                                                              ║
║   🚀 Content Engine Running                                  ║
║                                                              ║
║   Open: http://localhost:${PORT}                              ║
║                                                              ║
║   Modes:                                                     ║
║   🔍 Discover  - Find viral content, extract ideas           ║
║   🚀 Autonomous - Generate complete guides from topics       ║
║   ✏️  Draft     - Polish drafts into publication-ready       ║
║                                                              ║
╚══════════════════════════════════════════════════════════════╝
    `);
  });
});

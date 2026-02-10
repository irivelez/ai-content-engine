/**
 * Content Engine Server v2
 * Pipeline: Fetch → Curate → Briefing + Discover → Ideas → Create → Output
 */

require('dotenv').config();

const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const { generate } = require('./lib/openclaw-client');
const pipeline = require('./lib/pipeline');

if (!process.env.OPENCLAW_GATEWAY_TOKEN) {
  console.error('\n❌ OPENCLAW_GATEWAY_TOKEN not found in .env\n');
  process.exit(1);
}

const {
  GUIA_PRACTICA_SYSTEM, EXPERIMENTO_SYSTEM, COMPARACION_SYSTEM,
  CONTRARIO_SYSTEM, CURACION_SYSTEM, DISCOVERY_GENERATION_SYSTEM,
  TOPIC_EXPANSION_SYSTEM, DRAFT_SYSTEM,
} = require('./lib/prompts');

const FORMAT_SYSTEMS = {
  guia_practica: GUIA_PRACTICA_SYSTEM,
  experimento: EXPERIMENTO_SYSTEM,
  comparacion: COMPARACION_SYSTEM,
  contrario: CONTRARIO_SYSTEM,
  curacion: CURACION_SYSTEM,
};

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3847;
const DATA_DIR = path.join(__dirname, 'data');
const OUTPUT_DIR = path.join(__dirname, 'output');

async function ensureDirs() {
  for (const dir of [DATA_DIR, path.join(OUTPUT_DIR, 'ready'), path.join(OUTPUT_DIR, 'review')]) {
    await fs.mkdir(dir, { recursive: true });
  }
}

// ============ PIPELINE API ============

// Get pipeline status (polling endpoint)
app.get('/api/pipeline/status', (req, res) => {
  res.json(pipeline.getStatus());
});

// Run full pipeline: fetch → curate → briefing
app.post('/api/pipeline/run', async (req, res) => {
  const status = pipeline.getStatus();
  if (status.stage === 'running' || status.stage === 'fetching') {
    return res.status(409).json({ error: 'Pipeline already running', status });
  }
  // Run async — client polls /status
  pipeline.runPipeline().catch(e => console.error('Pipeline error:', e));
  res.json({ started: true, message: 'Pipeline started. Poll /api/pipeline/status for progress.' });
});

// Get current pipeline data (curated items + briefing + stats)
app.get('/api/pipeline/data', async (req, res) => {
  try {
    const data = await pipeline.loadPipeline();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============ BRIEFING API ============

app.get('/api/briefings', async (req, res) => {
  try {
    const data = JSON.parse(await fs.readFile(path.join(DATA_DIR, 'briefings.json'), 'utf-8'));
    res.json({ briefings: data });
  } catch {
    res.json({ briefings: [] });
  }
});

// ============ IDEAS API ============

async function loadIdeas() {
  try {
    return JSON.parse(await fs.readFile(path.join(DATA_DIR, 'ideas.json'), 'utf-8'));
  } catch {
    return { items: [] };
  }
}

async function saveIdeas(data) {
  await fs.writeFile(path.join(DATA_DIR, 'ideas.json'), JSON.stringify(data, null, 2));
}

// Get all ideas
app.get('/api/ideas', async (req, res) => {
  try {
    const data = await loadIdeas();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Add idea (from discover or manual)
app.post('/api/ideas', async (req, res) => {
  try {
    const { title, angle, hook, source, sourceUrl, format, tags, fromDiscoveryId } = req.body;
    const data = await loadIdeas();
    const idea = {
      id: `idea-${Date.now()}`,
      title: title || '',
      angle: angle || '',
      hook: hook || '',
      source: source || 'manual',
      sourceUrl: sourceUrl || '',
      suggestedFormat: format || '',
      tags: tags || [],
      status: 'new', // new, queued, in_progress, done
      fromDiscoveryId: fromDiscoveryId || null,
      createdAt: new Date().toISOString(),
    };
    data.items.unshift(idea);
    await saveIdeas(data);
    res.json(idea);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Update idea (status change, reorder, edit)
app.patch('/api/ideas/:id', async (req, res) => {
  try {
    const data = await loadIdeas();
    const idea = data.items.find(i => i.id === req.params.id);
    if (!idea) return res.status(404).json({ error: 'Not found' });
    Object.assign(idea, req.body, { updatedAt: new Date().toISOString() });
    await saveIdeas(data);
    res.json(idea);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Delete idea
app.delete('/api/ideas/:id', async (req, res) => {
  try {
    const data = await loadIdeas();
    data.items = data.items.filter(i => i.id !== req.params.id);
    await saveIdeas(data);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============ CREATE API ============

// Autonomous: generate from idea
app.post('/api/create/autonomous', async (req, res) => {
  try {
    const { ideaId, topic, format = 'guia_practica', instructions = '' } = req.body;
    
    let context = topic || '';
    if (ideaId) {
      const data = await loadIdeas();
      const idea = data.items.find(i => i.id === ideaId);
      if (idea) {
        context = `Topic: ${idea.title}\nAngle: ${idea.angle}\nHook: ${idea.hook}\nFormat: ${idea.suggestedFormat || format}`;
      }
    }
    if (!context) return res.status(400).json({ error: 'Topic or ideaId required' });

    const sys = FORMAT_SYSTEMS[format] || GUIA_PRACTICA_SYSTEM;
    const prompt = `Create a complete, publication-ready newsletter edition for Beehiiv.\n\n${context}\n\n${instructions ? `Additional: ${instructions}` : ''}\n\nWrite the complete edition now:`;
    
    const guide = await generate(prompt, { system: sys, maxTokens: 6000 });
    
    const filename = `guide-${Date.now()}.md`;
    await fs.writeFile(path.join(OUTPUT_DIR, 'review', filename), `# Generated: ${new Date().toISOString()}\n# Context: ${context.slice(0, 100)}\n\n${guide}`);

    res.json({ success: true, guide, filename, wordCount: guide.split(/\s+/).length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Generate from discovery item (with full repurpose context)
app.post('/api/create/from-discovery', async (req, res) => {
  try {
    const { discoveryId, format, instructions = '' } = req.body;
    const pData = await pipeline.loadPipeline();
    const disc = pData.curated.find(c => c.id === discoveryId);
    if (!disc) return res.status(404).json({ error: 'Discovery not found' });

    const chosenFormat = format || disc.suggestedFormat || 'curacion';
    const sys = FORMAT_SYSTEMS[chosenFormat] || CURACION_SYSTEM;

    const prompt = `Create a complete, publication-ready newsletter edition.

## ORIGINAL CONTENT
Title: ${disc.raw.title}
Author: ${disc.raw.author}
Content: ${disc.raw.content?.slice(0, 800)}
Engagement: ${disc.raw.likes} likes${disc.raw.retweets ? `, ${disc.raw.retweets} RTs` : ''}

## ANALYSIS
Core idea: ${disc.coreIdea}
Why it worked: ${disc.viralReason}
Repurpose angle: ${disc.repurposeAngle}
Suggested hook: ${disc.suggestedHook}

${instructions ? `## INSTRUCTIONS\n${instructions}` : ''}

Write the complete edition:`;

    const guide = await generate(prompt, { system: sys, maxTokens: 6000 });
    const filename = `guide-disc-${Date.now()}.md`;
    await fs.writeFile(path.join(OUTPUT_DIR, 'review', filename), guide);

    res.json({ success: true, guide, filename, wordCount: guide.split(/\s+/).length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============ OUTPUT API ============

app.get('/api/output', async (req, res) => {
  try {
    const readyFiles = await fs.readdir(path.join(OUTPUT_DIR, 'ready')).catch(() => []);
    const reviewFiles = await fs.readdir(path.join(OUTPUT_DIR, 'review')).catch(() => []);
    res.json({
      ready: readyFiles.filter(f => f.endsWith('.md')),
      review: reviewFiles.filter(f => f.endsWith('.md')),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/output/:folder/:filename', async (req, res) => {
  try {
    const { folder, filename } = req.params;
    if (!['ready', 'review'].includes(folder)) return res.status(400).json({ error: 'Invalid folder' });
    const content = await fs.readFile(path.join(OUTPUT_DIR, folder, filename), 'utf-8');
    res.json({ content, filename, folder });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/output/approve/:filename', async (req, res) => {
  try {
    await fs.rename(path.join(OUTPUT_DIR, 'review', req.params.filename), path.join(OUTPUT_DIR, 'ready', req.params.filename));
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============ START ============

ensureDirs().then(() => {
  app.listen(PORT, () => {
    console.log(`\n⚡ Content Engine v2 — http://localhost:${PORT}\n`);
  });
});

/**
 * Content Pipeline
 * Single fetch → curate → dual output (briefing + discoveries)
 * 
 * Flow: Fetch raw → AI curates/filters → Save curated dataset
 *       → Generate briefing (themes, highlights)
 *       → Generate repurpose analysis (per-item angles)
 */

const fs = require('fs').promises;
const path = require('path');
const { execFile } = require('child_process');
const { generate } = require('./openclaw-client');

const DATA_DIR = path.join(__dirname, '..', 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'discovery-config.json');
const PIPELINE_FILE = path.join(DATA_DIR, 'pipeline.json');

// ============ CONFIG ============

async function loadConfig() {
  try {
    return JSON.parse(await fs.readFile(CONFIG_FILE, 'utf-8'));
  } catch {
    return { sources: {}, queries: [], rssFeeds: [], subreddits: [] };
  }
}

// ============ DATA LAYER ============

async function loadPipeline() {
  try {
    return JSON.parse(await fs.readFile(PIPELINE_FILE, 'utf-8'));
  } catch {
    return { 
      raw: [], curated: [], briefing: null, 
      lastFetch: null, lastCurate: null, lastBriefing: null,
      status: 'idle' 
    };
  }
}

async function savePipeline(data) {
  await fs.writeFile(PIPELINE_FILE, JSON.stringify(data, null, 2));
}

// ============ FETCH: X via bird CLI ============

async function searchX(query, count = 10) {
  const token = process.env.BIRD_AUTH_TOKEN;
  const ct0 = process.env.BIRD_CT0;
  if (!token || !ct0) return [];

  try {
    const birdBin = path.join(__dirname, '..', 'node_modules', '.bin', 'bird');
    const args = ['search', query, '--count', String(count), '--json', '--auth-token', token, '--ct0', ct0];
    const result = await new Promise((resolve, reject) => {
      execFile(birdBin, args, { timeout: 30000, maxBuffer: 5 * 1024 * 1024 }, (err, stdout) => {
        if (err) return reject(err);
        resolve(stdout);
      });
    });
    const tweets = JSON.parse(result);
    return tweets.map(t => ({
      id: t.id,
      title: (t.text || '').slice(0, 120),
      content: t.text || '',
      author: `@${t.author?.username || 'unknown'}`,
      url: t.author?.username ? `https://x.com/${t.author.username}/status/${t.id}` : '',
      likes: t.likeCount || 0,
      retweets: t.retweetCount || 0,
      source: 'x',
      fetchedAt: new Date().toISOString(),
    }));
  } catch (e) {
    console.error(`  X error "${query}":`, e.message);
    return [];
  }
}

// ============ FETCH: Hacker News ============

async function fetchHN(limit = 20) {
  const aiKeywords = ['ai', 'llm', 'gpt', 'claude', 'anthropic', 'openai', 'machine learning',
    'neural', 'transformer', 'agent', 'copilot', 'coding assistant', 'chatbot', 'gemini',
    'diffusion', 'prompt', 'fine-tun', 'rag', 'vector', 'embedding', 'automation', 'deepseek'];
  try {
    const topIds = await fetch('https://hacker-news.firebaseio.com/v0/topstories.json', { signal: AbortSignal.timeout(10000) }).then(r => r.json());
    const stories = [];
    for (const id of topIds.slice(0, 60)) {
      try {
        const item = await fetch(`https://hacker-news.firebaseio.com/v0/item/${id}.json`, { signal: AbortSignal.timeout(5000) }).then(r => r.json());
        if (!item?.title) continue;
        if (aiKeywords.some(kw => item.title.toLowerCase().includes(kw)) && item.score >= 30) {
          stories.push({
            id: String(id),
            title: item.title,
            content: item.title + (item.text ? '\n' + item.text : ''),
            author: item.by || 'unknown',
            url: item.url || `https://news.ycombinator.com/item?id=${id}`,
            likes: item.score,
            retweets: 0,
            comments: item.descendants || 0,
            source: 'hackernews',
            fetchedAt: new Date().toISOString(),
          });
        }
        if (stories.length >= limit) break;
      } catch { continue; }
    }
    return stories;
  } catch (e) { console.error('  HN error:', e.message); return []; }
}

// ============ FETCH: RSS ============

async function fetchRSS(feedUrl, sourceName) {
  try {
    const resp = await fetch(feedUrl, { headers: { 'User-Agent': 'ContentEngine/1.0' }, signal: AbortSignal.timeout(15000) });
    if (!resp.ok) return [];
    const xml = await resp.text();
    const items = [];
    const matches = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g), ...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)];
    for (const match of matches.slice(0, 10)) {
      const block = match[1];
      const title = block.match(/<title[^>]*>([\s\S]*?)<\/title>/)?.[1]?.replace(/<!\[CDATA\[(.*?)\]\]>/, '$1')?.trim() || '';
      const link = block.match(/<link[^>]*href="([^"]*)"/) ?.[1] || block.match(/<link>([\s\S]*?)<\/link>/)?.[1]?.trim() || '';
      const desc = block.match(/<description[^>]*>([\s\S]*?)<\/description>/)?.[1]?.replace(/<!\[CDATA\[(.*?)\]\]>/s, '$1')?.replace(/<[^>]+>/g, '')?.trim() || '';
      const pubDate = block.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1]?.trim() || block.match(/<published>([\s\S]*?)<\/published>/)?.[1]?.trim() || '';
      if (title) {
        items.push({
          id: `rss-${Buffer.from(link || title).toString('base64').slice(0, 20)}`,
          title,
          content: (desc || title).slice(0, 1000),
          author: sourceName,
          url: link,
          likes: 0, retweets: 0,
          source: 'rss',
          feedName: sourceName,
          publishedAt: pubDate || null,
          fetchedAt: new Date().toISOString(),
        });
      }
    }
    return items;
  } catch (e) { console.error(`  RSS error ${sourceName}:`, e.message); return []; }
}

// ============ STAGE 1: FETCH ALL SOURCES ============

async function fetchAll(config, onProgress) {
  const results = [];
  const progress = (msg) => { console.log(msg); onProgress?.(msg); };

  // X: tracked accounts
  if (config.sources) {
    const accounts = [];
    for (const [groupKey, group] of Object.entries(config.sources)) {
      if (group.accounts) {
        for (const handle of group.accounts) {
          accounts.push({ handle, group: group.label, critical: group.critical?.includes(handle) || false });
        }
      }
    }
    progress(`Fetching X: ${accounts.length} accounts...`);
    for (const acc of accounts) {
      const tweets = await searchX(`from:${acc.handle}`, acc.critical ? 15 : 8);
      results.push(...tweets.map(t => ({ ...t, group: acc.group, critical: acc.critical })));
      await new Promise(r => setTimeout(r, 600));
    }
  }

  // X: keyword queries
  if (config.queries?.length) {
    progress(`Fetching X: ${config.queries.length} queries...`);
    for (const query of config.queries) {
      const tweets = await searchX(query, 10);
      results.push(...tweets.map(t => ({ ...t, query })));
      await new Promise(r => setTimeout(r, 800));
    }
  }

  // Hacker News
  progress('Fetching Hacker News...');
  const hn = await fetchHN(20);
  results.push(...hn);

  // RSS
  if (config.rssFeeds?.length) {
    progress(`Fetching ${config.rssFeeds.length} RSS feeds...`);
    for (const feed of config.rssFeeds) {
      const items = await fetchRSS(feed.url, feed.name);
      results.push(...items);
      await new Promise(r => setTimeout(r, 300));
    }
  }

  progress(`Fetched ${results.length} raw items total`);
  return results;
}

// ============ STAGE 2: CURATE (AI filters + deduplicates) ============

async function curateItems(rawItems, onProgress) {
  const progress = (msg) => { console.log(msg); onProgress?.(msg); };

  // Deduplicate by URL and similar titles
  const seen = new Set();
  const deduped = rawItems.filter(item => {
    const key = item.url || item.title?.toLowerCase().slice(0, 60);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  progress(`After dedup: ${deduped.length} items (from ${rawItems.length})`);

  // Process in batches of 8 for depth
  const BATCH_SIZE = 8;
  const allCurated = [];

  for (let i = 0; i < deduped.length; i += BATCH_SIZE) {
    const batch = deduped.slice(i, i + BATCH_SIZE);
    progress(`Curating batch ${Math.floor(i/BATCH_SIZE) + 1}/${Math.ceil(deduped.length/BATCH_SIZE)} (${batch.length} items)...`);

    const prompt = `You are curating AI content for a newsletter targeting LATAM professionals.

Review these ${batch.length} items. For EACH item, decide:
1. Is it relevant and valuable? (score 1-10)
2. What's the core insight?
3. Why would LATAM professionals care?

FILTER OUT:
- Promotional/marketing spam
- Overly niche developer content with no broad relevance
- Duplicate ideas already covered
- Low-quality takes or engagement bait with no substance

For items scoring 6+, provide full analysis. For items below 6, just return { "keep": false }.

Items:
${batch.map((item, j) => `
--- Item ${j + 1} ---
Source: ${item.source} ${item.feedName ? `(${item.feedName})` : ''}
Title: ${item.title}
Author: ${item.author}
Content: ${item.content?.slice(0, 600)}
Engagement: ${item.likes || 0} likes${item.retweets ? `, ${item.retweets} RTs` : ''}${item.comments ? `, ${item.comments} comments` : ''}
URL: ${item.url}
`).join('\n')}

Return a JSON array (one object per item, same order):
[
  {
    "keep": true,
    "relevanceScore": 8,
    "coreIdea": "The key insight in 1-2 sentences (English)",
    "whyItMatters": "Why LATAM professionals should care (English)",
    "viralReason": "What made this resonate (English)",
    "category": "models|tools|industry|tutorials|opinion|research",
    "tags": ["tag1", "tag2"],
    "repurposeAngle": "How to adapt this for LATAM newsletter audience (Spanish)",
    "suggestedHook": "Opening hook for newsletter (Spanish)",
    "suggestedFormat": "guia_practica|experimento|comparacion|contrario|curacion",
    "priority": "high|medium|low"
  }
]`;

    try {
      const result = await generate(prompt, {
        system: 'You are a senior content strategist. Be selective — only keep items that provide real value. Return valid JSON array only.',
        maxTokens: 4096,
      });

      const jsonMatch = result.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        const analyses = JSON.parse(jsonMatch[0]);
        for (let j = 0; j < Math.min(batch.length, analyses.length); j++) {
          const analysis = analyses[j];
          if (analysis.keep && analysis.relevanceScore >= 6) {
            allCurated.push({
              id: `cur-${Date.now()}-${allCurated.length}`,
              ...analysis,
              raw: {
                title: batch[j].title,
                content: batch[j].content,
                author: batch[j].author,
                url: batch[j].url,
                likes: batch[j].likes,
                retweets: batch[j].retweets,
                comments: batch[j].comments,
                source: batch[j].source,
                feedName: batch[j].feedName,
                group: batch[j].group,
                critical: batch[j].critical,
              },
              discoveredAt: new Date().toISOString(),
              status: 'new',
            });
          }
        }
      }
    } catch (e) {
      console.error(`  Curation batch error:`, e.message);
    }
  }

  // Sort by relevance score descending
  allCurated.sort((a, b) => (b.relevanceScore || 0) - (a.relevanceScore || 0));

  progress(`Curated: ${allCurated.length} high-quality items kept`);
  return allCurated;
}

// ============ STAGE 3: GENERATE BRIEFING ============

async function generateBriefing(curatedItems, onProgress) {
  const progress = (msg) => { console.log(msg); onProgress?.(msg); };
  progress('Generating briefing from curated data...');

  const contentSummary = curatedItems.map((item, i) => `
--- ${i + 1}. [${item.raw.source.toUpperCase()}] ${item.raw.title || item.coreIdea} ---
Author: ${item.raw.author}
Engagement: ${item.raw.likes || 0} likes${item.raw.retweets ? `, ${item.raw.retweets} RTs` : ''}
Core idea: ${item.coreIdea}
Why it matters: ${item.whyItMatters}
Category: ${item.category}
URL: ${item.raw.url}
`).join('\n');

  const prompt = `You are a senior tech analyst preparing an AI intelligence briefing for Irina, a LATAM-focused AI educator based in SF.

Below are ${curatedItems.length} curated, high-quality pieces of AI content from X, Hacker News, and RSS feeds.

## YOUR JOB
Produce a consolidated intelligence briefing. Synthesize across sources — do NOT summarize each item individually.

## FORMAT

### 🌊 The Big Picture
2-3 sentences: What's the dominant narrative in AI right now? What's the mood?

### 🔑 Key Themes
Group into 3-5 themes. For each:
- **Theme name** (bold)
- What's happening (2-3 sentences synthesizing MULTIPLE sources)
- Key voices: who said what (with engagement numbers)
- Notable data points

### 📊 Numbers That Matter
Bullet list of impactful stats and data points. Only ones that tell a story.

### 🔥 Hottest Takes
2-3 most provocative opinions — with attribution and engagement.

### 🌎 LATAM Relevance
Which themes matter most for Latin American professionals? Why? Local angle? (IN SPANISH)

### ⚡ Quick Hits
Noteworthy items that don't fit themes — one line each.

RULES:
- English EXCEPT LATAM section (Spanish)
- Be opinionated — flag signal vs noise
- Include specific numbers, names, engagement data
- Sharp analyst memo, not generic summary

CURATED CONTENT:
${contentSummary}`;

  const content = await generate(prompt, {
    system: 'You are a senior tech intelligence analyst. Sharp, specific, opinionated. No filler.',
    maxTokens: 4096,
  });

  const briefing = {
    id: `brief-${Date.now()}`,
    generatedAt: new Date().toISOString(),
    sourceCount: curatedItems.length,
    content,
    sources: curatedItems.map(item => ({
      title: item.raw.title || item.coreIdea,
      author: item.raw.author,
      source: item.raw.source,
      url: item.raw.url,
      likes: item.raw.likes,
      category: item.category,
    })),
  };

  progress('Briefing generated');
  return briefing;
}

// ============ MAIN PIPELINE ============

let pipelineStatus = { stage: 'idle', message: '', progress: [] };

function getStatus() {
  return pipelineStatus;
}

async function runPipeline() {
  const progressLog = [];
  const onProgress = (msg) => {
    progressLog.push({ time: new Date().toISOString(), message: msg });
    pipelineStatus = { stage: 'running', message: msg, progress: progressLog };
  };

  try {
    pipelineStatus = { stage: 'fetching', message: 'Starting pipeline...', progress: progressLog };
    
    const config = await loadConfig();
    
    // Stage 1: Fetch
    onProgress('Stage 1: Fetching from all sources...');
    const raw = await fetchAll(config, onProgress);
    
    // Stage 2: Curate
    onProgress('Stage 2: AI curation (filtering noise, analyzing quality)...');
    const curated = await curateItems(raw, onProgress);
    
    // Stage 3: Briefing
    onProgress('Stage 3: Generating intelligence briefing...');
    const briefing = await generateBriefing(curated, onProgress);
    
    // Save everything
    const pipeline = {
      raw: raw.map(r => ({ title: r.title, source: r.source, author: r.author, url: r.url, likes: r.likes })), // slim raw
      curated,
      briefing,
      lastFetch: new Date().toISOString(),
      lastCurate: new Date().toISOString(),
      lastBriefing: new Date().toISOString(),
      stats: {
        rawCount: raw.length,
        curatedCount: curated.length,
        sourceBreakdown: raw.reduce((acc, r) => { acc[r.source] = (acc[r.source] || 0) + 1; return acc; }, {}),
      },
      status: 'complete',
    };
    
    await savePipeline(pipeline);
    
    // Also save briefing to briefings history
    const briefingsPath = path.join(DATA_DIR, 'briefings.json');
    let briefings = [];
    try { briefings = JSON.parse(await fs.readFile(briefingsPath, 'utf-8')); } catch {}
    briefings.unshift(briefing);
    if (briefings.length > 20) briefings = briefings.slice(0, 20);
    await fs.writeFile(briefingsPath, JSON.stringify(briefings, null, 2));

    pipelineStatus = { stage: 'complete', message: `Done! ${curated.length} curated items, briefing ready.`, progress: progressLog };
    
    return pipeline;
  } catch (e) {
    pipelineStatus = { stage: 'error', message: e.message, progress: progressLog };
    throw e;
  }
}

module.exports = {
  runPipeline,
  getStatus,
  loadPipeline,
  loadConfig,
};

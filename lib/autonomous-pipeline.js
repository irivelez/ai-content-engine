/**
 * Autonomous Pipeline v2
 * Fetches → Curates (slim) → TL;DR → Saves daily JSON
 */

const fs = require('fs').promises;
const path = require('path');
const { execFile } = require('child_process');
const { generate } = require('./openclaw-client');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DAILY_DIR = path.join(DATA_DIR, 'daily');
const CONFIG_FILE = path.join(DATA_DIR, 'discovery-config.json');

const VALID_TAGS = ['multi-agent', 'claude-code', 'agentic', 'models', 'tools', 'business', 'tutorials', 'research', 'latam', 'contrarian'];
const VALID_CATEGORIES = ['tools', 'models', 'research', 'business', 'tutorials', 'opinion'];
const MAX_AGE_DAYS = 3;

function isRecent(dateStr) {
  if (!dateStr) return false; // no date = can't verify, skip
  try {
    const pubDate = new Date(dateStr);
    if (isNaN(pubDate.getTime())) return false;
    const cutoff = Date.now() - (MAX_AGE_DAYS * 24 * 60 * 60 * 1000);
    return pubDate.getTime() >= cutoff;
  } catch { return false; }
}

let pipelineStatus = { stage: 'idle', message: '', startedAt: null };

function getStatus() { return pipelineStatus; }

async function loadConfig() {
  try { return JSON.parse(await fs.readFile(CONFIG_FILE, 'utf-8')); }
  catch { return { sources: {}, queries: [], rssFeeds: [], subreddits: [] }; }
}

// ============ FETCH FUNCTIONS ============

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
      title: (t.text || '').slice(0, 120),
      content: t.text || '',
      author: `@${t.author?.username || 'unknown'}`,
      url: t.author?.username ? `https://x.com/${t.author.username}/status/${t.id}` : '',
      likes: t.likeCount || 0,
      comments: t.replyCount || 0,
      retweets: t.retweetCount || 0,
      views: t.viewCount || 0,
      source: 'x',
      publishedAt: t.createdAt || t.created_at || t.timeParsed || null,
    }));
  } catch (e) { console.error(`  X error "${query}":`, e.message); return []; }
}

async function fetchHN(limit = 20) {
  const aiKeywords = ['ai', 'llm', 'gpt', 'claude', 'anthropic', 'openai', 'machine learning',
    'neural', 'transformer', 'agent', 'copilot', 'coding assistant', 'chatbot', 'gemini',
    'diffusion', 'prompt', 'fine-tun', 'rag', 'vector', 'embedding', 'automation', 'deepseek',
    'multi-agent', 'agentic'];
  try {
    const topIds = await fetch('https://hacker-news.firebaseio.com/v0/topstories.json', { signal: AbortSignal.timeout(10000) }).then(r => r.json());
    const stories = [];
    for (const id of topIds.slice(0, 60)) {
      try {
        const item = await fetch(`https://hacker-news.firebaseio.com/v0/item/${id}.json`, { signal: AbortSignal.timeout(5000) }).then(r => r.json());
        if (!item?.title) continue;
        if (aiKeywords.some(kw => item.title.toLowerCase().includes(kw)) && item.score >= 30) {
          stories.push({
            title: item.title,
            content: item.title + (item.text ? '\n' + item.text : ''),
            author: item.by || 'unknown',
            url: item.url || `https://news.ycombinator.com/item?id=${id}`,
            likes: item.score,
            comments: item.descendants || 0,
            source: 'hackernews',
            publishedAt: item.time ? new Date(item.time * 1000).toISOString() : null,
          });
        }
        if (stories.length >= limit) break;
      } catch { continue; }
    }
    return stories;
  } catch (e) { console.error('  HN error:', e.message); return []; }
}

async function fetchRSS(feedUrl, sourceName) {
  try {
    const resp = await fetch(feedUrl, { headers: { 'User-Agent': 'ContentEngine/2.0' }, signal: AbortSignal.timeout(15000) });
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
          title, content: (desc || title).slice(0, 1000), author: sourceName, url: link,
          likes: 0, comments: 0, source: 'rss', sourceName,
          publishedAt: pubDate || null,
        });
      }
    }
    return items;
  } catch (e) { console.error(`  RSS error ${sourceName}:`, e.message); return []; }
}

async function searchReddit(subreddit, limit = 10) {
  // Reddit blocks server-side JSON/RSS API requests (403). Use Brave Search as a $0 proxy.
  // Brave's site: operator returns 0 results, so we use "reddit.com <subreddit> <topic>" queries.
  const BRAVE_API_KEY = process.env.BRAVE_API_KEY;
  if (!BRAVE_API_KEY) { console.error(`  Reddit: no BRAVE_API_KEY, skipping r/${subreddit}`); return []; }
  try {
    // Map subreddits to relevant search terms for better results
    const topicMap = {
      'ClaudeAI': 'reddit ClaudeAI Claude Code AI agents',
      'ClaudeCode': 'reddit ClaudeCode Claude Code coding agents',
      'ChatGPT': 'reddit ChatGPT AI tools workflow',
      'AI_Agents': 'reddit AI_Agents agents automation workflow',
      'artificial': 'reddit artificial intelligence AI news',
    };
    const query = topicMap[subreddit] || `reddit ${subreddit} AI`;
    const resp = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${limit}&freshness=pw`, {
      headers: { 'Accept': 'application/json', 'X-Subscription-Token': BRAVE_API_KEY },
      signal: AbortSignal.timeout(15000),
    });
    if (!resp.ok) { console.error(`  Reddit/Brave r/${subreddit}: HTTP ${resp.status}`); return []; }
    const data = await resp.json();
    // Only keep actual Reddit URLs
    return (data.web?.results || [])
      .filter(r => r.url && r.url.includes('reddit.com/r/'))
      .map(r => ({
        title: (r.title || '').replace(/^r\/\w+ on Reddit:\s*/, '').replace(/ : r\/\w+$/, ''),
        content: r.description || r.title || '',
        author: `r/${subreddit}`,
        url: r.url,
        likes: 0, comments: 0, source: 'reddit',
        publishedAt: r.page_age ? new Date(Date.now() - parsePageAge(r.page_age)).toISOString() : new Date().toISOString(),
      }));
  } catch (e) { console.error(`  Reddit/Brave r/${subreddit} error:`, e.message); return []; }
}

// Parse Brave's page_age strings like "3 days ago", "1 week ago" into milliseconds
function parsePageAge(str) {
  if (!str) return 0;
  const m = str.match(/(\d+)\s*(hour|day|week|month)/i);
  if (!m) return 0;
  const n = parseInt(m[1]);
  const unit = m[2].toLowerCase();
  const ms = { hour: 3600000, day: 86400000, week: 604800000, month: 2592000000 };
  return n * (ms[unit] || 86400000);
}

// ============ FETCH ALL ============

async function fetchAll(config) {
  const results = [];

  // --- TIER 1: Trusted Voices (always include, no filter) ---
  const trustedHandles = new Set((config.trustedVoices || []).map(h => h.toLowerCase()));
  for (const handle of (config.trustedVoices || [])) {
    const tweets = await searchX(`from:${handle}`, 10);
    results.push(...tweets.map(t => ({ ...t, tier: 'trusted' })));
    await new Promise(r => setTimeout(r, 600));
  }

  // --- TIER 2: Broad keyword search (quality-filtered) ---
  for (const query of (config.queries || [])) {
    const tweets = await searchX(query, 15);
    const filtered = tweets.filter(t => {
      const authorHandle = (t.author || '').replace('@', '').toLowerCase();
      if (trustedHandles.has(authorHandle)) return true;
      if ((t.likes || 0) < 100) return false;
      const text = (t.content || t.title || '').replace(/https?:\/\/\S+/g, '').trim();
      if (text.length < 60) return false;
      return true;
    });
    results.push(...filtered.map(t => ({
      ...t,
      tier: trustedHandles.has((t.author || '').replace('@', '').toLowerCase()) ? 'trusted' : 'broad'
    })));
    await new Promise(r => setTimeout(r, 800));
  }

  // HN
  console.log('  Fetching HN...');
  results.push(...await fetchHN(20));

  // RSS
  for (const feed of (config.rssFeeds || [])) {
    const items = await fetchRSS(feed.url, feed.name);
    results.push(...items);
    await new Promise(r => setTimeout(r, 300));
  }

  // Reddit
  for (const sub of (config.subreddits || [])) {
    const items = await searchReddit(sub);
    results.push(...items);
    await new Promise(r => setTimeout(r, 1000));
  }

  // Filter to recent items only (last 3 days) — drop undated items too
  const recent = results.filter(item => {
    if (!item.publishedAt) return false; // no date = can't verify freshness, drop it
    return isRecent(item.publishedAt);
  });
  console.log(`  Date filter: ${recent.length} recent from ${results.length} total (last ${MAX_AGE_DAYS} days)`);
  return recent;
}

// ============ CURATE ============

async function curateItems(rawItems) {
  // Deduplicate
  const seen = new Set();
  const deduped = rawItems.filter(item => {
    const key = item.url || item.title?.toLowerCase().slice(0, 60);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  console.log(`  Deduped: ${deduped.length} from ${rawItems.length}`);

  const BATCH_SIZE = 15;
  const allCurated = [];

  for (let i = 0; i < deduped.length; i += BATCH_SIZE) {
    const batch = deduped.slice(i, i + BATCH_SIZE);
    console.log(`  Curating batch ${Math.floor(i/BATCH_SIZE) + 1}...`);

    const today = new Date().toISOString().slice(0, 10);
    const prompt = `Review these ${batch.length} AI content items. For each, decide if it's worth keeping (relevant to AI practitioners). Today is ${today} — REJECT anything older than 3 days.

Items:
${batch.map((item, j) => `[${j}] ${item.source.toUpperCase()} | ${item.author} | ${item.title} | ${item.likes || 0}♥ ${item.retweets || 0}🔁 ${item.comments || 0}💬 | ${item.url} | ${item.publishedAt || 'no date'}`).join('\n')}

Return JSON array, one per item. If not worth keeping, return {"keep":false}. If keeping:
{
  "keep": true,
  "title": "clean title",
  "insight": "One-line take on why this matters (English, max 120 chars)",
  "relevance": 7,
  "tags": ["multi-agent", "claude-code"],
  "category": "tools|models|research|business|tutorials|opinion"
}

Tags MUST be from: multi-agent, claude-code, agentic, models, tools, business, tutorials, research, latam, contrarian
Use "contrarian" tag when the take challenges mainstream AI hype or pushes back on popular narratives — these are HIGH VALUE for business decision-makers who need the full picture.
Relevance: 1-10. Only keep items scoring 6+.
Be selective. No fluff. Think: would a business leader care about this?`;

    try {
      const result = await generate(prompt, {
        system: 'Return valid JSON array only. No explanation.',
        maxTokens: 3000,
      });

      const jsonMatch = result.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        let analyses;
        try { analyses = JSON.parse(jsonMatch[0]); }
        catch { 
          // Try cleaning common JSON issues (trailing commas, etc.)
          const cleaned = jsonMatch[0].replace(/,\s*([}\]])/g, '$1');
          try { analyses = JSON.parse(cleaned); } catch { console.error('  JSON parse failed for batch, skipping'); continue; }
        }
        for (let j = 0; j < Math.min(batch.length, analyses.length); j++) {
          const a = analyses[j];
          if (a.keep && (a.relevance || 0) >= 6) {
            const raw = batch[j];
            allCurated.push({
              id: `item-${Date.now()}-${allCurated.length}`,
              title: a.title || raw.title,
              source: raw.source === 'hackernews' ? 'hackernews' : raw.source,
              sourceName: raw.author || raw.sourceName || raw.source,
              url: raw.url,
              insight: (a.insight || '').slice(0, 150),
              relevance: Math.min(10, Math.max(1, a.relevance || 5)),
              tags: (a.tags || []).filter(t => VALID_TAGS.includes(t)),
              category: VALID_CATEGORIES.includes(a.category) ? a.category : 'tools',
              engagement: { likes: raw.likes || 0, comments: raw.comments || 0, retweets: raw.retweets || 0, views: raw.views || 0 },
              hot: (raw.likes || 0) >= 10000, // ~1M+ views equivalent (10.7M views ≈ 60K likes ratio from viral posts)
              publishedAt: raw.publishedAt || null,
            });
          }
        }
      }
    } catch (e) {
      console.error(`  Curation error:`, e.message);
    }
  }

  allCurated.sort((a, b) => b.relevance - a.relevance);
  return { items: allCurated, rawCount: rawItems.length };
}

// ============ BIG PICTURE + TL;DR ============

async function generateBigPictureAndTLDR(items) {
  if (!items.length) return { bigPicture: 'No data today.', dataPoints: [], tldr: ['No items found today.'] };
  const topItems = items.slice(0, 25);
  const prompt = `Analyze these ${topItems.length} AI content items and produce:

1. **bigPicture**: A single bold editorial thesis (1-2 sentences) that captures the dominant tension or narrative of the day. Think like a sharp analyst writing a newsletter header — opinionated, specific, not generic. Example: "AI capability is accelerating faster than our ability to manage it well."

2. **dataPoints**: Exactly 3-4 key stats or concrete data points from the items that tell the story better than any paragraph. Each should have a "stat" (the number/fact, short) and "context" (one-line explanation). Example: { "stat": "1,000+ commits/hour", "context": "Cursor agents shipping code at unprecedented scale" }

3. **tldr**: 5 bullet summaries of the most important themes/signals.

Items:
${topItems.map(i => `- [${i.source}] ${i.title}: ${i.insight} | ${i.engagement?.likes || 0}♥`).join('\n')}

Return JSON object:
{
  "bigPicture": "string",
  "dataPoints": [{"stat": "string", "context": "string"}],
  "tldr": ["string"]
}`;

  try {
    const result = await generate(prompt, { system: 'Return valid JSON object only. No explanation.', maxTokens: 1200 });
    const match = result.match(/\{[\s\S]*\}/);
    if (match) {
      const parsed = JSON.parse(match[0]);
      return {
        bigPicture: parsed.bigPicture || 'Signal processing...',
        dataPoints: (parsed.dataPoints || []).slice(0, 4),
        tldr: (parsed.tldr || []).slice(0, 5),
      };
    }
  } catch (e) { console.error('  BigPicture+TL;DR error:', e.message); }
  return { bigPicture: 'Signal processing...', dataPoints: [], tldr: items.slice(0, 5).map(i => i.title) };
}

// ============ MAIN ============

async function runAutonomousPipeline() {
  const today = new Date().toISOString().slice(0, 10);
  pipelineStatus = { stage: 'fetching', message: 'Fetching sources...', startedAt: new Date().toISOString() };

  try {
    const config = await loadConfig();

    // Fetch
    console.log('⚡ Autonomous pipeline: fetching...');
    const raw = await fetchAll(config);
    pipelineStatus.message = `Fetched ${raw.length} items, curating...`;
    pipelineStatus.stage = 'curating';

    // Curate
    console.log(`⚡ Curating ${raw.length} items...`);
    const { items, rawCount } = await curateItems(raw);
    pipelineStatus.message = `Curated ${items.length} items, generating TL;DR...`;
    pipelineStatus.stage = 'summarizing';

    // Big Picture + TL;DR
    const { bigPicture, dataPoints, tldr } = await generateBigPictureAndTLDR(items);

    // Build daily data
    const sourceBreakdown = raw.reduce((acc, r) => { acc[r.source] = (acc[r.source] || 0) + 1; return acc; }, {});
    const dailyData = {
      date: today,
      generatedAt: new Date().toISOString(),
      bigPicture,
      dataPoints,
      tldr,
      items,
      stats: { rawFetched: rawCount, kept: items.length, sourceBreakdown },
    };

    // Save
    await fs.mkdir(DAILY_DIR, { recursive: true });
    await fs.writeFile(path.join(DAILY_DIR, `${today}.json`), JSON.stringify(dailyData, null, 2));
    await fs.writeFile(path.join(DATA_DIR, 'latest.json'), JSON.stringify(dailyData, null, 2));

    pipelineStatus = { stage: 'complete', message: `Done! ${items.length} items curated.`, startedAt: pipelineStatus.startedAt, completedAt: new Date().toISOString() };
    console.log(`⚡ Pipeline complete: ${items.length} items saved to data/daily/${today}.json`);
    return dailyData;
  } catch (e) {
    pipelineStatus = { stage: 'error', message: e.message, startedAt: pipelineStatus.startedAt };
    throw e;
  }
}

async function getAvailableDays() {
  try {
    const files = await fs.readdir(DAILY_DIR);
    return files.filter(f => f.match(/^\d{4}-\d{2}-\d{2}\.json$/)).map(f => f.replace('.json', '')).sort().reverse();
  } catch { return []; }
}

async function getDailyData(date) {
  const filePath = path.join(DAILY_DIR, `${date}.json`);
  return JSON.parse(await fs.readFile(filePath, 'utf-8'));
}

async function getLatestData() {
  try { return JSON.parse(await fs.readFile(path.join(DATA_DIR, 'latest.json'), 'utf-8')); }
  catch { return null; }
}

module.exports = { runAutonomousPipeline, getStatus, getAvailableDays, getDailyData, getLatestData };

/**
 * Discovery Engine
 * Finds viral AI content and extracts repurposable ideas for LATAM audience
 * 
 * Works in two modes:
 * 1. Automated: Uses bird CLI to search X (requires auth)
 * 2. Manual: Accepts URLs/text/tweets fed via API
 */

const fs = require('fs').promises;
const { execFile } = require('child_process');
const path = require('path');
const { generate } = require('./openclaw-client');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DISCOVERIES_FILE = path.join(DATA_DIR, 'discoveries.json');
const CONFIG_FILE = path.join(DATA_DIR, 'discovery-config.json');

// ============ DATA LAYER ============

async function loadDiscoveries() {
  try {
    const data = await fs.readFile(DISCOVERIES_FILE, 'utf-8');
    return JSON.parse(data);
  } catch {
    return { items: [], lastSearch: null };
  }
}

async function saveDiscoveries(discoveries) {
  await fs.writeFile(DISCOVERIES_FILE, JSON.stringify(discoveries, null, 2));
}

async function loadConfig() {
  try {
    const data = await fs.readFile(CONFIG_FILE, 'utf-8');
    return JSON.parse(data);
  } catch {
    return {
      queries: ['AI tools', 'Claude tips', 'ChatGPT prompts'],
      minEngagement: { likes: 100, retweets: 20 },
      maxResults: 20
    };
  }
}

// ============ X/TWITTER DIRECT API ============

function isXAvailable() {
  const token = process.env.BIRD_AUTH_TOKEN;
  const ct0 = process.env.BIRD_CT0;
  return !!(token && ct0);
}

async function searchX(query, count = 10) {
  const token = process.env.BIRD_AUTH_TOKEN;
  const ct0 = process.env.BIRD_CT0;
  if (!token || !ct0) return [];

  try {
    const birdBin = path.join(__dirname, '..', 'node_modules', '.bin', 'bird');
    const args = ['search', query, '--count', String(count), '--json', '--auth-token', token, '--ct0', ct0];
    
    const result = await new Promise((resolve, reject) => {
      execFile(birdBin, args, { timeout: 30000, maxBuffer: 5 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) return reject(err);
        resolve(stdout);
      });
    });

    const tweets = JSON.parse(result);
    return tweets.map(t => ({
      id: t.id,
      text: t.text || '',
      title: (t.text || '').slice(0, 100),
      content: t.text || '',
      author: `@${t.author?.username || 'unknown'}`,
      likes: t.likeCount || 0,
      retweets: t.retweetCount || 0,
      views: t.viewCount || t.views || 0,
      url: t.author?.username ? `https://x.com/${t.author.username}/status/${t.id}` : '',
      source: 'x',
    })).sort((a, b) => (b.likes + b.retweets * 3) - (a.likes + a.retweets * 3)).slice(0, count);
  } catch (e) {
    console.error(`  X search error for "${query}":`, e.message);
    return [];
  }
}

// ============ HACKER NEWS API ============

async function searchHN(limit = 15) {
  try {
    const topResp = await fetch('https://hacker-news.firebaseio.com/v0/topstories.json', { signal: AbortSignal.timeout(10000) });
    const topIds = await topResp.json();
    const stories = [];
    const aiKeywords = ['ai', 'llm', 'gpt', 'claude', 'anthropic', 'openai', 'machine learning',
      'neural', 'transformer', 'agent', 'copilot', 'coding assistant', 'chatbot', 'gemini',
      'diffusion', 'prompt', 'fine-tun', 'rag', 'vector', 'embedding', 'saas', 'automation'];
    for (const id of topIds.slice(0, 50)) {
      try {
        const resp = await fetch(`https://hacker-news.firebaseio.com/v0/item/${id}.json`, { signal: AbortSignal.timeout(5000) });
        const item = await resp.json();
        if (!item || !item.title) continue;
        const titleLower = item.title.toLowerCase();
        if (aiKeywords.some(kw => titleLower.includes(kw)) && item.score >= 30) {
          stories.push({
            title: item.title, content: item.title + (item.text ? '\n' + item.text : ''),
            text: item.title, author: item.by || 'unknown',
            url: item.url || `https://news.ycombinator.com/item?id=${id}`,
            likes: item.score, retweets: 0, comments: item.descendants || 0, source: 'hackernews',
          });
        }
        if (stories.length >= limit) break;
      } catch { continue; }
    }
    return stories;
  } catch (e) { console.error('  HN error:', e.message); return []; }
}

// ============ RSS FEEDS ============

async function fetchRSS(feedUrl, sourceName) {
  try {
    const resp = await fetch(feedUrl, { headers: { 'User-Agent': 'ContentEngine/1.0' }, signal: AbortSignal.timeout(15000) });
    if (!resp.ok) { console.error(`  RSS ${sourceName} failed: ${resp.status}`); return []; }
    const xml = await resp.text();
    const items = [];
    const matches = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g), ...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)];
    for (const match of matches.slice(0, 10)) {
      const block = match[1];
      const title = block.match(/<title[^>]*>([\s\S]*?)<\/title>/)?.[1]?.replace(/<!\[CDATA\[(.*?)\]\]>/, '$1')?.trim() || '';
      const link = block.match(/<link[^>]*href="([^"]*)"/) ?.[1] || block.match(/<link>([\s\S]*?)<\/link>/)?.[1]?.trim() || '';
      const desc = block.match(/<description[^>]*>([\s\S]*?)<\/description>/)?.[1]?.replace(/<!\[CDATA\[(.*?)\]\]>/s, '$1')?.replace(/<[^>]+>/g, '')?.trim() || '';
      if (title) {
        items.push({
          title, content: (desc || title).slice(0, 1000), text: (desc || title).slice(0, 1000),
          author: sourceName, url: link, likes: 0, retweets: 0, source: 'rss', feedName: sourceName,
        });
      }
    }
    return items;
  } catch (e) { console.error(`  RSS error for ${sourceName}:`, e.message); return []; }
}

// ============ REDDIT (may be blocked) ============

async function searchReddit(subreddit, sort = 'hot', limit = 10) {
  try {
    const resp = await fetch(`https://www.reddit.com/r/${subreddit}/${sort}.json?limit=${limit}&t=week&raw_json=1`, {
      headers: { 'User-Agent': 'ContentEngine/1.0 (research)', 'Accept': 'application/json' },
      signal: AbortSignal.timeout(15000),
    });
    if (!resp.ok) { console.error(`  Reddit r/${subreddit} blocked (${resp.status})`); return []; }
    const data = await resp.json();
    return (data.data?.children || []).filter(p => p.data.score >= 50).map(p => ({
      title: p.data.title, content: p.data.selftext || p.data.title, text: p.data.selftext || p.data.title,
      author: `u/${p.data.author}`, url: `https://reddit.com${p.data.permalink}`,
      likes: p.data.score, retweets: 0, source: 'reddit',
    }));
  } catch (e) { console.error(`  Reddit r/${subreddit} error — skipping`); return []; }
}

async function searchAllRSS(config) {
  const feeds = config.rssFeeds || [];
  const allItems = [];
  for (const feed of feeds) {
    const items = await fetchRSS(feed.url, feed.name);
    allItems.push(...items);
    await new Promise(r => setTimeout(r, 500));
  }
  return allItems;
}

async function runAutomatedSearch() {
  const config = await loadConfig();
  const allResults = [];
  const trustedHandles = new Set((config.trustedVoices || []).map(h => h.toLowerCase()));
  const qualityFilter = config.broadSearchQualityFilter || { minFollowers: 10000, minEngagementRate: 0.005 };

  // --- TIER 1: Trusted Voices (always include, no engagement filter) ---
  for (const handle of (config.trustedVoices || [])) {
    try {
      const results = await searchX(`from:${handle}`, 10);
      if (Array.isArray(results)) {
        allResults.push(...results.map(r => ({
          source: 'x',
          query: `from:${handle}`,
          tier: 'trusted',
          ...r
        })));
      }
      await new Promise(r => setTimeout(r, 800));
    } catch (e) {
      console.error(`Failed to fetch @${handle}:`, e.message);
    }
  }

  // --- TIER 2: Broad keyword search (quality-filtered) ---
  for (const query of (config.queries || [])) {
    const results = await searchX(query, 15);
    if (Array.isArray(results)) {
      const filtered = results.filter(r => {
        const authorHandle = (r.author || '').replace('@', '').toLowerCase();
        // If from a trusted voice, always include
        if (trustedHandles.has(authorHandle)) return true;
        // Quality check: engagement relative to a baseline
        const engagement = (r.likes || 0) + (r.retweets || 0) * 3;
        if (engagement < 50) return false;
        // Skip low-effort link dumps (very short text with a URL = likely just resharing)
        const text = (r.text || r.content || '').replace(/https?:\/\/\S+/g, '').trim();
        if (text.length < 60) return false;
        return true;
      });
      allResults.push(...filtered.map(r => ({
        source: 'x',
        query,
        tier: trustedHandles.has((r.author || '').replace('@', '').toLowerCase()) ? 'trusted' : 'broad',
        ...r
      })));
    }
    await new Promise(r => setTimeout(r, 1000));
  }

  // Reddit
  const subreddits = config.subreddits || ['ChatGPT', 'artificial', 'ClaudeAI', 'LocalLLaMA'];
  for (const sub of subreddits) {
    console.log(`  Searching r/${sub}...`);
    const results = await searchReddit(sub, 'hot', 10);
    allResults.push(...results);
    await new Promise(r => setTimeout(r, 1000));
  }

  // Hacker News
  console.log('  Searching Hacker News...');
  const hnResults = await searchHN(15);
  allResults.push(...hnResults);

  // RSS feeds
  if (config.rssFeeds && config.rssFeeds.length > 0) {
    console.log(`  Fetching ${config.rssFeeds.length} RSS feeds...`);
    const rssResults = await searchAllRSS(config);
    allResults.push(...rssResults);
  }

  console.log(`  Total raw results: ${allResults.length}`);
  return allResults;
}

// ============ CONTENT ANALYSIS ============

const ANALYSIS_SYSTEM = `You are a content analyst for Irina, an AI educator targeting LATAM professionals.

Your job: Analyze viral/popular AI content and extract repurposable ideas.

For each piece of content, determine:
1. Core idea (what makes it valuable)
2. Why it went viral (hook, format, topic)
3. LATAM relevance score (1-10): Would LATAM professionals care about this?
4. Repurpose angle: How would Irina adapt this for her Spanish-speaking newsletter audience?
5. Suggested topic for her how-to guide

Her audience: Knowledge workers, managers, professionals in LATAM who aren't developers but want to use AI effectively.
Her style: Direct, personal, actionable. Spanish with English tech terms.

Return valid JSON only.`;

async function analyzeContent(items) {
  const prompt = `Analyze these ${items.length} pieces of viral/popular AI content.

For EACH item, extract a repurposable idea for Irina's LATAM audience.

Content items:
${items.map((item, i) => `
--- Item ${i + 1} ---
Source: ${item.source || 'web'}
${item.author ? `Author: ${item.author}` : ''}
${item.title ? `Title: ${item.title}` : ''}
${item.url ? `URL: ${item.url}` : ''}
Content: ${(item.text || item.content || item.snippet || '').slice(0, 800)}
${item.likes ? `Likes: ${item.likes}` : ''}
${item.retweets ? `Retweets: ${item.retweets}` : ''}
`).join('\n')}

Return a JSON array of objects, one per item:
[
  {
    "originalTitle": "title or first line of original",
    "coreIdea": "the key insight worth repurposing",
    "viralReason": "why this resonated",
    "latamScore": 8,
    "repurposeAngle": "how Irina should adapt this",
    "suggestedTopic": "specific topic for her newsletter",
    "suggestedHook": "hook in Spanish for the guide",
    "priority": "high|medium|low",
    "tags": ["AI tools", "productivity"]
  }
]`;

  const result = await generate(prompt, {
    system: ANALYSIS_SYSTEM,
    maxTokens: 4096
  });

  try {
    const jsonMatch = result.match(/\[[\s\S]*\]/);
    return jsonMatch ? JSON.parse(jsonMatch[0]) : [];
  } catch {
    console.error('Failed to parse analysis result');
    return [{ raw: result, error: 'parse_failed' }];
  }
}

// ============ MAIN DISCOVERY FLOW ============

/**
 * Full automated discovery:
 * 1. Search X for viral AI content
 * 2. Analyze with Claude
 * 3. Store discoveries
 */
async function runDiscovery() {
  const xOk = isXAvailable();
  
  if (!xOk) {
    return { 
      success: false, 
      error: 'x_no_auth',
      message: 'X cookies not configured. Set BIRD_AUTH_TOKEN and BIRD_CT0 in .env'
    };
  }

  const rawResults = await runAutomatedSearch();
  if (rawResults.length === 0) {
    return { success: true, items: [], message: 'No results found' };
  }

  const analysis = await analyzeContent(rawResults);
  
  // Store discoveries
  const discoveries = await loadDiscoveries();
  const newItems = analysis
    .filter(a => !a.error)
    .map((a, i) => ({
      id: `d-${Date.now()}-${i}`,
      ...a,
      raw: rawResults[i] || null,
      discoveredAt: new Date().toISOString(),
      status: 'new' // new, reviewed, imported, dismissed
    }));

  discoveries.items.unshift(...newItems);
  discoveries.lastSearch = new Date().toISOString();
  
  // Keep only last 100 discoveries
  if (discoveries.items.length > 100) {
    discoveries.items = discoveries.items.slice(0, 100);
  }
  
  await saveDiscoveries(discoveries);
  
  return { success: true, items: newItems, total: newItems.length };
}

/**
 * Manual feed: Accept content from external sources (web search, URLs, pasted text)
 * and analyze it for repurposable ideas
 */
async function feedContent(items) {
  if (!items || items.length === 0) {
    return { success: false, error: 'No items provided' };
  }

  const analysis = await analyzeContent(items);
  
  const discoveries = await loadDiscoveries();
  const newItems = analysis
    .filter(a => !a.error)
    .map((a, i) => ({
      id: `d-${Date.now()}-${i}`,
      ...a,
      raw: items[i] || null,
      discoveredAt: new Date().toISOString(),
      status: 'new'
    }));

  discoveries.items.unshift(...newItems);
  if (discoveries.items.length > 100) {
    discoveries.items = discoveries.items.slice(0, 100);
  }
  await saveDiscoveries(discoveries);

  return { success: true, items: newItems, total: newItems.length };
}

/**
 * Get all discoveries, optionally filtered
 */
async function getDiscoveries(filter = {}) {
  const discoveries = await loadDiscoveries();
  let items = discoveries.items;

  if (filter.status) {
    items = items.filter(i => i.status === filter.status);
  }
  if (filter.minScore) {
    items = items.filter(i => (i.latamScore || 0) >= filter.minScore);
  }
  if (filter.priority) {
    items = items.filter(i => i.priority === filter.priority);
  }

  return {
    items,
    total: items.length,
    lastSearch: discoveries.lastSearch
  };
}

/**
 * Update discovery status
 */
async function updateDiscovery(id, updates) {
  const discoveries = await loadDiscoveries();
  const item = discoveries.items.find(i => i.id === id);
  if (!item) return null;

  Object.assign(item, updates, { updatedAt: new Date().toISOString() });
  await saveDiscoveries(discoveries);
  return item;
}

/**
 * Import discovery to topic bank
 */
async function importToTopicBank(id) {
  const discoveries = await loadDiscoveries();
  const item = discoveries.items.find(i => i.id === id);
  if (!item) return null;

  // Create topic bank entry
  const topic = {
    id: Date.now().toString(36),
    idea: item.suggestedTopic || item.coreIdea,
    source: 'discovery',
    notes: `Repurpose angle: ${item.repurposeAngle || 'N/A'}\nHook: ${item.suggestedHook || 'N/A'}\nOriginal: ${item.originalTitle || 'N/A'}`,
    discoveryId: id,
    status: 'raw',
    createdAt: new Date().toISOString()
  };

  // Load and update topic bank
  const topicsFile = path.join(DATA_DIR, 'topics.json');
  let bank;
  try {
    bank = JSON.parse(await fs.readFile(topicsFile, 'utf-8'));
  } catch {
    bank = { topics: [], generated: [] };
  }
  bank.topics.push(topic);
  await fs.writeFile(topicsFile, JSON.stringify(bank, null, 2));

  // Update discovery status
  item.status = 'imported';
  item.importedAt = new Date().toISOString();
  item.topicId = topic.id;
  await saveDiscoveries(discoveries);

  return { topic, discovery: item };
}

/**
 * Delete/dismiss a discovery
 */
async function dismissDiscovery(id) {
  const discoveries = await loadDiscoveries();
  const item = discoveries.items.find(i => i.id === id);
  if (!item) return false;

  item.status = 'dismissed';
  item.dismissedAt = new Date().toISOString();
  await saveDiscoveries(discoveries);
  return true;
}

module.exports = {
  runDiscovery,
  feedContent,
  getDiscoveries,
  updateDiscovery,
  importToTopicBank,
  dismissDiscovery,
  isXAvailable,
  loadConfig
};

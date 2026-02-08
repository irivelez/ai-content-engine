/**
 * Discovery Engine
 * Finds viral AI content and extracts repurposable ideas for LATAM audience
 * 
 * Sources: X/Twitter, Reddit, Hacker News (Algolia), RSS feeds
 * Modes: trusted (tracked accounts/RSS) and discovery (keyword combos)
 */

const fs = require('fs').promises;
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
    const params = new URLSearchParams({
      q: query, count: String(count), result_filter: 'top', tweet_search_mode: 'live',
    });
    const resp = await fetch(`https://api.x.com/2/search/adaptive.json?${params}`, {
      headers: {
        'Authorization': 'Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA',
        'Cookie': `auth_token=${token}; ct0=${ct0}`,
        'X-Csrf-Token': ct0,
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(30000),
    });
    if (!resp.ok) { console.error(`  X search failed (${resp.status}) for "${query}"`); return []; }
    const data = await resp.json();
    const tweets = [];
    const tweetEntries = data.globalObjects?.tweets || {};
    const userEntries = data.globalObjects?.users || {};
    for (const [id, tweet] of Object.entries(tweetEntries)) {
      const user = userEntries[tweet.user_id_str] || {};
      tweets.push({
        id, text: tweet.full_text || tweet.text || '',
        title: (tweet.full_text || tweet.text || '').slice(0, 100),
        content: tweet.full_text || tweet.text || '',
        author: `@${user.screen_name || 'unknown'}`,
        likes: tweet.favorite_count || 0, retweets: tweet.retweet_count || 0,
        url: user.screen_name ? `https://x.com/${user.screen_name}/status/${id}` : '',
        source: 'x',
      });
    }
    tweets.sort((a, b) => (b.likes + b.retweets * 3) - (a.likes + a.retweets * 3));
    return tweets.slice(0, count);
  } catch (e) {
    console.error(`  X search error for "${query}":`, e.message);
    return [];
  }
}

// ============ HACKER NEWS (Algolia API) ============

async function searchHN(config) {
  const queries = config.hnQueries || ['claude code', 'ai agent', 'anthropic'];
  const threshold = config.engagementThresholds?.hn?.points || 100;
  const seenUrls = new Set();
  const allStories = [];

  for (const query of queries) {
    try {
      const encoded = encodeURIComponent(query);
      const url = `https://hn.algolia.com/api/v1/search?query=${encoded}&tags=story&numericFilters=points%3E${threshold}&hitsPerPage=10`;
      const resp = await fetch(url, { signal: AbortSignal.timeout(10000) });
      if (!resp.ok) { console.error(`  HN Algolia failed (${resp.status}) for "${query}"`); continue; }
      const data = await resp.json();

      for (const hit of (data.hits || [])) {
        const storyUrl = hit.url || `https://news.ycombinator.com/item?id=${hit.objectID}`;
        if (seenUrls.has(storyUrl)) continue;
        seenUrls.add(storyUrl);

        allStories.push({
          title: hit.title || '', content: hit.title + (hit.story_text ? '\n' + hit.story_text : ''),
          text: hit.title, author: hit.author || 'unknown',
          url: storyUrl,
          likes: hit.points || 0, retweets: 0, comments: hit.num_comments || 0,
          source: 'hackernews',
          hnQuery: query,
        });
      }
      await new Promise(r => setTimeout(r, 300));
    } catch (e) {
      console.error(`  HN Algolia error for "${query}":`, e.message);
    }
  }

  allStories.sort((a, b) => b.likes - a.likes);
  return allStories;
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

// ============ REDDIT ============

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

// ============ ENGAGEMENT FILTERING ============

function meetsEngagementThreshold(item, thresholds) {
  if (!thresholds) return true;
  if (item.source === 'x') {
    const t = thresholds.x;
    if (!t) return true;
    return (item.likes || 0) >= t.likes || (item.retweets || 0) >= t.retweets;
  }
  if (item.source === 'reddit') {
    const t = thresholds.reddit;
    if (!t) return true;
    return (item.likes || 0) >= t.upvotes;
  }
  if (item.source === 'hackernews') {
    const t = thresholds.hn;
    if (!t) return true;
    return (item.likes || 0) >= t.points;
  }
  return true; // RSS and others pass through
}

// ============ AUTOMATED SEARCH ============

async function runAutomatedSearch() {
  const config = await loadConfig();
  const trustedResults = [];
  const discoveryResults = [];

  // === TRUSTED SOURCES ===

  // Search by tracked accounts (trusted)
  if (config.sources) {
    const allAccounts = [];
    for (const group of Object.values(config.sources)) {
      if (group.accounts) {
        for (const handle of group.accounts) {
          allAccounts.push({
            handle,
            critical: group.critical?.includes(handle) || false,
            group: group.label
          });
        }
      }
    }

    for (const account of allAccounts) {
      try {
        const results = await searchX(`from:${account.handle}`, account.critical ? 20 : 10);
        if (Array.isArray(results)) {
          trustedResults.push(...results.map(r => ({
            ...r,
            source: 'x',
            query: `from:${account.handle}`,
            group: account.group,
            critical: account.critical,
            sourceType: 'trusted',
          })));
        }
        await new Promise(r => setTimeout(r, 800));
      } catch (e) {
        console.error(`Failed to fetch @${account.handle}:`, e.message);
      }
    }
  }

  // Search by topic queries on X (trusted)
  for (const query of (config.queries || [])) {
    const results = await searchX(query, 10);
    if (Array.isArray(results)) {
      trustedResults.push(...results.map(r => ({
        ...r,
        source: 'x',
        query,
        sourceType: 'trusted',
      })));
    }
    await new Promise(r => setTimeout(r, 1000));
  }

  // Reddit (trusted - from configured subreddits)
  const subreddits = config.subreddits || ['ClaudeAI', 'ClaudeCode', 'ChatGPT', 'AI_Agents', 'artificial'];
  for (const sub of subreddits) {
    console.log(`  Searching r/${sub}...`);
    const results = await searchReddit(sub, 'hot', 10);
    trustedResults.push(...results.map(r => ({ ...r, sourceType: 'trusted' })));
    await new Promise(r => setTimeout(r, 1000));
  }

  // Hacker News (trusted - from configured queries)
  console.log('  Searching Hacker News (Algolia)...');
  const hnResults = await searchHN(config);
  trustedResults.push(...hnResults.map(r => ({ ...r, sourceType: 'trusted' })));

  // RSS feeds (trusted)
  if (config.rssFeeds && config.rssFeeds.length > 0) {
    console.log(`  Fetching ${config.rssFeeds.length} RSS feeds...`);
    const rssResults = await searchAllRSS(config);
    trustedResults.push(...rssResults.map(r => ({ ...r, sourceType: 'trusted' })));
  }

  // === DISCOVERY SOURCES (keyword combos) ===

  const combos = config.keywordCombos || [];
  if (combos.length > 0) {
    console.log(`  Running ${combos.length} keyword combos...`);
    const thresholds = config.engagementThresholds || {};

    for (const combo of combos) {
      // X keyword search
      if (isXAvailable()) {
        const xResults = await searchX(combo, 10);
        if (Array.isArray(xResults)) {
          discoveryResults.push(...xResults
            .map(r => ({ ...r, source: 'x', query: combo, sourceType: 'discovery' }))
            .filter(r => meetsEngagementThreshold(r, thresholds))
          );
        }
        await new Promise(r => setTimeout(r, 800));
      }

      // HN keyword search for this combo
      try {
        const encoded = encodeURIComponent(combo);
        const hnThreshold = thresholds.hn?.points || 100;
        const url = `https://hn.algolia.com/api/v1/search?query=${encoded}&tags=story&numericFilters=points%3E${hnThreshold}&hitsPerPage=5`;
        const resp = await fetch(url, { signal: AbortSignal.timeout(10000) });
        if (resp.ok) {
          const data = await resp.json();
          for (const hit of (data.hits || [])) {
            const storyUrl = hit.url || `https://news.ycombinator.com/item?id=${hit.objectID}`;
            discoveryResults.push({
              title: hit.title || '', content: hit.title,
              text: hit.title, author: hit.author || 'unknown',
              url: storyUrl, likes: hit.points || 0, retweets: 0,
              source: 'hackernews', query: combo, sourceType: 'discovery',
            });
          }
        }
      } catch (e) { console.error(`  HN combo error for "${combo}":`, e.message); }

      await new Promise(r => setTimeout(r, 500));
    }

    // Reddit keyword search for combos (search across relevant subreddits)
    for (const combo of combos.slice(0, 5)) { // limit to avoid rate limiting
      for (const sub of subreddits.slice(0, 3)) {
        try {
          const resp = await fetch(`https://www.reddit.com/r/${sub}/search.json?q=${encodeURIComponent(combo)}&sort=relevance&t=week&limit=5&raw_json=1&restrict_sr=on`, {
            headers: { 'User-Agent': 'ContentEngine/1.0 (research)', 'Accept': 'application/json' },
            signal: AbortSignal.timeout(15000),
          });
          if (resp.ok) {
            const data = await resp.json();
            const posts = (data.data?.children || [])
              .filter(p => meetsEngagementThreshold({ likes: p.data.score, source: 'reddit' }, thresholds))
              .map(p => ({
                title: p.data.title, content: p.data.selftext || p.data.title,
                text: p.data.selftext || p.data.title,
                author: `u/${p.data.author}`, url: `https://reddit.com${p.data.permalink}`,
                likes: p.data.score, retweets: 0, source: 'reddit',
                query: combo, sourceType: 'discovery',
              }));
            discoveryResults.push(...posts);
          }
        } catch {}
        await new Promise(r => setTimeout(r, 1000));
      }
    }
  }

  // Deduplicate discovery results by URL
  const seenUrls = new Set(trustedResults.map(r => r.url).filter(Boolean));
  const dedupedDiscovery = [];
  for (const r of discoveryResults) {
    if (r.url && seenUrls.has(r.url)) continue;
    if (r.url) seenUrls.add(r.url);
    dedupedDiscovery.push(r);
  }

  const allResults = [...trustedResults, ...dedupedDiscovery];
  console.log(`  Total raw results: ${allResults.length} (${trustedResults.length} trusted, ${dedupedDiscovery.length} discovery)`);
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
Source Type: ${item.sourceType || 'unknown'}
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

async function runDiscovery() {
  // No longer require X auth — we have HN, Reddit, RSS as fallbacks
  const rawResults = await runAutomatedSearch();
  if (rawResults.length === 0) {
    return { success: true, items: [], message: 'No results found from any source' };
  }

  const analysis = await analyzeContent(rawResults);
  
  const discoveries = await loadDiscoveries();
  const newItems = analysis
    .filter(a => !a.error)
    .map((a, i) => ({
      id: `d-${Date.now()}-${i}`,
      ...a,
      raw: rawResults[i] || null,
      sourceType: rawResults[i]?.sourceType || 'unknown',
      platform: rawResults[i]?.source || 'unknown',
      discoveredAt: new Date().toISOString(),
      status: 'new'
    }));

  discoveries.items.unshift(...newItems);
  discoveries.lastSearch = new Date().toISOString();
  
  if (discoveries.items.length > 100) {
    discoveries.items = discoveries.items.slice(0, 100);
  }
  
  await saveDiscoveries(discoveries);
  
  return { success: true, items: newItems, total: newItems.length };
}

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
      sourceType: items[i]?.sourceType || 'manual',
      platform: items[i]?.source || 'manual',
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
  if (filter.sourceType) {
    items = items.filter(i => i.sourceType === filter.sourceType);
  }

  return {
    items,
    total: items.length,
    lastSearch: discoveries.lastSearch
  };
}

async function updateDiscovery(id, updates) {
  const discoveries = await loadDiscoveries();
  const item = discoveries.items.find(i => i.id === id);
  if (!item) return null;

  Object.assign(item, updates, { updatedAt: new Date().toISOString() });
  await saveDiscoveries(discoveries);
  return item;
}

async function importToTopicBank(id) {
  const discoveries = await loadDiscoveries();
  const item = discoveries.items.find(i => i.id === id);
  if (!item) return null;

  const topic = {
    id: Date.now().toString(36),
    idea: item.suggestedTopic || item.coreIdea,
    source: 'discovery',
    notes: `Repurpose angle: ${item.repurposeAngle || 'N/A'}\nHook: ${item.suggestedHook || 'N/A'}\nOriginal: ${item.originalTitle || 'N/A'}`,
    discoveryId: id,
    status: 'raw',
    createdAt: new Date().toISOString()
  };

  const topicsFile = path.join(DATA_DIR, 'topics.json');
  let bank;
  try {
    bank = JSON.parse(await fs.readFile(topicsFile, 'utf-8'));
  } catch {
    bank = { topics: [], generated: [] };
  }
  bank.topics.push(topic);
  await fs.writeFile(topicsFile, JSON.stringify(bank, null, 2));

  item.status = 'imported';
  item.importedAt = new Date().toISOString();
  item.topicId = topic.id;
  await saveDiscoveries(discoveries);

  return { topic, discovery: item };
}

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

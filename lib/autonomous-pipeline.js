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

const VALID_TAGS = ['multi-agent', 'claude-code', 'agentic', 'models', 'tools', 'business', 'tutorials', 'research', 'latam', 'contrarian', 'builder-methodology'];
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

// Format publishedAt into compact relative age: "2h", "1d", "2d"
function formatAge(dateStr) {
  try {
    const ms = Date.now() - new Date(dateStr).getTime();
    if (ms < 0) return '0h';
    const hours = Math.floor(ms / 3600000);
    if (hours < 24) return `${Math.max(1, hours)}h`;
    const days = Math.floor(hours / 24);
    return `${days}d`;
  } catch { return null; }
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

  // --- TIER 1.5: Content Creators (viral AI content for repurposing) ---
  const creatorHandles = new Set((config.contentCreators || []).map(h => h.toLowerCase()));
  for (const handle of (config.contentCreators || [])) {
    const tweets = await searchX(`from:${handle}`, 10);
    results.push(...tweets.map(t => ({ ...t, tier: 'creator' })));
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

  // --- TIER 2.5: Content-specific queries (viral format patterns) ---
  for (const query of (config.contentQueries || [])) {
    const tweets = await searchX(query, 15);
    const filtered = tweets.filter(t => {
      const authorHandle = (t.author || '').replace('@', '').toLowerCase();
      if (trustedHandles.has(authorHandle) || creatorHandles.has(authorHandle)) return true;
      if ((t.likes || 0) < 200) return false; // higher bar for content queries
      const text = (t.content || t.title || '').replace(/https?:\/\/\S+/g, '').trim();
      if (text.length < 80) return false; // need substance for repurposing
      return true;
    });
    results.push(...filtered.map(t => ({
      ...t,
      tier: creatorHandles.has((t.author || '').replace('@', '').toLowerCase()) ? 'creator' :
            trustedHandles.has((t.author || '').replace('@', '').toLowerCase()) ? 'trusted' : 'content-broad'
    })));
    await new Promise(r => setTimeout(r, 800));
  }

  // HN
  console.log('  Fetching HN...');
  results.push(...await fetchHN(20));

  // RSS
  for (const feed of (config.rssFeeds || [])) {
    const items = await fetchRSS(feed.url, feed.name);
    const tier = feed.tier || 'rss';
    const weight = feed.signalWeight || 1.0;
    results.push(...items.map(i => ({ ...i, tier, signalWeight: weight })));
    await new Promise(r => setTimeout(r, 300));
  }

  // Reddit
  for (const sub of (config.subreddits || [])) {
    const items = await searchReddit(sub);
    results.push(...items);
    await new Promise(r => setTimeout(r, 1000));
  }

  // Apply braveSourceOverrides — tag items from known enterprise/LATAM domains
  const overrides = config.braveSourceOverrides || {};
  for (const item of results) {
    if (!item.tier || item.tier === 'broad') {
      for (const [domain, meta] of Object.entries(overrides)) {
        if (item.url && item.url.includes(domain)) {
          item.tier = meta.tier || 'enterprise';
          item.signalWeight = meta.signalWeight || 1.0;
          item.sourceName = meta.name || item.sourceName;
          break;
        }
      }
    }
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

  // Cap items to reduce memory/API pressure in constrained environments
  const MAX_ITEMS = 150;
  if (deduped.length > MAX_ITEMS) {
    // Prioritize: trusted sources first, then by engagement
    deduped.sort((a, b) => {
      const tierOrder = { trusted: 0, creator: 1, unknown: 2 };
      const ta = tierOrder[a.tier] ?? 2, tb = tierOrder[b.tier] ?? 2;
      if (ta !== tb) return ta - tb;
      return (b.likes || 0) - (a.likes || 0);
    });
    deduped.length = MAX_ITEMS;
    console.log(`  Capped to ${MAX_ITEMS} items (prioritized trusted + high engagement)`);
  }

  const BATCH_SIZE = 30;
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
  "title": "clean title that accurately reflects the AUTHOR'S actual point — do NOT editorialize or reframe their message",
  "insight": "One-line take: WHO should care, WHY it matters beyond the obvious, WHAT to do with this info (English, max 150 chars)",
  "relevance": 7,
  "contentScore": 8,
  "contentAngle": "How-to: Set up Claude Code background agents for automated research",
  "tags": ["multi-agent", "claude-code"],
  "category": "tools|models|research|business|tutorials|opinion"
}

## FIELDS:
**relevance** (1-10): How newsworthy/important is this? Powers "What happened?" view. Only keep 6+.
**contentScore** (1-10): How teachable/actionable is this content INTRINSICALLY? Score based on the content itself:
- 9-10: Step-by-step guide, tutorial, how-to thread, detailed teardown with reproducible steps
- 7-8: Framework, comparison, use case with enough detail to learn from, workflow explanation
- 5-6: Interesting insight or announcement but not directly actionable
- 3-4: News/opinion with no actionable takeaway
- 1-2: Pure announcement, vague hype, or meta-commentary
Key question: Does this content TEACH something someone could reproduce or apply?
**contentAngle** (string, ONLY if contentScore >= 7): A suggested content angle. Format: "[Type]: [Specific angle]"
Types: How-to | Comparison | Use case | Step-by-step | Framework | Teardown | Deep dive
One X post with high contentScore may suggest MULTIPLE angles separated by " | " if the content is rich enough to unbundle into several pieces.
If contentScore < 7, omit contentAngle entirely.

## TAGS:
Tags MUST be from: multi-agent, claude-code, agentic, models, tools, business, tutorials, research, latam, contrarian, builder-methodology
Use "contrarian" tag when the take challenges mainstream AI hype or pushes back on popular narratives — these are HIGH VALUE for business decision-makers who need the full picture.
Use "builder-methodology" tag for content about HOW real builders work: specs-as-code, agent orchestration patterns, workflow designs, shipping practices, non-tech founders building with AI, real startup builders sharing their actual process. This is HIGHEST VALUE content — score +1 relevance boost.
Be selective. No fluff. Think: would a builder-CEO care about this?`;

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
            const item = {
              id: `item-${Date.now()}-${allCurated.length}`,
              title: a.title || raw.title,
              source: raw.source === 'hackernews' ? 'hackernews' : raw.source,
              sourceName: raw.author || raw.sourceName || raw.source,
              url: raw.url,
              insight: (a.insight || '').slice(0, 200),
              relevance: Math.min(10, Math.max(1, a.relevance || 5)),
              contentScore: Math.min(10, Math.max(1, a.contentScore || 3)),
              tags: (a.tags || []).filter(t => VALID_TAGS.includes(t)),
              category: VALID_CATEGORIES.includes(a.category) ? a.category : 'tools',
              engagement: { likes: raw.likes || 0, comments: raw.comments || 0, retweets: raw.retweets || 0, views: raw.views || 0 },
              hot: (raw.likes || 0) >= 10000,
              publishedAt: raw.publishedAt || null,
              age: raw.publishedAt ? formatAge(raw.publishedAt) : null,
            };
            // Only include contentAngle for high-teachability items
            if (a.contentAngle && (a.contentScore || 0) >= 7) {
              item.contentAngle = a.contentAngle;
            }
            allCurated.push(item);
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

2. **dataPoints**: Exactly 3-4 key stats or concrete data points from the items. Each has "stat" and "context".
CRITICAL: Every stat MUST pass the "headline test" — reading ONLY the stat field tells a complete story. The context adds depth but the stat stands alone.
BAD: {"stat": "233 ghost agents", "context": "Hidden Claude Code agents eating tokens"} — "233 ghost agents" means nothing alone.
GOOD: {"stat": "67% global AI optimism, LATAM leads", "context": "Anthropic's 80K-person study confirms South America as most AI-positive region"}

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

// ============ TRENDS (cross-day intelligence) ============

async function detectTrends(todayItems) {
  // Load last 14 days of data
  const days = [];
  for (let i = 1; i <= 14; i++) {
    const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    try {
      const data = JSON.parse(await fs.readFile(path.join(DAILY_DIR, `${d}.json`), 'utf-8'));
      days.push({ date: d, items: data.items || [] });
    } catch { /* no data for this day */ }
  }

  if (days.length < 2) {
    console.log('  Trends: not enough historical data (need ≥2 days)');
    return { emerging: [], consolidating: [] };
  }

  // Build a summary of titles per day for the LLM
  const today = new Date().toISOString().slice(0, 10);
  const allDays = [{ date: today, items: todayItems }, ...days];
  const daySummaries = allDays.map(d =>
    `[${d.date}] (${d.items.length} items): ${d.items.slice(0, 20).map(i => i.title).join(' | ')}`
  ).join('\n');

  const prompt = `You have ${allDays.length} days of AI news data. Detect topic trends across days.

DATA:
${daySummaries}

Analyze and return JSON with three arrays:

1. **emerging**: Topics that appeared in ≤ 3 days AND across ≥ 2 different source types. New this week.
2. **consolidating**: Topics present in ≥ 5 of the available days, still active today. Confirmed macro trends.
Each entry:
{
  "topic": "Short topic name",
  "firstSeen": "YYYY-MM-DD" (for emerging),
  "mentions": total_count_across_days,
  "days": number_of_days_present,
  "signal": "One sentence: what this pattern MEANS, not just what happened. Be specific and opinionated."
}

Rules:
- Max 3 per category. Quality over quantity.
- Don't list generic topics like "AI news" or "LLMs" — be specific (e.g., "Claude Code auto mode", "supply chain attacks on AI packages", "coding agent reliability").
- Signal field is the most important — make it editorially sharp.
- If a category has nothing meaningful, return empty array.

Return JSON: {"emerging": [...], "consolidating": [...]}`;

  try {
    const result = await generate(prompt, { system: 'Return valid JSON object only. No explanation.', maxTokens: 1500 });
    const match = result.match(/\{[\s\S]*\}/);
    if (match) {
      const parsed = JSON.parse(match[0]);
      return {
        emerging: (parsed.emerging || []).slice(0, 3),
        consolidating: (parsed.consolidating || []).slice(0, 3),
      };
    }
  } catch (e) { console.error('  Trends error:', e.message); }
  return { emerging: [], consolidating: [] };
}

// ============ CONTENT FUEL (second brain — real viral content for LinkedIn repurposing) ============

async function curateContentFuel(rawItems) {
  // Filter to items from content creators + content-broad tier + high-engagement from any tier
  const contentCandidates = rawItems.filter(item => {
    if (item.tier === 'creator' || item.tier === 'content-broad') return true;
    if ((item.likes || 0) >= 500 && item.source === 'x') return true;
    return false;
  });

  if (contentCandidates.length === 0) {
    console.log('  Content Fuel: no candidates found');
    return [];
  }

  // Deduplicate
  const seen = new Set();
  const deduped = contentCandidates.filter(item => {
    const key = item.url || item.title?.toLowerCase().slice(0, 60);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Cap content fuel candidates
  if (deduped.length > 60) {
    deduped.sort((a, b) => (b.likes || 0) - (a.likes || 0));
    deduped.length = 60;
  }
  console.log(`  Content Fuel: analyzing ${deduped.length} candidates...`);

  const BATCH_SIZE = 30;
  const allFuel = [];

  for (let i = 0; i < deduped.length; i += BATCH_SIZE) {
    const batch = deduped.slice(i, i + BATCH_SIZE);

    const prompt = `You are filtering viral AI content from X for a content creator who repurposes English X posts into Spanish LinkedIn posts.

Your ONLY job: find posts that contain ACTIONABLE, REPRODUCIBLE content. The creator needs raw material she can turn into "do this → then this → get this result" LinkedIn posts.

Items:
${batch.map((item, j) => `[${j}] @${(item.author || '').replace('@', '')} | ${item.content?.slice(0, 400) || item.title} | ${item.likes || 0}♥ ${item.retweets || 0}🔁 ${item.views || 0}👁 | ${item.url}`).join('\n\n')}

For each item return JSON. If NOT worth it: {"keep":false}. If keeping:
{
  "keep": true,
  "repurposeScore": 8,
  "format": "step-by-step|tool-demo|how-to|workflow|case-study|listicle-with-steps|teardown",
  "whyKeep": "One sentence: what specific actionable content this contains (English)"
}

## THE ONLY QUESTION: "Does this post contain SPECIFIC STEPS someone can follow to get a result?"

## KEEP (content fuel):
- Step-by-step tutorials with specific tools and actions
- Tool demos showing exactly how to use something
- "I built X with Y" posts with the actual workflow
- Real business use cases with reproducible agent/AI workflows
- Detailed how-tos with specific prompts, commands, or configurations
- Listicles where each item has actionable depth (not just titles)

## REJECT (not content fuel — might belong in intelligence sections instead):
- Inspirational stories without reproducible steps (e.g. "someone used AI to save their dog")
- Philosophical statements or opinions (e.g. "code is 10% of shipping")
- Vague listicle titles without actual substance (e.g. "5 skills that are dying")
- News announcements
- Contrarian takes without a "here's what to do instead" section
- Engagement bait, hype, FOMO posts
- Anything where the value is the INSIGHT, not the HOW-TO

Only keep repurposeScore >= 7. Be extremely ruthless. Max 8 items per batch.

Return JSON array only.`;

    try {
      const result = await generate(prompt, {
        system: 'Return valid JSON array only. No explanation.',
        maxTokens: 2000,
      });

      const jsonMatch = result.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        let analyses;
        try { analyses = JSON.parse(jsonMatch[0]); }
        catch {
          const cleaned = jsonMatch[0].replace(/,\s*([}\]])/g, '$1');
          try { analyses = JSON.parse(cleaned); } catch { console.error('  Content Fuel JSON parse failed, skipping batch'); continue; }
        }
        for (let j = 0; j < Math.min(batch.length, analyses.length); j++) {
          const a = analyses[j];
          if (a.keep && (a.repurposeScore || 0) >= 7) {
            const raw = batch[j];
            allFuel.push({
              id: `cf-${Date.now()}-${allFuel.length}`,
              author: (raw.author || '').replace('@', ''),
              content: (raw.content || raw.title || '').slice(0, 500),
              url: raw.url || '',
              repurposeScore: Math.min(10, Math.max(1, a.repurposeScore || 7)),
              format: a.format || 'how-to',
              whyKeep: a.whyKeep || '',
              engagement: { likes: raw.likes || 0, retweets: raw.retweets || 0, views: raw.views || 0 },
              publishedAt: raw.publishedAt || null,
              age: raw.publishedAt ? formatAge(raw.publishedAt) : null,
            });
          }
        }
      }
    } catch (e) {
      console.error(`  Content Fuel curation error:`, e.message);
    }
  }

  allFuel.sort((a, b) => b.repurposeScore - a.repurposeScore);
  return allFuel;
}

// ============ ENTERPRISE SIGNALS (separate curation for decision-makers) ============

async function curateEnterpriseSignals(enterpriseItems) {
  if (enterpriseItems.length === 0) {
    console.log('  Enterprise Signals: no items from enterprise/latam sources');
    return [];
  }

  // Deduplicate
  const seen = new Set();
  const deduped = enterpriseItems.filter(item => {
    const key = item.url || item.title?.toLowerCase().slice(0, 60);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  console.log(`  Enterprise Signals: curating ${deduped.length} items...`);

  const BATCH_SIZE = 15;
  const allSignals = [];

  for (let i = 0; i < deduped.length; i += BATCH_SIZE) {
    const batch = deduped.slice(i, i + BATCH_SIZE);
    const today = new Date().toISOString().slice(0, 10);

    const prompt = `You are curating AI intelligence for LATAM decision-makers — CTOs, CIOs, CEOs, and VPs at medium/large companies making AI adoption decisions. Today is ${today}.

These items come from enterprise strategy sources (McKinsey, MIT Sloan, Stratechery, Benedict Evans) and LATAM market intelligence (Bloomberg Línea, Rest of World).

Items:
${batch.map((item, j) => `[${j}] ${(item.sourceName || item.source || '').toUpperCase()} | ${item.title} | ${item.url} | ${item.publishedAt || 'no date'}`).join('\n')}

For each item, decide if it's relevant to a LATAM CTO/CIO making AI strategy decisions. If NOT relevant: {"keep":false}. If keeping:
{
  "keep": true,
  "title": "clean, specific title",
  "strategicRelevance": 8,
  "category": "strategy|adoption|market|vendor|regulation|infrastructure",
  "insight": "One sentence: what a LATAM CTO should know and why it matters for their AI decisions (max 200 chars)",
  "tags": ["enterprise-ai", "latam"]
}

## SCORING strategicRelevance (1-10):
- 9-10: Directly impacts AI budget/adoption decisions at LATAM enterprises (vendor moves, regulation, proven ROI data)
- 7-8: Strategic framework or analysis that changes how a CTO thinks about AI adoption
- 5-6: Interesting industry signal but not directly actionable for LATAM enterprises
- 3-4: Generic tech news with no enterprise decision angle

Only keep items with strategicRelevance >= 6. Be selective — these go to busy executives.

## CATEGORIES:
- strategy: AI adoption frameworks, build-vs-buy, organizational change
- adoption: Real deployment results, ROI data, implementation lessons
- market: LATAM-specific market moves, deals, ecosystem changes
- vendor: Major AI vendor announcements that affect enterprise buyers
- regulation: AI policy, compliance, governance affecting LATAM
- infrastructure: Cloud, compute, architecture decisions for AI at scale

Return JSON array only.`;

    try {
      const result = await generate(prompt, {
        system: 'Return valid JSON array only. No explanation.',
        maxTokens: 2000,
      });

      const jsonMatch = result.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        let analyses;
        try { analyses = JSON.parse(jsonMatch[0]); }
        catch {
          const cleaned = jsonMatch[0].replace(/,\s*([}\]])/g, '$1');
          try { analyses = JSON.parse(cleaned); } catch { console.error('  Enterprise JSON parse failed, skipping batch'); continue; }
        }
        for (let j = 0; j < Math.min(batch.length, analyses.length); j++) {
          const a = analyses[j];
          if (a.keep && (a.strategicRelevance || 0) >= 6) {
            const raw = batch[j];
            allSignals.push({
              id: `es-${Date.now()}-${allSignals.length}`,
              title: a.title || raw.title,
              source: raw.source,
              sourceName: raw.sourceName || raw.author || raw.source,
              url: raw.url,
              strategicRelevance: Math.min(10, Math.max(1, a.strategicRelevance || 6)),
              category: a.category || 'strategy',
              insight: (a.insight || '').slice(0, 200),
              tags: a.tags || [],
              signalWeight: raw.signalWeight || 1.0,
              publishedAt: raw.publishedAt || null,
              age: raw.publishedAt ? formatAge(raw.publishedAt) : null,
            });
          }
        }
      }
    } catch (e) {
      console.error(`  Enterprise curation error:`, e.message);
    }
  }

  allSignals.sort((a, b) => (b.strategicRelevance * (b.signalWeight || 1)) - (a.strategicRelevance * (a.signalWeight || 1)));
  return allSignals;
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

    // Content Fuel (second brain — repurposable content for LinkedIn)
    pipelineStatus.message = `Analyzing content fuel for repurposing...`;
    pipelineStatus.stage = 'content-fuel';
    console.log('⚡ Analyzing content fuel...');
    const contentFuel = await curateContentFuel(raw);
    console.log(`⚡ Content fuel: ${contentFuel.length} repurposable items found`);

    // Trends (cross-day intelligence)
    pipelineStatus.message = `Detecting trends across days...`;
    pipelineStatus.stage = 'trends';
    console.log('⚡ Detecting trends...');
    const trends = await detectTrends(items);

    // Build daily data (save BEFORE enterprise signals to survive OOM)
    const sourceBreakdown = raw.reduce((acc, r) => { acc[r.source] = (acc[r.source] || 0) + 1; return acc; }, {});
    const tierBreakdown = raw.reduce((acc, r) => { acc[r.tier || 'unknown'] = (acc[r.tier || 'unknown'] || 0) + 1; return acc; }, {});
    const dailyData = {
      date: today,
      generatedAt: new Date().toISOString(),
      bigPicture,
      dataPoints,
      tldr,
      items,
      contentFuel,
      enterpriseSignals: [],
      trends,
      stats: { rawFetched: rawCount, kept: items.length, contentFuelCount: contentFuel.length, enterpriseSignalCount: 0, sourceBreakdown, tierBreakdown },
    };

    // Save checkpoint
    await fs.mkdir(DAILY_DIR, { recursive: true });
    await fs.writeFile(path.join(DAILY_DIR, `${today}.json`), JSON.stringify(dailyData, null, 2));
    await fs.writeFile(path.join(DATA_DIR, 'latest.json'), JSON.stringify(dailyData, null, 2));
    console.log(`⚡ Checkpoint saved: ${items.length} items`);

    // Free raw items from memory before enterprise curation
    const enterpriseRaw = raw.filter(r => r.tier === 'enterprise' || r.tier === 'latam');
    raw.length = 0; // release memory

    // Enterprise Signals (separate curation for decision-makers)
    pipelineStatus.message = `Curating enterprise signals...`;
    pipelineStatus.stage = 'enterprise';
    console.log('⚡ Curating enterprise signals...');
    const enterpriseSignals = await curateEnterpriseSignals(enterpriseRaw);
    console.log(`⚡ Enterprise signals: ${enterpriseSignals.length} items curated`);

    // Update daily data with enterprise signals and re-save
    dailyData.enterpriseSignals = enterpriseSignals;
    dailyData.stats.enterpriseSignalCount = enterpriseSignals.length;
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

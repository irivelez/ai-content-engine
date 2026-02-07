/**
 * Discovery Engine
 * Finds viral AI content and extracts repurposable ideas for LATAM audience
 * 
 * Works in two modes:
 * 1. Automated: Uses bird CLI to search X (requires auth)
 * 2. Manual: Accepts URLs/text/tweets fed via API
 */

const { execSync } = require('child_process');
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

// ============ BIRD CLI SEARCH ============

function getBirdAuthFlags() {
  const token = process.env.BIRD_AUTH_TOKEN;
  const ct0 = process.env.BIRD_CT0;
  if (token && ct0) return `--auth-token "${token}" --ct0 "${ct0}"`;
  return '';
}

function isBirdAvailable() {
  try {
    const flags = getBirdAuthFlags();
    const cmd = flags ? `bird check ${flags} 2>&1` : 'bird check 2>&1';
    const output = execSync(cmd, { timeout: 15000, encoding: 'utf-8' });
    return output.includes('Ready to tweet');
  } catch (e) {
    const output = e.stdout?.toString() || e.stderr?.toString() || '';
    return output.includes('Ready to tweet');
  }
}

async function searchX(query, count = 10) {
  try {
    const flags = getBirdAuthFlags();
    const result = execSync(
      `bird search "${query.replace(/"/g, '\\"')}" -n ${count} --json --plain ${flags} 2>/dev/null`,
      { timeout: 30000, encoding: 'utf-8' }
    );
    return JSON.parse(result);
  } catch (e) {
    console.error(`bird search failed for "${query}":`, e.message);
    return [];
  }
}

async function runAutomatedSearch() {
  const config = await loadConfig();
  const allResults = [];

  // Search by tracked accounts
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

    // Fetch recent tweets from tracked accounts
    for (const account of allAccounts) {
      try {
        const results = await searchX(`from:${account.handle}`, account.critical ? 20 : 10);
        if (Array.isArray(results)) {
          allResults.push(...results.map(r => ({
            source: 'x',
            query: `from:${account.handle}`,
            group: account.group,
            critical: account.critical,
            ...r
          })));
        }
        await new Promise(r => setTimeout(r, 800));
      } catch (e) {
        console.error(`Failed to fetch @${account.handle}:`, e.message);
      }
    }
  }

  // Search by topic queries
  for (const query of (config.queries || [])) {
    const results = await searchX(query, 10);
    if (Array.isArray(results)) {
      allResults.push(...results.map(r => ({
        source: 'x',
        query,
        ...r
      })));
    }
    await new Promise(r => setTimeout(r, 1000));
  }

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
  const birdOk = isBirdAvailable();
  
  if (!birdOk) {
    return { 
      success: false, 
      error: 'bird_no_auth',
      message: 'Bird CLI not authenticated. Use manual feed or log into x.com in your browser.'
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
  isBirdAvailable,
  loadConfig
};

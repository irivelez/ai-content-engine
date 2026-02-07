/**
 * OpenClaw Gateway Client
 * Routes generation requests through OpenClaw (uses existing auth)
 */

const GATEWAY_URL = process.env.OPENCLAW_GATEWAY_URL || 'http://localhost:18789';
const GATEWAY_TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN;

async function generate(prompt, options = {}) {
  if (!GATEWAY_TOKEN) {
    throw new Error('OPENCLAW_GATEWAY_TOKEN not set in .env');
  }

  const response = await fetch(`${GATEWAY_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${GATEWAY_TOKEN}`
    },
    body: JSON.stringify({
      model: options.model || 'claude-sonnet-4-20250514',
      max_tokens: options.maxTokens || 4096,
      messages: [
        { role: 'system', content: options.system || '' },
        { role: 'user', content: prompt }
      ]
    })
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Gateway error: ${error}`);
  }

  const data = await response.json();
  return data.choices[0].message.content;
}

module.exports = { generate };

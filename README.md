# Content Engine ⚡

A local platform for generating publication-ready how-to guides for Beehiiv newsletter.

## Quick Start

```bash
cd content-engine
npm install
npm start
```

Then open: **http://localhost:3847**

## Modes

### 🚀 Autonomous Mode
Enter a topic → Get a complete, publication-ready guide.

The system uses your voice profile to generate content that sounds like you:
- Spanish (LATAM) with natural English tech terms
- Direct, conversational, actionable
- Structured for newsletter format

### ✏️ Draft Mode
Paste your rough draft → Get a polished, publication-ready version.

The system:
- Strengthens hooks
- Adds actionable elements
- Improves structure
- Maintains your voice

### 📚 Topic Bank
Store and manage topic ideas:
1. Add raw ideas
2. Expand into full briefs (title, hook, sections, exercises)
3. Generate guides directly from expanded topics

### 📁 Output
- **Ready**: Publication-ready guides
- **Review**: Drafts that need your review

All output is saved to `output/ready/` and `output/review/`.

## Structure

```
content-engine/
├── server.js          # API server
├── public/            # Web interface
├── lib/
│   └── prompts.js     # System prompts
├── data/
│   └── topics.json    # Topic bank storage
├── output/
│   ├── ready/         # Publication-ready
│   └── review/        # Needs review
└── input/             # Optional: batch input
```

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/topics` | Get all topics |
| POST | `/api/topics` | Add new topic |
| POST | `/api/topics/:id/expand` | Expand topic to brief |
| DELETE | `/api/topics/:id` | Delete topic |
| POST | `/api/generate/autonomous` | Generate complete guide |
| POST | `/api/generate/draft` | Polish a draft |
| GET | `/api/output` | List output files |
| GET | `/api/output/:folder/:file` | Get specific file |

## Voice Profile

The engine reads your voice profile from `../irina-voice-profile.md`.

Edit that file to adjust:
- Tone and style
- Hook formulas
- Content patterns
- Topics that resonate

## Environment

Uses your existing `ANTHROPIC_API_KEY` environment variable.

---

Built with ⚡ by Ari

# resume-scorer-mcp

> MCP server that scores a structured resume against the **HackerRank hiring-agent** rubric. Get a numeric score, evidence per category, bonus points, deductions, and concrete improvement areas — all without an LLM call.

[![MIT License](https://img.shields.io/badge/license-MIT-yellow.svg)](LICENSE)
[![Node ≥ 18](https://img.shields.io/badge/node-%E2%89%A518-green.svg)](https://nodejs.org)
[![MCP](https://img.shields.io/badge/MCP-Model%20Context%20Protocol-blueviolet)](https://modelcontextprotocol.io)

## What it scores

Same four categories as HackerRank's open-source [interviewstreet/hiring-agent](https://github.com/interviewstreet/hiring-agent):

| Category | Max |
|---|---|
| Open Source contributions | 35 |
| Self Projects | 30 |
| Production Experience | 25 |
| Technical Skills | 10 |
| Bonus (portfolio, LinkedIn, etc.) | +20 |
| Deductions (missing links, tutorials) | up to −15 |
| **Total** | **120** |

## Why use it

- **Candidates** — self-check before applying. Iterate until score crosses your target.
- **Recruiters** — bulk-screen JSON Resumes without sending content to a paid LLM.
- **AI agents** — a deterministic scoring primitive in agent workflows.
- **Privacy** — no resume content leaves your machine.

## Install

```bash
npm install -g resume-scorer-mcp
```

Or run directly via `npx`:

```bash
npx resume-scorer-mcp
```

## Use with Claude Desktop

Add to `claude_desktop_config.json`:
- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "resume-scorer": {
      "command": "npx",
      "args": ["-y", "resume-scorer-mcp"]
    }
  }
}
```

Restart Claude Desktop. Ask:

> "Score this resume against the hiring rubric" + paste a JSON Resume

## Tools

### `score_resume`

Score a structured resume in [JSON Resume](https://jsonresume.org/schema/) format.

```jsonc
{
  "resume_json": {
    "basics": {
      "name": "Khushal Bhandari",
      "url": "https://www.khushalbhandari.everyai.in",
      "profiles": [
        { "network": "GitHub",   "url": "https://github.com/KhushalB25" },
        { "network": "LinkedIn", "url": "https://linkedin.com/in/khushal-bhandari" }
      ]
    },
    "work": [
      { "name": "Phoenix Rising AI", "startDate": "2025-03", "endDate": "2026-04",
        "highlights": ["Built conversational LLM chat over OpenAI/Claude/Gemini …"] }
    ],
    "projects": [
      { "name": "QuickSkill", "url": "https://www.everyai.in",
        "description": "AI-powered cognitive training using OpenAI/Claude…",
        "technologies": ["Next.js", "Firebase", "OpenAI"] }
    ],
    "skills": [{ "name": "Languages", "keywords": ["Python", "TypeScript", "React"] }]
  }
}
```

Also accepts `resume_json_path` (absolute path) instead of inline data.

### `score_resume_from_freeform`

Best-effort scoring of plain text. Less accurate. Use `score_resume` when possible.

## Example response

```json
{
  "scores": {
    "open_source":     { "score": 6,  "max": 35, "evidence": "GitHub URL present but no external contributions detected …" },
    "self_projects":   { "score": 22, "max": 30, "evidence": "Per-project breakdown: QuickSkill: 3 complexity signals, link present → 8/10 …" },
    "production":      { "score": 19, "max": 25, "evidence": "~3.1 years total production tenure across 3 role(s) (LLM production weighting +2)." },
    "technical_skills":{ "score": 9,  "max": 10, "evidence": "18 distinct technologies/keywords detected." }
  },
  "bonus_points": { "total": 3, "breakdown": "+2 portfolio URL · +1 LinkedIn profile" },
  "deductions":   { "total": 2, "reasons":   "-2 for 1 project(s) without links: Stock Monitoring" },
  "key_strengths": [
    "Solid production tenure with multi-year track record.",
    "Personal projects show technical depth and shipped artefacts.",
    "Broad polyglot stack signal."
  ],
  "areas_for_improvement": [
    "Land 2-3 merged pull requests to popular open-source repos to break out of the ≤10 self-only cap.",
    "Add live demo or repo URL to every project to remove missing-link deductions."
  ],
  "total": 59,
  "max_total": 100
}
```

## Local development

```bash
git clone https://github.com/KhushalB25/resume-scorer-mcp.git
cd resume-scorer-mcp
npm install
npm run build
npm start
```

Test with [@modelcontextprotocol/inspector](https://github.com/modelcontextprotocol/inspector):

```bash
npx @modelcontextprotocol/inspector node dist/index.js
```

## Rubric attribution

The scoring rubric is adapted from [interviewstreet/hiring-agent](https://github.com/interviewstreet/hiring-agent) (MIT, © HackerRank). This server reimplements the deterministic portions in TypeScript without requiring an LLM backend.

## Author

[Khushal Bhandari](https://www.khushalbhandari.everyai.in) · [GitHub](https://github.com/KhushalB25)

## License

MIT

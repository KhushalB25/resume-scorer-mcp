import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// Resume scorer — deterministic 4-category rubric for modern engineering
// resumes (open source, self projects, production tenure, technical breadth).
// No LLM required. Returns category scores, evidence, bonus points, deductions,
// strengths, and concrete improvement areas. Designed for Claude Desktop and
// other MCP-capable agents.
// ---------------------------------------------------------------------------

const ResumeBasicsSchema = z.object({
  name: z.string().optional(),
  email: z.string().optional(),
  url: z.string().optional(),
  summary: z.string().optional(),
  profiles: z
    .array(
      z.object({
        network: z.string().optional(),
        url: z.string().optional(),
      })
    )
    .optional(),
});

const ResumeProjectSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  url: z.string().nullable().optional(),
  technologies: z.array(z.string()).optional(),
});

const ResumeWorkSchema = z.object({
  name: z.string(),
  position: z.string().optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  highlights: z.array(z.string()).optional(),
});

const ResumeJsonSchema = z.object({
  basics: ResumeBasicsSchema.optional(),
  work: z.array(ResumeWorkSchema).optional(),
  projects: z.array(ResumeProjectSchema).optional(),
  skills: z
    .array(z.object({ name: z.string().optional(), keywords: z.array(z.string()).optional() }))
    .optional(),
  certificates: z.array(z.object({ name: z.string().optional() })).optional(),
});

type ResumeJson = z.infer<typeof ResumeJsonSchema>;

type CategoryScore = { score: number; max: number; evidence: string };
type Scores = {
  open_source: CategoryScore;
  self_projects: CategoryScore;
  production: CategoryScore;
  technical_skills: CategoryScore;
};
type Evaluation = {
  scores: Scores;
  bonus_points: { total: number; breakdown: string };
  deductions: { total: number; reasons: string };
  key_strengths: string[];
  areas_for_improvement: string[];
  total: number;
  max_total: number;
};

const TUTORIAL_KEYWORDS = ["todo", "calculator", "weather app", "memory game", "note app", "recipe", "tic tac toe", "snake game"];
const COMPLEX_KEYWORDS = ["encrypt", "vault", "real-time", "websocket", "microservice", "machine learning", "llm", "openai", "claude", "gemini", "auth", "firebase", "next.js", "graphql", "ml", "fallback"];

function scoreSelfProjects(projects: NonNullable<ResumeJson["projects"]>): CategoryScore {
  if (projects.length === 0) return { score: 0, max: 30, evidence: "No projects listed." };
  const evidence: string[] = [];
  let raw = 0;
  for (const p of projects) {
    const desc = (p.description ?? "").toLowerCase();
    const isTutorial = TUTORIAL_KEYWORDS.some((k) => desc.includes(k));
    const complexHits = COMPLEX_KEYWORDS.filter((k) => desc.includes(k)).length;
    const hasLink = !!p.url;
    let pScore = 3;
    if (complexHits >= 2) pScore = 8;
    if (complexHits >= 4) pScore = 10;
    if (isTutorial) pScore = Math.min(pScore, 3);
    if (!hasLink) pScore = Math.round(pScore * 0.6);
    raw += pScore;
    evidence.push(`${p.name}: ${complexHits} complexity signals${hasLink ? ", link present" : ", NO LINK"}${isTutorial ? ", tutorial-flavoured" : ""} -> ${pScore}/10`);
  }
  const score = Math.min(30, raw);
  return { score, max: 30, evidence: `Per-project breakdown: ${evidence.join(" | ")}. Total: ${score}/30.` };
}

function scoreOpenSource(basics: ResumeJson["basics"], projects: NonNullable<ResumeJson["projects"]>): CategoryScore {
  const githubLink = basics?.profiles?.find((p) => (p.network ?? "").toLowerCase().includes("github"));
  if (!githubLink) return { score: 0, max: 35, evidence: "No GitHub URL in resume header. Cannot assess open source contribution." };
  const externalSignals = projects.filter((p) => {
    const d = (p.description ?? "").toLowerCase();
    return d.includes("contributed to") || d.includes("pull request") || d.includes("merged pr") || d.includes("gsoc") || d.includes("google summer of code");
  });
  if (externalSignals.length === 0) {
    return { score: 6, max: 35, evidence: `GitHub URL present at ${githubLink.url}, but no external open source contributions detected in resume. Without external PRs the open-source category caps at <=10. Light positive for having repos at all.` };
  }
  const score = Math.min(35, 12 + externalSignals.length * 4);
  return { score, max: 35, evidence: `Detected ${externalSignals.length} external contribution signal(s) in projects: ${externalSignals.map((p) => p.name).join(", ")}.` };
}

function parseYM(s: string): Date {
  const [y, m] = s.split("-").map(Number);
  return new Date(y, (m ?? 1) - 1, 1);
}

function scoreProduction(work: NonNullable<ResumeJson["work"]>): CategoryScore {
  if (work.length === 0) return { score: 0, max: 25, evidence: "No work history listed." };
  const totalMonths = work.reduce((acc, w) => {
    if (!w.startDate) return acc;
    const start = parseYM(w.startDate);
    const end = w.endDate ? parseYM(w.endDate) : new Date();
    const months = (end.getFullYear() - start.getFullYear()) * 12 + end.getMonth() - start.getMonth();
    return acc + Math.max(0, months);
  }, 0);
  const years = totalMonths / 12;
  let score = 0;
  if (years >= 5) score = 23;
  else if (years >= 3) score = 19;
  else if (years >= 1.5) score = 14;
  else if (years >= 0.5) score = 8;
  else score = 4;
  const aiBoost = work.some((w) => (w.highlights ?? []).some((h) => /openai|claude|gemini|llm/i.test(h)));
  if (aiBoost) score = Math.min(25, score + 2);
  return { score, max: 25, evidence: `~${years.toFixed(1)} years total production tenure across ${work.length} role(s)${aiBoost ? " (LLM production weighting +2)" : ""}.` };
}

function scoreTechnicalSkills(resume: ResumeJson): CategoryScore {
  const techs = new Set<string>();
  (resume.skills ?? []).forEach((s) => (s.keywords ?? []).forEach((k) => techs.add(k.toLowerCase())));
  (resume.projects ?? []).forEach((p) => (p.technologies ?? []).forEach((t) => techs.add(t.toLowerCase())));
  const breadth = techs.size;
  let score = 4;
  if (breadth >= 8) score = 6;
  if (breadth >= 14) score = 8;
  if (breadth >= 20) score = 9;
  if (breadth >= 25) score = 10;
  return { score, max: 10, evidence: `${breadth} distinct technologies/keywords detected across skills + projects.` };
}

function bonusPoints(basics: ResumeJson["basics"]): { total: number; breakdown: string } {
  let total = 0;
  const reasons: string[] = [];
  if (basics?.url) { total += 2; reasons.push(`+2 portfolio URL (${basics.url})`); }
  if (basics?.profiles?.some((p) => (p.network ?? "").toLowerCase().includes("linkedin"))) { total += 1; reasons.push("+1 LinkedIn profile"); }
  return { total: Math.min(20, total), breakdown: reasons.join(" - ") || "None detected." };
}

function deductions(projects: NonNullable<ResumeJson["projects"]>): { total: number; reasons: string } {
  let total = 0;
  const reasons: string[] = [];
  const noLink = projects.filter((p) => !p.url);
  if (noLink.length > 0) {
    const d = Math.min(15, noLink.length * 2);
    total += d;
    reasons.push(`-${d} for ${noLink.length} project(s) without links: ${noLink.map((p) => p.name).join(", ")}`);
  }
  return { total, reasons: reasons.join(" - ") || "No deductions." };
}

function buildEvaluation(resume: ResumeJson): Evaluation {
  const projects = resume.projects ?? [];
  const work = resume.work ?? [];
  const scores: Scores = {
    open_source: scoreOpenSource(resume.basics, projects),
    self_projects: scoreSelfProjects(projects),
    production: scoreProduction(work),
    technical_skills: scoreTechnicalSkills(resume),
  };
  const bonus = bonusPoints(resume.basics);
  const ded = deductions(projects);
  const categoryTotal = scores.open_source.score + scores.self_projects.score + scores.production.score + scores.technical_skills.score;
  const total = Math.max(-20, Math.min(120, categoryTotal + bonus.total - ded.total));

  const key_strengths: string[] = [];
  if (scores.production.score >= 15) key_strengths.push("Solid production tenure with multi-year track record.");
  if (scores.self_projects.score >= 20) key_strengths.push("Personal projects show technical depth and shipped artefacts.");
  if (scores.technical_skills.score >= 8) key_strengths.push("Broad polyglot stack signal.");
  if (bonus.total >= 3) key_strengths.push("Portfolio + LinkedIn footprint present.");
  if (key_strengths.length === 0) key_strengths.push("Resume has potential — focus the improvements below.");

  const areas: string[] = [];
  if (scores.open_source.score < 12) areas.push("Land 2-3 merged pull requests to popular open-source repos to break out of the <=10 self-only cap.");
  if (ded.total > 0) areas.push("Add live demo or repo URL to every project to remove missing-link deductions.");
  if (scores.technical_skills.score < 9) areas.push("List more concrete technologies/keywords to demonstrate stack breadth.");
  if (areas.length === 0) areas.push("Maintain shipping pace and write 1-2 technical blog posts to add bonus signal.");

  return { scores, bonus_points: bonus, deductions: ded, key_strengths, areas_for_improvement: areas, total, max_total: 100 };
}

const server = new Server({ name: "resume-scorer-mcp", version: "0.1.0" }, { capabilities: { tools: {} } });

const SCORE_RESUME_TOOL = {
  name: "score_resume",
  description: "Score a structured resume (JSON Resume format) against a deterministic 4-category engineering rubric. Returns category scores (open_source 0-35, self_projects 0-30, production 0-25, technical_skills 0-10), bonus points, deductions, strengths, and improvement areas.",
  inputSchema: {
    type: "object",
    properties: {
      resume_json: { type: "object", description: "Structured resume in JSON Resume format. Required keys: basics, work, projects, skills. See https://jsonresume.org/schema/" },
      resume_json_path: { type: "string", description: "Alternative to resume_json. Absolute path to a .json file on disk." },
    },
  },
} as const;

const SCORE_FROM_TEXT_TOOL = {
  name: "score_resume_from_freeform",
  description: "Score a resume passed as free-form text. Best-effort regex extraction. Less accurate than score_resume.",
  inputSchema: {
    type: "object",
    properties: { text: { type: "string", description: "Full resume text." } },
    required: ["text"],
  },
} as const;

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [SCORE_RESUME_TOOL, SCORE_FROM_TEXT_TOOL] }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;

  if (name === "score_resume") {
    let resumeJson: unknown = (args as { resume_json?: unknown })?.resume_json;
    const path = (args as { resume_json_path?: string })?.resume_json_path;
    if (!resumeJson && path) {
      const abs = resolve(path);
      if (!existsSync(abs)) return { content: [{ type: "text", text: `Error: file not found: ${abs}` }], isError: true };
      resumeJson = JSON.parse(readFileSync(abs, "utf8"));
    }
    if (!resumeJson) return { content: [{ type: "text", text: "Error: provide resume_json or resume_json_path." }], isError: true };
    const parsed = ResumeJsonSchema.safeParse(resumeJson);
    if (!parsed.success) return { content: [{ type: "text", text: `Error: invalid resume JSON: ${parsed.error.message}` }], isError: true };
    return { content: [{ type: "text", text: JSON.stringify(buildEvaluation(parsed.data), null, 2) }] };
  }

  if (name === "score_resume_from_freeform") {
    const text = (args as { text?: string })?.text ?? "";
    const githubMatch = text.match(/github\.com\/([\w-]+)/i);
    const linkedinMatch = text.match(/linkedin\.com\/in\/([\w-]+)/i);
    const portfolioMatch = text.match(/https?:\/\/(?!github|linkedin)[\w.-]+\.[a-z]{2,}/i);
    const techs = Array.from(new Set((text.match(/\b(Python|JavaScript|TypeScript|React|Next\.js|Node\.js|Java|Flutter|Firebase|OpenAI|Claude|Gemini|SQL|NoSQL|Selenium|Splunk|JIRA|Docker|Kubernetes|AWS|GCP|GraphQL)\b/gi) ?? [])));
    const resume: ResumeJson = {
      basics: {
        url: portfolioMatch?.[0],
        profiles: [
          ...(githubMatch ? [{ network: "GitHub", url: `https://github.com/${githubMatch[1]}` }] : []),
          ...(linkedinMatch ? [{ network: "LinkedIn", url: `https://linkedin.com/in/${linkedinMatch[1]}` }] : []),
        ],
      },
      projects: [],
      work: [],
      skills: [{ name: "extracted", keywords: techs }],
    };
    return { content: [{ type: "text", text: "Best-effort freeform extraction. For accurate scoring use the score_resume tool with JSON Resume format.\n\n" + JSON.stringify(buildEvaluation(resume), null, 2) }] };
  }

  return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("[resume-scorer-mcp] running on stdio");

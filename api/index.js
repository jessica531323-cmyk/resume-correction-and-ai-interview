import "dotenv/config";
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import OpenAI from "openai";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");

const app = express();
app.disable("x-powered-by");

app.use(express.json({ limit: "2mb" }));

// Serve static files - different paths for local vs Vercel
if (process.env.VERCEL) {
  // On Vercel, static files are served from the root
  app.use(express.static(projectRoot));
} else {
  app.use(express.static(projectRoot));
}

function getLLMConfig() {
  const apiKey = process.env.LLM_API_KEY || process.env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY || "";
  const baseURL = process.env.LLM_BASE_URL || process.env.DEEPSEEK_BASE_URL || process.env.OPENAI_BASE_URL || "";
  const model = process.env.LLM_MODEL || process.env.DEEPSEEK_MODEL || process.env.OPENAI_MODEL || "gpt-4.1-mini";
  const provider = process.env.LLM_PROVIDER || (baseURL.toLowerCase().includes("deepseek") ? "deepseek" : "openai-compatible");
  return { apiKey, baseURL: baseURL || undefined, model, provider };
}

function requireApiKey(req, res) {
  const cfg = getLLMConfig();
  if (!cfg.apiKey) {
    res.status(501).json({
      error:
        "Server missing API key. Set LLM_API_KEY (or DEEPSEEK_API_KEY / OPENAI_API_KEY) in .env then restart the server.",
    });
    return false;
  }
  return true;
}

const cfg = getLLMConfig();
const openai = new OpenAI({ apiKey: cfg.apiKey, baseURL: cfg.baseURL });

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

app.get("/api/health", (req, res) => {
  const c = getLLMConfig();
  res.json({
    ok: true,
    hasOpenAIKey: Boolean(c.apiKey),
    provider: c.provider,
    model: c.model,
    base_url: c.baseURL || "https://api.openai.com",
  });
});

app.post("/api/resume-diagnosis", async (req, res) => {
  if (!requireApiKey(req, res)) return;

  const jd = (req.body?.jd || "").toString();
  const resume = (req.body?.resume || "").toString();
  const locale = (req.body?.locale || "zh-CN").toString();

  if (jd.trim().length < 20 || resume.trim().length < 50) {
    res.status(400).json({ error: "Please provide jd (>=20 chars) and resume (>=50 chars)." });
    return;
  }

  const model = getLLMConfig().model || "gpt-4.1-mini";

  const system = `You are an expert recruiter + resume editor for China job market.
Return STRICT JSON only. No markdown, no extra keys, no code fences.
Language: ${locale}.

Schema:
{
  "score": number, // 0-100
  "issues": Array<{ "type": "表达"|"结构"|"数据缺失"|"匹配度"|"风险", "severity": "高"|"中"|"低", "title": string, "detail": string, "why_it_matters": string, "how_to_fix": string }>,
  "suggestions": Array<{ "title": string, "example": string, "priority": "P0"|"P1"|"P2" }>,
  "highlights": Array<string>,
  "rewritten_resume": string,
  "export_format": "text"
}

Hard requirements:
- Must be grounded in the given JD + resume. Quote short phrases (<=20 chars) when necessary.
- Avoid generic or empty advice. If JD is vague, infer missing detail by asking the candidate to add specifics, but still produce concrete rewrite templates.
- For projects/internships: extract/produce detailed bullets with context, scope, constraints, decisions, trade-offs, and measurable outcomes.
- Data must follow product/operation logic: define metric, baseline, method, funnel/retention or efficiency logic, impact, and how measured.
- Provide a full rewritten resume in Chinese as PLAIN TEXT (ready to paste) with improved structure and quantified achievements. Use simple formatting with clear section headers and bullet points, NO Markdown syntax like # or **.
- Keep: issues 8-12, suggestions 6-10, highlights 3-6.`;

  const user = `Job Description (JD):
${jd}

Resume:
${resume}`;

  try {
    const completion = await openai.chat.completions.create({
      model,
      temperature: 0.2,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      response_format: { type: "json_object" },
    });

    const content = completion.choices?.[0]?.message?.content || "";
    const json = safeJsonParse(content);
    if (!json) {
      res.status(502).json({ error: "Model returned non-JSON output.", raw: content.slice(0, 800) });
      return;
    }

    const score = Number(json.score);
    json.score = Number.isFinite(score) ? Math.max(0, Math.min(100, Math.round(score))) : 70;

    res.json(json);
  } catch (err) {
    res.status(500).json({
      error: "LLM request failed.",
      detail: err?.message || String(err),
    });
  }
});

app.post("/api/job-recommendations", async (req, res) => {
  if (!requireApiKey(req, res)) return;

  const { persona, resume, jd, locale } = req.body;
  const model = getLLMConfig().model || "gpt-4.1-mini";

  const system = `You are a career advisor for China job market.
Return STRICT JSON only. No markdown, no extra keys.
Language: ${locale || "zh-CN"}.

Schema:
{
  "positions": Array<{
    "title": string,
    "city": string,
    "salary_range": string,
    "match": number,
    "reason": string,
    "must": Array<string>,
    "nice": Array<string>
  }>
}

Rules:
- Recommend 3-5 positions based on resume + persona + JD.
- Each position must have specific match reason.
- Keep recommendations realistic and actionable.`;

  const user = `Persona: ${JSON.stringify(persona)}
Resume: ${resume || ""}
JD: ${jd || ""}`;

  try {
    const completion = await openai.chat.completions.create({
      model,
      temperature: 0.3,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      response_format: { type: "json_object" },
    });

    const content = completion.choices?.[0]?.message?.content || "";
    const json = safeJsonParse(content);
    if (!json || !json.positions) {
      res.status(502).json({ error: "Model returned invalid output.", raw: content.slice(0, 800) });
      return;
    }

    res.json(json);
  } catch (err) {
    res.status(500).json({
      error: "LLM request failed.",
      detail: err?.message || String(err),
    });
  }
});

app.post("/api/gap-analysis", async (req, res) => {
  if (!requireApiKey(req, res)) return;

  const { target_job, jd, resume, locale } = req.body;
  const model = getLLMConfig().model || "gpt-4.1-mini";

  const system = `You are a career strategist for China job market.
Return STRICT JSON only. No markdown, no extra keys.
Language: ${locale || "zh-CN"}.

Schema:
{
  "gaps": Array<{ "area": string, "evidence": string, "severity": "高"|"中"|"低" }>,
  "plan": Array<{ "week": number, "goal": string, "actions": Array<string>, "deliverable": string, "success_metric": string }>,
  "export_markdown": string
}

Rules:
- Analyze gaps between resume and target job requirements.
- Create a 7-day actionable plan.
- Export markdown should be a summary report.`;

  const user = `Target Job: ${JSON.stringify(target_job)}
JD: ${jd || ""}
Resume: ${resume || ""}`;

  try {
    const completion = await openai.chat.completions.create({
      model,
      temperature: 0.3,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      response_format: { type: "json_object" },
    });

    const content = completion.choices?.[0]?.message?.content || "";
    const json = safeJsonParse(content);
    if (!json) {
      res.status(502).json({ error: "Model returned non-JSON output.", raw: content.slice(0, 800) });
      return;
    }

    res.json(json);
  } catch (err) {
    res.status(500).json({
      error: "LLM request failed.",
      detail: err?.message || String(err),
    });
  }
});

app.post("/api/interview-questions", async (req, res) => {
  if (!requireApiKey(req, res)) return;

  const { target_job, jd, resume, locale } = req.body;
  const model = getLLMConfig().model || "gpt-4.1-mini";

  const system = `You are a realistic interviewer for the target role.
Return STRICT JSON only. No markdown, no extra keys.
Language: ${locale || "zh-CN"}.

Schema:
{
  "project_deep_dive": Array<{ "question": string, "intent": string, "follow_ups": Array<string> }>,
  "behavioral": Array<{ "question": string, "intent": string, "follow_ups": Array<string> }>,
  "role_specific": Array<{ "question": string, "intent": string, "follow_ups": Array<string> }>,
  "export_markdown": string
}

Rules:
- Ground questions in resume projects; ask for specifics (scope, trade-offs, metrics, failures).
- Follow-ups must be sharp and realistic.
- Keep responses CONCISE: 2-3 projects with 2-3 questions each, 3-4 behavioral questions, 2-3 role-specific questions.
- Use short, direct sentences.`;

  const user = `Target Job: ${JSON.stringify(target_job)}
JD: ${jd || ""}
Resume: ${resume || ""}`;

  try {
    const completion = await openai.chat.completions.create({
      model,
      temperature: 0.3,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      response_format: { type: "json_object" },
    });

    const content = completion.choices?.[0]?.message?.content || "";
    const json = safeJsonParse(content);
    if (!json) {
      res.status(502).json({ error: "Model returned non-JSON output.", raw: content.slice(0, 800) });
      return;
    }

    res.json(json);
  } catch (err) {
    res.status(500).json({
      error: "LLM request failed.",
      detail: err?.message || String(err),
    });
  }
});

// Local development server
const port = Number(process.env.PORT || 5173);
app.listen(port, () => {
  console.log(`[server] running: http://localhost:${port}`);
  console.log(`[server] serving static from: ${projectRoot}`);
  const c = getLLMConfig();
  if (!c.apiKey) {
    console.log("[server] API key not set (AI endpoints will return 501).");
  } else {
    console.log(`[server] provider=${c.provider} model=${c.model} base_url=${c.baseURL || "https://api.openai.com"}`);
  }
});

// Export for Vercel
export default app;


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
app.use(express.static(projectRoot));

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

  const system = `You are an expert recruiter + resume editor.
Return STRICT JSON only. No markdown, no extra keys.
Language: ${locale}.

Schema:
{
  "score": number, // 0-100
  "issues": Array<{ "type": "表达"|"结构"|"数据缺失"|"匹配度"|"风险", "severity": "高"|"中"|"低", "title": string, "detail": string }>,
  "suggestions": Array<{ "title": string, "example": string }>,
  "highlights": Array<string>
}

Rules:
- Tie every issue/suggestion directly to provided JD and resume content; cite short phrases from the resume/JD when helpful.
- Suggestions must be actionable and include rewrite examples (Chinese).
- Keep: issues 6-10 items, suggestions 5-8 items, highlights 3-6 items.`;

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


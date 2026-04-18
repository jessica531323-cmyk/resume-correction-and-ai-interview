const express = require('express');
const OpenAI = require('openai');

const app = express();
app.disable('x-powered-by');

app.use(express.json({ limit: '2mb' }));

// CORS 设置
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }
  next();
});

function getLLMConfig() {
  const apiKey = process.env.LLM_API_KEY || '';
  const baseURL = process.env.LLM_BASE_URL || '';
  const model = process.env.LLM_MODEL || 'gpt-4.1-mini';
  const provider = process.env.LLM_PROVIDER || (baseURL.toLowerCase().includes('deepseek') ? 'deepseek' : 'openai-compatible');
  return { apiKey, baseURL: baseURL || undefined, model, provider };
}

function requireApiKey(req, res) {
  const cfg = getLLMConfig();
  if (!cfg.apiKey) {
    res.status(501).json({
      error: 'Server missing API key. Set LLM_API_KEY in environment variables.',
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

// 健康检查
app.get('/api/health', (req, res) => {
  const c = getLLMConfig();
  res.json({
    ok: true,
    hasOpenAIKey: Boolean(c.apiKey),
    provider: c.provider,
    model: c.model,
    base_url: c.baseURL || 'https://api.openai.com',
  });
});

// 简历诊断
app.post('/api/resume-diagnosis', async (req, res) => {
  if (!requireApiKey(req, res)) return;

  const jd = (req.body?.jd || '').toString();
  const resume = (req.body?.resume || '').toString();
  const locale = (req.body?.locale || 'zh-CN').toString();

  if (jd.trim().length < 20 || resume.trim().length < 50) {
    res.status(400).json({ error: 'Please provide jd (>=20 chars) and resume (>=50 chars).' });
    return;
  }

  const model = getLLMConfig().model || 'gpt-4.1-mini';

  const system = `You are an expert recruiter + resume editor for China job market.
Return STRICT JSON only. No markdown, no extra keys, no code fences.
Language: ${locale}.

Schema:
{
  "score": number,
  "issues": Array<{ "type": "表达"|"结构"|"数据缺失"|"匹配度"|"风险", "severity": "高"|"中"|"低", "title": string, "detail": string, "why_it_matters": string, "how_to_fix": string }>,
  "suggestions": Array<{ "title": string, "example": string, "priority": "P0"|"P1"|"P2" }>,
  "highlights": Array<string>,
  "rewritten_resume": string,
  "export_format": "text"
}

Hard requirements:
- Must be grounded in the given JD + resume.
- Provide a full rewritten resume in Chinese as PLAIN TEXT with NO Markdown syntax like # or **.
- Keep: issues 8-12, suggestions 6-10, highlights 3-6.`;

  const user = `Job Description (JD):\n${jd}\n\nResume:\n${resume}`;

  try {
    const completion = await openai.chat.completions.create({
      model,
      temperature: 0.2,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      response_format: { type: 'json_object' },
    });

    const content = completion.choices?.[0]?.message?.content || '';
    const json = safeJsonParse(content);
    if (!json) {
      res.status(502).json({ error: 'Model returned non-JSON output.', raw: content.slice(0, 800) });
      return;
    }

    const score = Number(json.score);
    json.score = Number.isFinite(score) ? Math.max(0, Math.min(100, Math.round(score))) : 70;

    res.json(json);
  } catch (err) {
    res.status(500).json({
      error: 'LLM request failed.',
      detail: err?.message || String(err),
    });
  }
});

// 岗位推荐
app.post('/api/job-recommendations', async (req, res) => {
  if (!requireApiKey(req, res)) return;

  const { persona, resume, jd, locale } = req.body;
  const model = getLLMConfig().model || 'gpt-4.1-mini';

  const system = `You are a career advisor for China job market.
Return STRICT JSON only. No markdown, no extra keys.
Language: ${locale || 'zh-CN'}.

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
- Each position must have specific match reason.`;

  const user = `Persona: ${JSON.stringify(persona)}\nResume: ${resume || ''}\nJD: ${jd || ''}`;

  try {
    const completion = await openai.chat.completions.create({
      model,
      temperature: 0.3,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      response_format: { type: 'json_object' },
    });

    const content = completion.choices?.[0]?.message?.content || '';
    const json = safeJsonParse(content);
    if (!json || !json.positions) {
      res.status(502).json({ error: 'Model returned invalid output.', raw: content.slice(0, 800) });
      return;
    }

    res.json(json);
  } catch (err) {
    res.status(500).json({
      error: 'LLM request failed.',
      detail: err?.message || String(err),
    });
  }
});

// 能力差距分析
app.post('/api/gap-analysis', async (req, res) => {
  if (!requireApiKey(req, res)) return;

  const { target_job, jd, resume, locale } = req.body;
  const model = getLLMConfig().model || 'gpt-4.1-mini';

  const system = `You are a career strategist for China job market.
Return STRICT JSON only. No markdown, no extra keys.
Language: ${locale || 'zh-CN'}.

Schema:
{
  "gaps": Array<{ "area": string, "evidence": string, "severity": "高"|"中"|"低" }>,
  "plan": Array<{ "week": number, "goal": string, "actions": Array<string>, "deliverable": string, "success_metric": string }>,
  "export_markdown": string
}

Rules:
- Analyze gaps between resume and target job requirements.
- Create a 7-day actionable plan.`;

  const user = `Target Job: ${JSON.stringify(target_job)}\nJD: ${jd || ''}\nResume: ${resume || ''}`;

  try {
    const completion = await openai.chat.completions.create({
      model,
      temperature: 0.3,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      response_format: { type: 'json_object' },
    });

    const content = completion.choices?.[0]?.message?.content || '';
    const json = safeJsonParse(content);
    if (!json) {
      res.status(502).json({ error: 'Model returned non-JSON output.', raw: content.slice(0, 800) });
      return;
    }

    res.json(json);
  } catch (err) {
    res.status(500).json({
      error: 'LLM request failed.',
      detail: err?.message || String(err),
    });
  }
});

// 模拟面试问题
app.post('/api/interview-questions', async (req, res) => {
  if (!requireApiKey(req, res)) return;

  const { target_job, jd, resume, locale } = req.body;
  const model = getLLMConfig().model || 'gpt-4.1-mini';

  const system = `You are a realistic interviewer for the target role.
Return STRICT JSON only. No markdown, no extra keys.
Language: ${locale || 'zh-CN'}.

Schema:
{
  "project_deep_dive": Array<{ "question": string, "intent": string, "follow_ups": Array<string> }>,
  "behavioral": Array<{ "question": string, "intent": string, "follow_ups": Array<string> }>,
  "role_specific": Array<{ "question": string, "intent": string, "follow_ups": Array<string> }>,
  "export_markdown": string
}

Rules:
- Ground questions in resume projects; ask for specifics.
- Keep responses CONCISE.`;

  const user = `Target Job: ${JSON.stringify(target_job)}\nJD: ${jd || ''}\nResume: ${resume || ''}`;

  try {
    const completion = await openai.chat.completions.create({
      model,
      temperature: 0.3,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      response_format: { type: 'json_object' },
    });

    const content = completion.choices?.[0]?.message?.content || '';
    const json = safeJsonParse(content);
    if (!json) {
      res.status(502).json({ error: 'Model returned non-JSON output.', raw: content.slice(0, 800) });
      return;
    }

    res.json(json);
  } catch (err) {
    res.status(500).json({
      error: 'LLM request failed.',
      detail: err?.message || String(err),
    });
  }
});

// 云函数入口
exports.main = async (event, context) => {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      
      // 模拟 HTTP 请求
      const req = {
        method: event.httpMethod || 'GET',
        url: event.path || '/',
        headers: event.headers || {},
        body: event.body ? JSON.parse(event.body) : {},
      };
      
      const res = {
        statusCode: 200,
        headers: {},
        body: '',
        status(code) {
          this.statusCode = code;
          return this;
        },
        setHeader(key, value) {
          this.headers[key] = value;
          return this;
        },
        json(data) {
          this.setHeader('Content-Type', 'application/json');
          this.body = JSON.stringify(data);
          resolve({
            statusCode: this.statusCode,
            headers: this.headers,
            body: this.body,
          });
        },
        send(data) {
          this.body = data;
          resolve({
            statusCode: this.statusCode,
            headers: this.headers,
            body: this.body,
          });
        },
      };
      
      app(req, res);
    });
  });
};

// 本地测试支持
if (process.env.NODE_ENV !== 'production') {
  const port = process.env.PORT || 5173;
  app.listen(port, () => {
    console.log(`[server] running: http://localhost:${port}`);
  });
}

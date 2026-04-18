import json
import mimetypes
import os
import re
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError


ROOT = Path(__file__).resolve().parent


def load_dotenv_if_present():
    env_path = ROOT / ".env"
    if not env_path.exists():
        return
    try:
        for line in env_path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            k = k.strip()
            v = v.strip().strip('"').strip("'")
            if k and k not in os.environ:
                os.environ[k] = v
    except Exception:
        # best-effort; do not crash
        return


def json_response(handler: BaseHTTPRequestHandler, status: int, payload: dict):
    # Ensure payload doesn't contain non-ASCII chars in keys that might cause issues
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


def read_json(handler: BaseHTTPRequestHandler):
    length = int(handler.headers.get("Content-Length", "0") or "0")
    raw = handler.rfile.read(length) if length > 0 else b"{}"
    try:
        return json.loads(raw.decode("utf-8"))
    except Exception:
        return None


def _get_llm_config():
    # Priority: generic -> deepseek -> openai
    api_key = (
        os.environ.get("LLM_API_KEY", "").strip()
        or os.environ.get("DEEPSEEK_API_KEY", "").strip()
        or os.environ.get("OPENAI_API_KEY", "").strip()
    )

    base_url = (
        os.environ.get("LLM_BASE_URL", "").strip()
        or os.environ.get("DEEPSEEK_BASE_URL", "").strip()
        or os.environ.get("OPENAI_BASE_URL", "").strip()
    )
    if not base_url:
        # default to OpenAI; set DEEPSEEK_BASE_URL for DeepSeek
        base_url = "https://api.openai.com"

    model = (
        os.environ.get("LLM_MODEL", "").strip()
        or os.environ.get("DEEPSEEK_MODEL", "").strip()
        or os.environ.get("OPENAI_MODEL", "").strip()
        or "gpt-4.1-mini"
    )

    provider = (
        os.environ.get("LLM_PROVIDER", "").strip()
        or ("deepseek" if "deepseek" in base_url.lower() else "openai-compatible")
    )
    return {"api_key": api_key, "base_url": base_url, "model": model, "provider": provider}


def _chat_completions_url(base_url: str) -> str:
    b = (base_url or "").rstrip("/")
    # OpenAI-compatible providers vary:
    # - OpenAI: base_url usually https://api.openai.com (or .../v1)
    # - Volc ARK: base_url is https://ark.cn-beijing.volces.com/api/v3 (NO /v1)
    #
    # Rules:
    # - if base_url already ends with /v1 -> append /chat/completions
    # - if base_url contains /api/v3 (ARK) -> append /chat/completions
    # - otherwise -> append /v1/chat/completions
    if b.endswith("/v1"):
        return b + "/chat/completions"
    if "/api/v3" in b:
        return b + "/chat/completions"
    return b + "/v1/chat/completions"


def call_llm_resume_diagnosis(jd: str, resume: str, locale: str = "zh-CN"):
    cfg = _get_llm_config()
    api_key = cfg["api_key"]
    if not api_key:
        return (
            501,
            {
                "error": "Server missing API key. Set LLM_API_KEY (or DEEPSEEK_API_KEY / OPENAI_API_KEY) in .env then restart.",
            },
        )

    model = cfg["model"]

    system = f"""You are an expert recruiter + resume editor for China job market.
Return STRICT JSON only. No markdown, no extra keys, no code fences.
Language: {locale}.

Schema:
{{
  "score": number, // 0-100
  "issues": Array<{{ "type": "表达"|"结构"|"数据缺失"|"匹配度"|"风险", "severity": "高"|"中"|"低", "title": string, "detail": string, "why_it_matters": string, "how_to_fix": string }}>,
  "suggestions": Array<{{ "title": string, "example": string, "priority": "P0"|"P1"|"P2" }}>,
  "highlights": Array<string>,
  "rewritten_resume": string,
  "export_format": "text"
}}

Hard requirements:
- Must be grounded in the given JD + resume. Quote short phrases (<=20 chars) when necessary.
- Avoid generic or empty advice. If JD is vague, infer missing detail by asking the candidate to add specifics, but still produce concrete rewrite templates.
- For projects/internships: extract/produce detailed bullets with context, scope, constraints, decisions, trade-offs, and measurable outcomes.
- Data must follow product/operation logic: define metric, baseline, method, funnel/retention or efficiency logic, impact, and how measured.
- Provide a full rewritten resume in Chinese as PLAIN TEXT (ready to paste) with improved structure and quantified achievements. Use simple formatting with clear section headers and bullet points, NO Markdown syntax like # or **.
- Keep: issues 8-12, suggestions 6-10, highlights 3-6."""

    user = f"Job Description (JD):\n{jd}\n\nResume:\n{resume}"

    payload = {
        "model": model,
        "temperature": 0.2,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        "response_format": {"type": "json_object"},
    }
    
    # Ensure proper encoding of the JSON payload
    # Use ensure_ascii=True to avoid non-ASCII chars in the payload
    data = json.dumps(payload, ensure_ascii=True).encode("utf-8")

    req = Request(
        _chat_completions_url(cfg["base_url"]),
        data=data,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
        },
        method="POST",
    )

    try:
        with urlopen(req, timeout=120) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            content = (((data.get("choices") or [{}])[0].get("message") or {}).get("content")) or ""
            try:
                parsed = json.loads(content)
            except Exception:
                return (502, {"error": "Model returned non-JSON output.", "raw": content[:800]})

            score = parsed.get("score")
            try:
                score_num = int(round(float(score)))
            except Exception:
                score_num = 70
            parsed["score"] = max(0, min(100, score_num))
            return (200, parsed)
    except HTTPError as e:
        try:
            raw = e.read().decode("utf-8")
        except Exception:
            raw = ""
        return (502, {"error": "LLM HTTP error", "detail": str(e), "raw": raw[:1200]})
    except URLError as e:
        return (502, {"error": "Network error", "detail": str(e)})
    except Exception as e:
        import traceback
        error_detail = f"{type(e).__name__}: {str(e)}"
        print(f"[LLM-Resume] Unexpected error: {error_detail}")
        print(traceback.format_exc())
        return (500, {"error": "LLM request failed", "detail": error_detail.encode('ascii', 'ignore').decode('ascii')})


def call_llm_json(system: str, user: str, *, temperature: float = 0.2):
    cfg = _get_llm_config()
    api_key = cfg["api_key"]
    if not api_key:
        return (
            501,
            {"error": "Server missing API key. Set LLM_API_KEY (or DEEPSEEK_API_KEY / OPENAI_API_KEY) in .env then restart."},
        )

    payload = {
        "model": cfg["model"],
        "temperature": temperature,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        "response_format": {"type": "json_object"},
    }
    
    # Ensure proper encoding of the JSON payload
    # Use ensure_ascii=True to avoid non-ASCII chars in the payload
    data = json.dumps(payload, ensure_ascii=True).encode("utf-8")
    
    req = Request(
        _chat_completions_url(cfg["base_url"]),
        data=data,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
        },
        method="POST",
    )

    try:
        print(f"[LLM] Sending request to {cfg['base_url']}")
        with urlopen(req, timeout=120) as resp:
            print(f"[LLM] Response received, status={resp.status}")
            raw_bytes = resp.read()
            print(f"[LLM] Raw response length={len(raw_bytes)}")
            data = json.loads(raw_bytes.decode("utf-8"))
            content = (((data.get("choices") or [{}])[0].get("message") or {}).get("content")) or ""
            print(f"[LLM] Content length={len(content)}")
            parsed = json.loads(content)
            print(f"[LLM] JSON parsed successfully")
            return (200, parsed)
    except HTTPError as e:
        try:
            raw = e.read().decode("utf-8")
        except Exception:
            raw = ""
        print(f"[LLM] HTTP Error: {e.code}, {raw[:200]}")
        return (502, {"error": "LLM HTTP error", "detail": str(e), "raw": raw[:2000]})
    except URLError as e:
        print(f"[LLM] URL Error: {e.reason}")
        return (502, {"error": "Network error", "detail": str(e)})
    except Exception as e:
        import traceback
        error_detail = f"{type(e).__name__}: {str(e)}"
        print(f"[LLM] Unexpected error: {error_detail}")
        print(traceback.format_exc())
        # Return ASCII-only error message to avoid encoding issues
        return (500, {"error": "LLM request failed", "detail": error_detail.encode('ascii', 'ignore').decode('ascii')})


class Handler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        # keep logs readable
        sys.stdout.write("[http] " + (format % args) + "\n")

    def do_GET(self):
        if self.path.startswith("/api/health"):
            cfg = _get_llm_config()
            json_response(
                self,
                200,
                {
                    "ok": True,
                    "hasOpenAIKey": bool(cfg["api_key"]),
                    "provider": cfg["provider"],
                    "model": cfg["model"],
                    "base_url": cfg["base_url"],
                },
            )
            return

        # static file serving
        p = self.path.split("?", 1)[0]
        if p == "/":
            p = "/index.html"

        # prevent path traversal
        p = re.sub(r"^/+", "", p)
        file_path = (ROOT / p).resolve()
        if not str(file_path).startswith(str(ROOT.resolve())):
            self.send_error(403)
            return
        if not file_path.exists() or file_path.is_dir():
            self.send_error(404)
            return

        ctype, _ = mimetypes.guess_type(str(file_path))
        ctype = ctype or "application/octet-stream"
        content = file_path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(content)))
        self.end_headers()
        self.wfile.write(content)

    def do_POST(self):
        if self.path.startswith("/api/resume-diagnosis"):
            try:
                body = read_json(self)
                if body is None:
                    json_response(self, 400, {"error": "Invalid JSON body."})
                    return

                jd = str(body.get("jd") or "")
                resume = str(body.get("resume") or "")
                locale = str(body.get("locale") or "zh-CN")
                
                print(f"[resume-diagnosis] Received request: jd_len={len(jd)}, resume_len={len(resume)}")
                
                if len(jd.strip()) < 20 or len(resume.strip()) < 50:
                    json_response(self, 400, {"error": "Please provide jd (>=20 chars) and resume (>=50 chars)."})
                    return

                status, payload = call_llm_resume_diagnosis(jd, resume, locale)
                print(f"[resume-diagnosis] LLM response status={status}")
                json_response(self, status, payload)
            except Exception as e:
                print(f"[resume-diagnosis] UNEXPECTED ERROR: {str(e)}")
                import traceback
                traceback.print_exc()
                json_response(self, 500, {"error": "Internal server error", "detail": str(e)})
            return

        if self.path.startswith("/api/job-recommendations"):
            try:
                body = read_json(self)
                if body is None:
                    json_response(self, 400, {"error": "Invalid JSON body."})
                    return

                resume = str(body.get("resume") or "")
                jd = str(body.get("jd") or "")
                persona = body.get("persona") or {}
                locale = str(body.get("locale") or "zh-CN")
                
                print(f"[job-recommendations] Received request: resume_len={len(resume)}")
                
                if len(resume.strip()) < 50:
                    json_response(self, 400, {"error": "Please provide resume (>=50 chars)."})
                    return

                system = f"""You are a job matching product strategist.
Return STRICT JSON only.
Language: {locale}.

Schema:
{{
  "positions": Array<{{
    "id": string,
    "title": string,
    "level": string,
    "city": string,
    "salary_range": string,
    "match": number,
    "fit_summary": string,
    "must_have": Array<string>,
    "nice_to_have": Array<string>,
    "reasoning": Array<string>
  }}>,
  "persona_summary": string
}}

Rules:
- Ground in the resume; avoid empty reasoning.
- Provide 4-6 positions; include at least 1 conservative and 1 stretch option.
- Each reasoning bullet must reference concrete resume evidence and suggest how to position it.
- Keep responses CONCISE."""

                user = f"""Persona (may be partial):
{json.dumps(persona, ensure_ascii=False)}

JD (optional):
{jd}

Resume:
{resume}"""

                print(f"[job-recommendations] Calling LLM")
                status, payload = call_llm_json(system, user, temperature=0.2)
                print(f"[job-recommendations] LLM response status={status}")
                json_response(self, status, payload)
            except Exception as e:
                print(f"[job-recommendations] UNEXPECTED ERROR: {str(e)}")
                import traceback
                traceback.print_exc()
                json_response(self, 500, {"error": "Internal server error", "detail": str(e)})
            return

        if self.path.startswith("/api/gap-analysis"):
            try:
                body = read_json(self)
                if body is None:
                    json_response(self, 400, {"error": "Invalid JSON body."})
                    return

                resume = str(body.get("resume") or "")
                jd = str(body.get("jd") or "")
                target_job = body.get("target_job") or {}
                locale = str(body.get("locale") or "zh-CN")
                
                print(f"[gap-analysis] Received request: resume_len={len(resume)}, jd_len={len(jd)}")
                
                if len(resume.strip()) < 50:
                    json_response(self, 400, {"error": "Please provide resume (>=50 chars)."})
                    return
                if len(jd.strip()) < 20 and not target_job:
                    json_response(self, 400, {"error": "Please provide jd (>=20 chars) or target_job."})
                    return

                system = f"""You are a senior interviewer and career coach.
Return STRICT JSON only.
Language: {locale}.

Schema:
{{
  "summary": string,
  "missing_skills": Array<{{
    "skill": string,
    "priority": "P0"|"P1"|"P2",
    "why": string,
    "evidence_gap": string,
    "how_to_gain": Array<string>,
    "proof_in_resume": Array<string>
  }}>,
  "project_suggestions": Array<{{
    "title": string,
    "goal": string,
    "scope": Array<string>,
    "tech_stack": Array<string>,
    "metrics": Array<string>,
    "resume_bullets": Array<string>
  }}>,
  "learning_plan_14d": Array<{{
    "day": number,
    "focus": string,
    "deliverable": string
  }}>,
  "export_markdown": string
}}

Rules:
- Ground in resume + JD/target_job.
- Each missing skill must include how to prove it (resume bullets + measurable outcomes).
- Metrics must follow product/ops logic (baseline, method, funnel/retention/efficiency, measurement).
- Keep responses CONCISE: 3-5 missing skills, 2-3 project suggestions, 7-day plan (not 14).
- Use short, direct sentences. Avoid lengthy explanations."""

                user = f"""Target job:
{json.dumps(target_job, ensure_ascii=False)}

JD:
{jd}

Resume:
{resume}"""

                cfg = _get_llm_config()
                print(f"[gap-analysis] Calling LLM with model={cfg['model']}")
                status, payload = call_llm_json(system, user, temperature=0.2)
                print(f"[gap-analysis] LLM response status={status}")
                json_response(self, status, payload)
            except Exception as e:
                print(f"[gap-analysis] UNEXPECTED ERROR: {str(e)}")
                import traceback
                traceback.print_exc()
                json_response(self, 500, {"error": "Internal server error", "detail": str(e)})
            return

        if self.path.startswith("/api/interview-questions"):
            try:
                body = read_json(self)
                if body is None:
                    json_response(self, 400, {"error": "Invalid JSON body."})
                    return

                resume = str(body.get("resume") or "")
                jd = str(body.get("jd") or "")
                target_job = body.get("target_job") or {}
                locale = str(body.get("locale") or "zh-CN")
                
                print(f"[interview-questions] Received request: resume_len={len(resume)}, jd_len={len(jd)}")
                
                if len(resume.strip()) < 50:
                    json_response(self, 400, {"error": "Please provide resume (>=50 chars)."})
                    return

                system = f"""You are a realistic interviewer for the target role.
Return STRICT JSON only.
Language: {locale}.

Schema:
{{
  "project_deep_dive": Array<{{
    "project": string,
    "questions": Array<{{
      "q": string,
      "intent": string,
      "good_answer_structure": Array<string>,
      "follow_ups": Array<string>
    }}>
  }}>,
  "behavioral": Array<{{
    "q": string,
    "competency": string,
    "good_answer_structure": Array<string>,
    "follow_ups": Array<string>
  }}>,
  "role_specific": Array<{{
    "topic": string,
    "q": string,
    "good_answer_structure": Array<string>
  }}>,
  "export_markdown": string
}}

Rules:
- Ground questions in resume projects; ask for specifics (scope, trade-offs, metrics, failures).
- Follow-ups must be sharp and realistic.
- Keep responses CONCISE: 2-3 projects with 2-3 questions each, 3-4 behavioral questions, 2-3 role-specific questions.
- Use short, direct sentences."""

                user = f"""Target job:
{json.dumps(target_job, ensure_ascii=True)}

JD:
{jd}

Resume:
{resume}"""

                print(f"[interview-questions] Calling LLM with concise prompt")
                status, payload = call_llm_json(system, user, temperature=0.2)
                print(f"[interview-questions] LLM response status={status}")
                json_response(self, status, payload)
            except Exception as e:
                print(f"[interview-questions] UNEXPECTED ERROR: {str(e)}")
                import traceback
                traceback.print_exc()
                json_response(self, 500, {"error": "Internal server error", "detail": str(e)})
            return

        json_response(self, 404, {"error": "Not found."})


def main():
    load_dotenv_if_present()
    port = int(os.environ.get("PORT", "5173"))
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"[server.py] running: http://localhost:{port}")
    cfg = _get_llm_config()
    if not cfg["api_key"]:
        print("[server.py] API key not set (AI endpoints will return 501; UI will fall back to demo).")
    else:
        print(f"[server.py] provider={cfg['provider']} model={cfg['model']} base_url={cfg['base_url']}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()


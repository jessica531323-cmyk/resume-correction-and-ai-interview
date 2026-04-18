# 求职面试助手（Web 原型）

本项目包含纯前端原型页面（Tailwind + Font Awesome + 少量 JS），并提供一个 **可选的本地 Node 服务**用于接入 AI，实现“根据你上传的简历生成诊断建议”。

## 预览（不接 AI）

- 直接打开 `index.html`（双击）即可浏览原型
- 注意：此时 `resume.html` 的“诊断结果”为 **示例规则**（用于信息结构与交互对齐）

## 启用 AI 简历诊断（推荐）

> 不建议把 API Key 放在前端页面里；本项目采用本地服务做代理，Key 放在环境变量里。

### 方案 A：Python 一键启动（无需 npm，最快）

1) 复制环境变量文件：

```powershell
cd "c:\Users\Daisy\Desktop\求职面试助手"
copy .env.example .env
notepad .env
```

在 `.env` 填入你的（DeepSeek-V3.2 示例）：

- `LLM_API_KEY=你的DeepSeekKey`
- `LLM_BASE_URL=https://api.deepseek.com`
- `LLM_MODEL=deepseek-v3.2`

2) 启动：

```powershell
cd "c:\Users\Daisy\Desktop\求职面试助手"
python server.py
```

打开：

- `http://localhost:5173/index.html`

此时 `resume.html` 会显示 **“AI：已启用（使用真实简历）”**。

3) 检查环境变量是否生效（不会泄露 Key）

打开浏览器访问：

- `http://localhost:5173/api/health`

你会看到 `provider/model/base_url/hasOpenAIKey`。其中 `hasOpenAIKey: true` 表示 key 已被读取到。

### 1) 安装依赖

在项目根目录执行：

```powershell
npm i
```

### 2) 配置环境变量

复制一份示例文件：

```powershell
copy .env.example .env
```

编辑 `.env`，填入（DeepSeek-V3.2 同上，或使用 `DEEPSEEK_*`）：

- `LLM_API_KEY=...`
- `LLM_BASE_URL=https://api.deepseek.com`
- `LLM_MODEL=deepseek-v3.2`
- （可选）`PORT=5173`

### 3) 启动服务

```powershell
npm run dev
```

启动成功后会看到类似输出：

- `[server] running: http://localhost:5173`

随后打开：

- `http://localhost:5173/index.html`

此时 `resume.html` 顶部会显示 **“AI：已启用（使用真实简历）”**，点击“开始诊断”会调用 `/api/resume-diagnosis` 返回真实建议。

## 常见问题

### 浏览器 `ERR_CONNECTION_REFUSED`

- 说明本地服务没启动/端口没监听
- 确认你运行的是：

```powershell
npm run dev
```

并访问对应端口（默认 5173）。

### 上传 PDF/DOCX 没效果

- 纯前端原型不做 PDF/DOCX 文本抽取
- 建议导出为 `.txt`/`.md` 后上传，或后续接入后端解析


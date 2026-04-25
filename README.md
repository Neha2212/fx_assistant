# FX Agent — AI-Powered Currency Intelligence Chrome Extension

A Chrome extension with a Gemini-powered agentic loop for smart currency analysis,
trend-based recommendations, and real-time rate alerts.

---

## Features

- **Ask the Agent anything** — "Should I convert £2000 to INR now?"
- **Step-by-step reasoning chain** — watch every tool call and result like Claude's thinking
- **Rate alerts with push notifications** — fires even when popup is closed
- **5 built-in tools**: current rate, history, trend analysis, news, alert setter
- **Live ticker** on the selected currency pair (refreshes every 30s)

---

## Setup

### 1. Get API Keys

**Gemini (Required — Free)**
1. Go to https://aistudio.google.com
2. Click "Get API Key" → Create API Key
3. Copy the key starting with `AIza...`

**NewsAPI (Optional — Free)**
1. Go to https://newsapi.org → Register
2. Copy your API key (enables the news analysis tool)

### 2. Load Extension in Chrome

1. Open Chrome → `chrome://extensions`
2. Enable **Developer mode** (top right toggle)
3. Click **Load unpacked**
4. Select this `fx-agent` folder
5. The FX Agent icon appears in your toolbar

### 3. Configure

1. Click the FX Agent icon → go to **Settings** tab (⚙)
2. Paste your **Gemini API key**
3. (Optional) Paste your **NewsAPI key**
4. Click **Save Settings**

---

## Usage

### Analyze Tab
- Select your currency pair (FROM / TO)
- Use quick-prompt chips or type your own question
- Press **Ask** or hit Enter
- Watch the reasoning chain unfold in real time

**Example queries:**
- "Should I convert now? I'm sending £2000 to India."
- "What's the 30-day trend for USD/JPY?"
- "Is this a good rate historically?"
- "Any news affecting GBP/EUR this week?"

### Alerts Tab
- Select pair, direction (rises above / drops below), target rate
- Click **Set Alert**
- Chrome will notify you even when the popup is closed
- Background polling every 5 minutes

---

## Architecture

```
popup.html / popup.js        ← Main UI + Agentic loop
background.js                ← Service worker, polls alerts
styles.css                   ← Dark terminal UI
manifest.json                ← Chrome Extension MV3 config

APIs Used:
  Frankfurter API            ← Exchange rates + history (free, no key)
  Gemini API                 ← LLM with function calling
  NewsAPI                    ← News headlines (optional)
```

### Agent Loop
```
User Query
  → Gemini (with 5 tool declarations)
  → functionCall: get_current_rate
    → Tool executes → result shown in UI
  → functionCall: analyze_trend
    → Tool executes → result shown in UI
  → [optional] functionCall: get_currency_news
    → Tool executes → result shown in UI
  → Final text response → shown as Recommendation
```

---

## Files

```
fx-agent/
├── manifest.json
├── popup.html
├── popup.js          ← All agent logic + tools
├── background.js     ← Alert polling service worker
├── styles.css        ← UI styling
├── icons/
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
└── README.md
```

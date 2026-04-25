/* ══════════════════════════════════════════════════════════════
   FX AGENT — popup.js  (v2)
   7 tools · LLM session logging · sparkline · Gemini agent loop
   ══════════════════════════════════════════════════════════════ */
'use strict';

// ─── Config ───────────────────────────────────────────────────────────────────
const FRANKFURTER   = 'https://api.frankfurter.app';
const GEMINI_BASE   = 'https://generativelanguage.googleapis.com/v1beta/models';
const MAX_ITER      = 10;
const LOG_KEY       = 'fx_logs';
const MAX_LOGS      = 50;

const CURRENCIES = [
  'AED','AUD','BRL','CAD','CHF','CNY','CZK','DKK','EUR','GBP',
  'HKD','HUF','IDR','ILS','INR','JPY','KRW','MXN','MYR','NOK',
  'NZD','PHP','PLN','RON','SEK','SGD','THB','TRY','USD','ZAR'
].sort();

// ─── State ────────────────────────────────────────────────────────────────────
let geminiKey   = '';
let newsKey     = '';
let geminiModel = 'gemini-2.5-flash-preview-04-17';
let isRunning   = false;
let liveTimer   = null;

// Persists across multiple asks within the same popup session
let conversationHistory = [];

// Active session being recorded
let activeSession = null;

// ═════════════════════════════════════════════════════════════════════════════
// TOOL DECLARATIONS
// ═════════════════════════════════════════════════════════════════════════════
const TOOL_DECLARATIONS = [
  {
    name: 'get_current_rate',
    description: 'Get the live exchange rate between two currencies. Always call this before any recommendation.',
    parameters: {
      type: 'OBJECT',
      properties: {
        from_currency: { type: 'STRING', description: 'Source currency ISO code, e.g. USD, GBP' },
        to_currency:   { type: 'STRING', description: 'Target currency ISO code, e.g. INR, JPY' }
      },
      required: ['from_currency','to_currency']
    }
  },
  {
    name: 'get_rate_history',
    description: 'Fetch daily exchange rates for the past N days. Returns a date series.',
    parameters: {
      type: 'OBJECT',
      properties: {
        from_currency: { type: 'STRING', description: 'Source currency ISO code' },
        to_currency:   { type: 'STRING', description: 'Target currency ISO code' },
        days:          { type: 'NUMBER', description: 'Days of history to fetch, e.g. 7, 30, 90' }
      },
      required: ['from_currency','to_currency','days']
    }
  },
  {
    name: 'analyze_trend',
    description: 'Compute statistical trend analysis: moving averages, volatility, range position, 5-day momentum. Returns structured stats for building recommendations.',
    parameters: {
      type: 'OBJECT',
      properties: {
        from_currency: { type: 'STRING', description: 'Source currency ISO code' },
        to_currency:   { type: 'STRING', description: 'Target currency ISO code' },
        days:          { type: 'NUMBER', description: 'Period to analyze, default 30' }
      },
      required: ['from_currency','to_currency']
    }
  },
  {
    name: 'calculate_conversion',
    description: 'Convert a specific monetary amount between currencies. Shows exact amount the user will receive and fee context.',
    parameters: {
      type: 'OBJECT',
      properties: {
        amount:        { type: 'NUMBER', description: 'Amount to convert' },
        from_currency: { type: 'STRING', description: 'Source currency ISO code' },
        to_currency:   { type: 'STRING', description: 'Target currency ISO code' }
      },
      required: ['amount','from_currency','to_currency']
    }
  },
  {
    name: 'compare_multiple_pairs',
    description: 'Compare a base currency against several target currencies at once. Useful for "which currency should I convert to" questions.',
    parameters: {
      type: 'OBJECT',
      properties: {
        base_currency:    { type: 'STRING', description: 'The base currency to compare from, e.g. GBP' },
        target_currencies: {
          type: 'ARRAY',
          items: { type: 'STRING' },
          description: 'List of target currencies to compare against, e.g. ["USD","EUR","INR","JPY"]'
        }
      },
      required: ['base_currency','target_currencies']
    }
  },
  {
    name: 'get_currency_news',
    description: 'Fetch recent news headlines affecting this currency pair. Requires NewsAPI key in settings.',
    parameters: {
      type: 'OBJECT',
      properties: {
        currency_pair: { type: 'STRING', description: 'e.g. "GBP INR" or "USD EUR"' },
        days:          { type: 'NUMBER', description: 'Days back to search, e.g. 7' }
      },
      required: ['currency_pair']
    }
  },
  {
    name: 'set_rate_alert',
    description: 'Create a background alert that fires a Chrome notification when the rate crosses a threshold.',
    parameters: {
      type: 'OBJECT',
      properties: {
        from_currency: { type: 'STRING', description: 'Source currency ISO code' },
        to_currency:   { type: 'STRING', description: 'Target currency ISO code' },
        target_rate:   { type: 'NUMBER', description: 'Threshold rate to trigger alert' },
        direction:     { type: 'STRING', enum: ['above','below'], description: '"above" or "below"' },
        note:          { type: 'STRING', description: 'Optional note for the notification' }
      },
      required: ['from_currency','to_currency','target_rate','direction']
    }
  }
];

// ═════════════════════════════════════════════════════════════════════════════
// TOOL IMPLEMENTATIONS
// ═════════════════════════════════════════════════════════════════════════════
const tools = {

  async get_current_rate({ from_currency, to_currency }) {
    from_currency = from_currency.toUpperCase();
    to_currency   = to_currency.toUpperCase();
    if (from_currency === to_currency) return { from: from_currency, to: to_currency, rate: 1, formatted: '1.0000' };
    const data = await fxFetch(`${FRANKFURTER}/latest?from=${from_currency}&to=${to_currency}`);
    const rate = data.rates[to_currency];
    if (!rate) throw new Error(`Unsupported: ${to_currency}`);
    return { from: from_currency, to: to_currency, rate: +rate.toFixed(6), date: data.date, formatted: `1 ${from_currency} = ${rate.toFixed(4)} ${to_currency}` };
  },

  async get_rate_history({ from_currency, to_currency, days = 30 }) {
    from_currency = from_currency.toUpperCase();
    to_currency   = to_currency.toUpperCase();
    days = clamp(Number(days), 3, 365);
    const end   = new Date();
    const start = new Date(end - days * 864e5);
    const fmt   = d => d.toISOString().slice(0,10);
    const data  = await fxFetch(`${FRANKFURTER}/${fmt(start)}..${fmt(end)}?from=${from_currency}&to=${to_currency}`);
    const series = Object.entries(data.rates)
      .sort(([a],[b]) => a.localeCompare(b))
      .map(([date, rates]) => ({ date, rate: +(rates[to_currency]||0).toFixed(6) }))
      .filter(d => d.rate > 0);
    return { from: from_currency, to: to_currency, days_requested: days, points: series.length, series };
  },

  async analyze_trend({ from_currency, to_currency, days = 30 }) {
    from_currency = from_currency.toUpperCase();
    to_currency   = to_currency.toUpperCase();
    days = clamp(Number(days), 7, 365);
    const hist  = await tools.get_rate_history({ from_currency, to_currency, days });
    const rates = hist.series.map(d => d.rate);
    if (rates.length < 4) return { error: 'Not enough data points', points: rates.length };

    const avg = arr => arr.reduce((s,v) => s+v, 0) / arr.length;
    const cur  = rates.at(-1);
    const a7   = avg(rates.slice(-7));
    const a14  = avg(rates.slice(-14));
    const aAll = avg(rates);
    const hi   = Math.max(...rates);
    const lo   = Math.min(...rates);
    const range = hi - lo || 1;
    const pos  = ((cur - lo) / range) * 100;

    // Volatility: std dev of % changes
    const changes = rates.slice(1).map((v,i) => ((v - rates[i]) / rates[i]) * 100);
    const avgC = avg(changes);
    const std  = Math.sqrt(avg(changes.map(c => (c-avgC)**2)));

    // 5-day slope
    const l5   = rates.slice(-5);
    const slp  = (l5.at(-1) - l5[0]) / l5[0] * 100;

    const trendLabel = slp >  0.2 ? 'Upward ↑' : slp < -0.2 ? 'Downward ↓' : 'Sideways →';
    const volLabel   = std  < 0.3  ? 'Low'      : std  < 0.8  ? 'Moderate'   : 'High';
    const posLabel   = pos  > 70   ? 'Near Period High' : pos < 30 ? 'Near Period Low' : 'Mid-Range';

    return {
      pair: `${from_currency}/${to_currency}`,
      period_days:         hist.points,
      current_rate:        +cur.toFixed(6),
      avg_full_period:     +aAll.toFixed(6),
      avg_7day:            +a7.toFixed(6),
      avg_14day:           +a14.toFixed(6),
      period_high:         +hi.toFixed(6),
      period_low:          +lo.toFixed(6),
      position_in_range_pct: +pos.toFixed(1),
      position_label:      posLabel,
      trend_5day_pct:      `${slp>=0?'+':''}${slp.toFixed(3)}%`,
      trend_label:         trendLabel,
      volatility_pct:      +std.toFixed(3),
      volatility_label:    volLabel,
      momentum_vs_avg:     `${((cur-aAll)/aAll*100)>=0?'+':''}${((cur-aAll)/aAll*100).toFixed(2)}%`,
      interpretation:      `${posLabel}, ${trendLabel} trend, ${volLabel} volatility over ${hist.points} trading days.`
    };
  },

  async calculate_conversion({ amount, from_currency, to_currency }) {
    amount = Number(amount);
    from_currency = from_currency.toUpperCase();
    to_currency   = to_currency.toUpperCase();
    if (!amount || amount <= 0) throw new Error('Amount must be positive');
    const { rate, date } = await tools.get_current_rate({ from_currency, to_currency });
    const converted = +(amount * rate).toFixed(2);
    const midMarket = `${amount} ${from_currency} = ${converted} ${to_currency}`;
    // Estimate bank/card markup impact (typical 2-3%)
    const afterFee2pct = +(amount * rate * 0.98).toFixed(2);
    const afterFee3pct = +(amount * rate * 0.97).toFixed(2);
    return {
      amount, from: from_currency, to: to_currency,
      rate: +rate.toFixed(6), rate_date: date,
      mid_market_result:  converted,
      formatted:          midMarket,
      after_2pct_fee:     afterFee2pct,
      after_3pct_fee:     afterFee3pct,
      fee_cost_range:     `${+(amount * rate * 0.02).toFixed(2)}–${+(amount * rate * 0.03).toFixed(2)} ${to_currency}`,
      tip:                'Use Wise or Revolut to get close to the mid-market rate and minimize fees.'
    };
  },

  async compare_multiple_pairs({ base_currency, target_currencies }) {
    base_currency    = base_currency.toUpperCase();
    target_currencies = (target_currencies || []).map(c => c.toUpperCase()).slice(0, 8);
    if (!target_currencies.length) throw new Error('Provide at least one target currency');
    const results = [];
    for (const target of target_currencies) {
      try {
        const { rate, date } = await tools.get_current_rate({ from_currency: base_currency, to_currency: target });
        // Get 7-day change
        const hist7 = await tools.get_rate_history({ from_currency: base_currency, to_currency: target, days: 7 });
        const first7 = hist7.series[0]?.rate || rate;
        const change7d = ((rate - first7) / first7 * 100).toFixed(3);
        results.push({ target, rate: +rate.toFixed(6), change_7d_pct: `${change7d>=0?'+':''}${change7d}%`, date });
      } catch (e) {
        results.push({ target, error: e.message });
      }
    }
    return { base: base_currency, compared: results, count: results.length };
  },

  async get_currency_news({ currency_pair, days = 7 }) {
    if (!newsKey) return { status: 'no_key', message: 'NewsAPI key not configured. Add it in Config tab.', headlines: [] };
    days = clamp(Number(days), 1, 30);
    const from = new Date(Date.now() - days * 864e5).toISOString().slice(0,10);
    const q    = encodeURIComponent(currency_pair + ' currency exchange');
    const url  = `https://newsapi.org/v2/everything?q=${q}&from=${from}&sortBy=relevancy&pageSize=5&apiKey=${newsKey}`;
    const resp = await fetch(url);
    if (!resp.ok) { const e = await resp.json().catch(()=>({})); return { status:'error', message: e.message||`HTTP ${resp.status}`, headlines:[] }; }
    const data = await resp.json();
    const articles = (data.articles||[]).slice(0,5).map(a => ({ title: a.title, source: a.source?.name, date: a.publishedAt?.slice(0,10), summary: a.description?.slice(0,120) }));
    return { query: currency_pair, period: `Last ${days} days`, count: articles.length, headlines: articles };
  },

  async set_rate_alert({ from_currency, to_currency, target_rate, direction, note='' }) {
    from_currency = from_currency.toUpperCase();
    to_currency   = to_currency.toUpperCase();
    target_rate   = +Number(target_rate).toFixed(6);
    if (!target_rate || target_rate <= 0) throw new Error('Invalid target rate');
    if (!['above','below'].includes(direction)) throw new Error('direction must be above or below');

    const cur = await tools.get_current_rate({ from_currency, to_currency });

    // Check if condition is already met right now
    const alreadyMet = direction === 'above'
      ? cur.rate >= target_rate
      : cur.rate <= target_rate;

    const alert = {
      id:           `${Date.now()}-${Math.random().toString(36).slice(2,6)}`,
      from:         from_currency, to: to_currency,
      target:       target_rate, direction, note,
      currentRate:  cur.rate, createdAt: Date.now(),
      triggered:    alreadyMet,          // mark triggered immediately if already met
      triggeredAt:  alreadyMet ? Date.now() : null,
      triggeredRate: alreadyMet ? cur.rate : null,
      lastChecked:  null, lastRate: cur.rate
    };

    // Save to storage
    const { alerts = [] } = await chrome.storage.local.get('alerts');
    alerts.push(alert);
    await chrome.storage.local.set({ alerts });

    // Ensure 2-min background polling alarm is running
    const existing = await chrome.alarms.get('fx-agent-poll');
    if (!existing) chrome.alarms.create('fx-agent-poll', { periodInMinutes: 2 });

    // If already met → ask background to fire notification right now
    if (alreadyMet) {
      // Try directly from popup context first (more reliable for immediate alerts)
      const notifId   = `fxalert::${alert.id}`;
      const notifBody = {
        type:    'basic',
        iconUrl: 'icons/icon48.png',
        title:   '⚡ FX Agent — Condition Already Met!',
        message: `${from_currency}/${to_currency} is ${cur.rate.toFixed(4)}, already ${direction === 'above' ? 'above' : 'below'} your target of ${target_rate}.`,
        priority: 2,
        requireInteraction: true,
        buttons: [{ title: '✕  Dismiss this alert' }, { title: '📋 Open FX Agent' }]
      };
      chrome.notifications.create(notifId, notifBody).catch(() => {
        // Fallback: ask background service worker to fire it
        chrome.runtime.sendMessage({ type: 'FIRE_IMMEDIATE', alert, rate: cur.rate }).catch(() => {});
      });
    }

    const dist = Math.abs(target_rate - cur.rate);
    const pct  = (dist / cur.rate * 100).toFixed(2);

    return {
      status:       alreadyMet ? 'triggered_immediately' : 'alert_set',
      pair:         `${from_currency}/${to_currency}`,
      direction,    target: target_rate, current: cur.rate,
      distance_pct: `${pct}%`,
      already_met:  alreadyMet,
      message: alreadyMet
        ? `⚡ Condition already met! ${from_currency}/${to_currency} is ${cur.rate.toFixed(4)}, already ${direction === 'above' ? 'above' : 'below'} your target of ${target_rate}. Notifying you now.`
        : `✅ Alert set! ${from_currency}/${to_currency} at ${cur.rate.toFixed(4)} — ${pct}% away from ${target_rate}. Polling every 2 min. You'll get a dismissible notification when it triggers.`
    };
  }
};

// ═════════════════════════════════════════════════════════════════════════════
// GEMINI API
// ═════════════════════════════════════════════════════════════════════════════
async function callGemini(messages) {
  const url = `${GEMINI_BASE}/${geminiModel}:generateContent?key=${geminiKey}`;
  const body = {
    systemInstruction: { parts: [{ text: `You are FX Agent, an expert AI currency analyst embedded in a Chrome extension.

RULES:
- ALWAYS call get_current_rate before making any recommendation
- For "should I convert?" questions: call get_current_rate → analyze_trend → give recommendation
- For amount questions (e.g. "£2000"): call calculate_conversion after getting rate
- For multi-currency comparisons: use compare_multiple_pairs
- For alert requests: call get_current_rate then set_rate_alert
- Never guess rates from training data
- Be concise, data-driven, and actionable
- Format numbers clearly; use ** around key recommendations and numbers
- End recommendations with a clear VERDICT: BUY NOW / WAIT / NEUTRAL` }] },
    contents: messages,
    tools: [{ functionDeclarations: TOOL_DECLARATIONS }],
    generationConfig: { temperature: 0.25, maxOutputTokens: 1200 }
  };

  const t0   = Date.now();
  const resp = await fetch(url, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
  if (!resp.ok) {
    const e = await resp.json().catch(()=>({}));
    throw new Error(e?.error?.message || `Gemini ${resp.status}`);
  }
  const data = await resp.json();
  data._latency = Date.now() - t0;

  // Log raw Gemini response for the session
  if (activeSession) {
    activeSession.rawResponses.push({
      timestamp: new Date().toISOString(),
      latency_ms: data._latency,
      model: geminiModel,
      messagesCount: messages.length,
      response: data
    });
  }
  return data;
}

// ═════════════════════════════════════════════════════════════════════════════
// AGENT LOOP
// ═════════════════════════════════════════════════════════════════════════════
async function runAgent(userQuery) {
  if (isRunning) return;
  isRunning = true;
  setAskBusy(true);

  const from = document.getElementById('from-currency')?.value || '';
  const to   = document.getElementById('to-currency')?.value || '';

  // Clear the input immediately so user knows it was received
  document.getElementById('query-input').value = '';

  // First message in a new conversation: clear empty state
  if (conversationHistory.length === 0) clearChain();

  // Show turn divider if this is a follow-up
  if (conversationHistory.length > 0) {
    const turnNum = conversationHistory.filter(m => m.role === 'user').length + 1;
    addTurnDivider(`Follow-up · turn ${turnNum}`);
  }

  // Show the user's message as a bubble in the chain
  const displayQuery = userQuery.replace(/^\[Selected pair:[^\]]+\]\n/, '');
  addUserBubble(displayQuery);

  // Append user message to persistent history
  conversationHistory.push({ role: 'user', parts: [{ text: userQuery }] });

  // Update toolbar now that we have history
  updateChainToolbar();

  // Start session log
  activeSession = {
    id:           Date.now(),
    timestamp:    new Date().toISOString(),
    model:        geminiModel,
    pair:         `${from}/${to}`,
    query:        displayQuery,
    turnIndex:    conversationHistory.filter(m => m.role === 'user').length,
    toolCalls:    [],
    rawResponses: [],
    finalAnswer:  '',
    duration_ms:  0,
    error:        null
  };

  const t0 = Date.now();
  addStep('thinking', '🤔', 'Analyzing', `<div class="dots"><span></span><span></span><span></span></div>`);

  try {
    for (let i = 0; i < MAX_ITER; i++) {
      const response = await callGemini(conversationHistory);
      if (i === 0) removeStep('thinking');

      const candidate = response.candidates?.[0];
      if (!candidate) throw new Error('Empty Gemini response');

      const parts = candidate.content?.parts || [];
      let hasCall = false;
      const textParts = [];
      const fnResponses = [];

      // Push full model content once — preserves thought_signature for Gemini 2.5
      if (parts.length > 0) {
        conversationHistory.push(candidate.content);
      }

      for (const part of parts) {
        if (part.functionCall) {
          hasCall = true;
          const { name, args } = part.functionCall;
          const callStart = Date.now();

          addStep('tool-call', '🔧', `Tool: ${name}`, buildParamHtml(args), response._latency);

          let result;
          try { result = await tools[name](args); }
          catch (e) { result = { error: e.message }; }

          const callDur = Date.now() - callStart;
          addStep('tool-result', '✅', `Result: ${name}`, buildResultHtml(result), callDur);

          fnResponses.push({ functionResponse: { name, response: result } });
          activeSession.toolCalls.push({ tool: name, args, result, duration_ms: callDur });
          if (name === 'set_rate_alert' && !result.error) setTimeout(renderAlerts, 400);

        } else if (part.text && !part.thought) {
          textParts.push(part.text);
        }
      }

      // All function responses go back as a single user turn
      if (fnResponses.length > 0) {
        conversationHistory.push({ role: 'user', parts: fnResponses });
      }

      if (!hasCall && textParts.length) {
        const txt = textParts.join('\n');
        addStep('final', '💡', 'Recommendation', `<div class="final-body">${fmtFinal(txt)}</div>`, response._latency);
        activeSession.finalAnswer = txt;
        break;
      }

      if (!hasCall && !textParts.length) break;
    }
  } catch (err) {
    removeStep('thinking');
    addStep('step-error', '❌', 'Error', `<div style="font-family:var(--mono);font-size:11px;color:var(--red)">${err.message}</div>`);
    activeSession.error = err.message;
  }

  // Finalize and log the session
  activeSession.duration_ms     = Date.now() - t0;
  activeSession.historySnapshot = [...conversationHistory]; // full state at this point
  await saveSession(activeSession);
  activeSession = null;
  await renderLogs();

  isRunning = false;
  setAskBusy(false);
}

// ─── Conversation management ──────────────────────────────────────────────────
function clearConversation() {
  conversationHistory = [];
  clearChain();
  showChainEmpty();
  updateChainToolbar();
}

function updateChainToolbar() {
  const toolbar  = document.getElementById('chain-toolbar');
  const label    = document.getElementById('turn-count-label');
  const userTurns = conversationHistory.filter(m => m.role === 'user').length;

  if (userTurns > 0) {
    toolbar?.classList.remove('hidden');
    if (label) label.textContent = `${userTurns} message${userTurns !== 1 ? 's' : ''} in this conversation`;
  } else {
    toolbar?.classList.add('hidden');
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// UI: CHAIN STEPS
// ═════════════════════════════════════════════════════════════════════════════
function clearChain() {
  const c = document.getElementById('chain');
  if (c) c.innerHTML = '';
}

function showChainEmpty() {
  const c = document.getElementById('chain');
  if (!c) return;
  c.innerHTML = `
    <div class="chain-empty" id="chain-empty">
      <div class="ce-icon">
        <svg width="48" height="48" viewBox="0 0 48 48" fill="none">
          <circle cx="24" cy="24" r="22" stroke="#151e35" stroke-width="1.5"/>
          <circle cx="24" cy="24" r="14" stroke="#1a2640" stroke-width="1" stroke-dasharray="4 3"/>
          <path d="M16 24c0-4.4 3.6-8 8-8s8 3.6 8 8" stroke="#22d3ee" stroke-width="1.5" stroke-linecap="round"/>
          <circle cx="24" cy="24" r="4" fill="rgba(34,211,238,0.15)"/>
          <circle cx="24" cy="24" r="2" fill="#22d3ee"/>
        </svg>
      </div>
      <div class="ce-title">Agent Ready</div>
      <div class="ce-sub">Select a currency pair and ask a question.<br>Every reasoning step will appear here in real-time.</div>
      <div class="ce-examples">
        <div class="ce-example">"Should I send £500 to India this week?"</div>
        <div class="ce-example">"Alert me when USD/JPY drops below 148"</div>
        <div class="ce-example">"What's driving GBP/EUR changes lately?"</div>
      </div>
    </div>`;
}

// Scroll the chain container to its bottom — used for intermediate steps
function scrollChainToBottom() {
  const c = document.getElementById('chain');
  if (c) c.scrollTop = c.scrollHeight;
}

// Scroll so the TOP of `el` is visible — used for final answers so user reads from start
function scrollToShowTop(el) {
  const c = document.getElementById('chain');
  if (!c || !el) return;
  const cRect  = c.getBoundingClientRect();
  const elRect = el.getBoundingClientRect();
  const relTop = elRect.top - cRect.top + c.scrollTop;
  c.scrollTop  = Math.max(0, relTop - 8); // 8px breathing room at top
}

function addUserBubble(text) {
  const c = document.getElementById('chain');
  if (!c) return;
  const div = document.createElement('div');
  div.className = 'user-bubble';
  div.innerHTML = `<div class="user-bubble-inner">${escHtml(text)}</div>`;
  c.appendChild(div);
  scrollChainToBottom();
}

function addTurnDivider(label) {
  const c = document.getElementById('chain');
  if (!c) return;
  const div = document.createElement('div');
  div.className = 'turn-divider';
  div.innerHTML = `<span class="turn-divider-label">${label}</span>`;
  c.appendChild(div);
  scrollChainToBottom();
}

function addStep(type, icon, title, html, latencyMs) {
  const c = document.getElementById('chain');
  if (!c) return;

  // Remove empty state if present
  c.querySelector('.chain-empty')?.remove();

  const timing    = latencyMs ? `<span class="step-timing">${latencyMs}ms</span>` : '';
  const isCollapsible = (type === 'tool-call' || type === 'tool-result');
  const chevron   = isCollapsible
    ? `<svg class="step-chevron" viewBox="0 0 14 14" fill="none">
         <path d="M5 3l4 4-4 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
       </svg>`
    : '';

  const div = document.createElement('div');
  div.className = `step ${type}`;
  div.dataset.type = type;
  div.innerHTML = `
    <div class="step-header">
      <div class="step-icon-wrap">${icon}</div>
      <div class="step-title">${title}</div>
      ${timing}
      ${chevron}
    </div>
    <div class="step-body">${html}</div>`;

  if (isCollapsible) {
    div.querySelector('.step-header').addEventListener('click', () => {
      div.classList.toggle('expanded');
      scrollChainToBottom();
    });
  }

  c.appendChild(div);
  scrollChainToBottom();
}

function removeStep(type) {
  document.querySelector(`.step.${type}`)?.remove();
}

function buildParamHtml(args) {
  if (!args || typeof args !== 'object') return String(args);
  const rows = Object.entries(args).map(([k,v]) => {
    const val = Array.isArray(v) ? v.join(', ') : String(v);
    return `<div class="param-row"><span class="pk">${k}</span><span class="pv">${val}</span></div>`;
  }).join('');
  return `<div class="param-table">${rows}</div>`;
}

const RESULT_KEYS = ['rate','formatted','trend_label','position_label','volatility_label',
  'current_rate','period_high','period_low','status','message','count',
  'distance_pct','momentum_vs_avg','interpretation','mid_market_result',
  'fee_cost_range','tip','after_2pct_fee','base'];

function buildResultHtml(result) {
  if (result?.error) return `<div class="param-row"><span class="pk">error</span><span class="pv" style="color:var(--red)">${result.error}</span></div>`;

  // For compare_multiple_pairs, render a small table
  if (result.compared) {
    const rows = result.compared.map(r =>
      `<div class="param-row"><span class="pk">${result.base}/${r.target}</span><span class="pv">${r.rate ?? r.error} <span style="color:${r.change_7d_pct?.startsWith('+') ? 'var(--green)' : 'var(--red)'}">${r.change_7d_pct ?? ''}</span></span></div>`
    ).join('');
    return `<div class="param-table">${rows}</div>`;
  }

  // For headlines
  if (result.headlines?.length) {
    const hl = result.headlines.map(h => `<div class="param-row"><span class="pk">${h.date||''}</span><span class="pv">${h.title?.slice(0,80) ?? ''}</span></div>`).join('');
    return `<div class="param-table">${hl}</div>`;
  }

  const inline = RESULT_KEYS
    .filter(k => result[k] !== undefined && result[k] !== '')
    .map(k => `<div class="param-row"><span class="pk">${k}</span><span class="pv">${result[k]}</span></div>`)
    .join('');

  return `<div class="param-table">${inline || JSON.stringify(result).slice(0,120)}</div>`;
}

function fmtFinal(txt) {
  return txt
    // Headers — must run before general newline replacement
    .replace(/^### (.+)$/gm, '<div class="md-h3">$1</div>')
    .replace(/^## (.+)$/gm,  '<div class="md-h2">$1</div>')
    .replace(/^# (.+)$/gm,   '<div class="md-h1">$1</div>')
    // Bold + italic
    .replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*(.+?)\*\*/g,     '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g,         '<em>$1</em>')
    // Bullet lists
    .replace(/^[-*•] (.+)$/gm, '<div class="md-li">$1</div>')
    // Numbered lists
    .replace(/^\d+\. (.+)$/gm, '<div class="md-li numbered">$1</div>')
    // Horizontal rule
    .replace(/^---+$/gm, '<hr class="md-hr"/>')
    // Double newline → paragraph gap, single newline → line break
    .replace(/\n\n/g, '<div class="md-gap"></div>')
    .replace(/\n/g,   '<br>');
}

function setAskBusy(busy) {
  const btn     = document.getElementById('ask-btn');
  const label   = document.getElementById('ask-label');
  const arrow   = document.getElementById('ask-arrow');
  const spinner = document.getElementById('ask-spin');
  btn.disabled = busy;
  label.textContent = busy ? 'Working…' : 'Ask';
  arrow?.classList.toggle('hidden', busy);
  spinner?.classList.toggle('hidden', !busy);
}

// ═════════════════════════════════════════════════════════════════════════════
// SPARKLINE
// ═════════════════════════════════════════════════════════════════════════════
async function refreshSparklineAndRate() {
  const from = document.getElementById('from-currency')?.value;
  const to   = document.getElementById('to-currency')?.value;
  if (!from || !to || from === to) return;

  // Fetch live rate
  try {
    const cur = await tools.get_current_rate({ from_currency: from, to_currency: to });
    const el = document.getElementById('live-rate');
    if (el) el.textContent = cur.rate.toFixed(4);
  } catch {}

  // Fetch 7-day history for sparkline
  try {
    const hist = await tools.get_rate_history({ from_currency: from, to_currency: to, days: 7 });
    drawSparkline(hist.series);

    // 7d change
    const rates = hist.series.map(d => d.rate);
    if (rates.length >= 2) {
      const first = rates[0], last = rates.at(-1);
      const chg = ((last - first) / first * 100);
      const deltaEl = document.getElementById('rate-delta');
      if (deltaEl) {
        deltaEl.textContent = `${chg >= 0 ? '▲' : '▼'} ${Math.abs(chg).toFixed(2)}% 7d`;
        deltaEl.className = `rate-delta ${chg >= 0 ? 'up' : 'down'}`;
      }

      // Hi/Lo label
      const hi = Math.max(...rates), lo = Math.min(...rates);
      const hiLoEl = document.getElementById('spark-hi-lo');
      if (hiLoEl) hiLoEl.textContent = `H: ${hi.toFixed(4)}  L: ${lo.toFixed(4)}`;

      // Axis dates
      const startEl = document.getElementById('spark-start');
      const endEl   = document.getElementById('spark-end');
      if (startEl) startEl.textContent = hist.series[0]?.date || '';
      if (endEl)   endEl.textContent   = hist.series.at(-1)?.date || '';
    }
  } catch {}
}

function drawSparkline(series) {
  const svg = document.getElementById('sparkline');
  if (!svg || !series.length) return;

  const W = 360, H = 50, PAD = 6;
  const rates = series.map(d => d.rate);
  const hi = Math.max(...rates), lo = Math.min(...rates);
  const range = hi - lo || hi * 0.01;

  const x = (i) => (i / (rates.length - 1)) * W;
  const y = (r)  => H - PAD - ((r - lo) / range) * (H - PAD * 2);

  const pts = rates.map((r,i) => `${x(i).toFixed(1)},${y(r).toFixed(1)}`).join(' ');
  const isUp = rates.at(-1) >= rates[0];
  const stroke  = isUp ? '#10b981' : '#ef4444';
  const fillId  = `sg-${isUp ? 'up' : 'dn'}`;

  // Area fill points (close bottom)
  const areaFirst = `${x(0).toFixed(1)},${H}`;
  const areaLast  = `${x(rates.length-1).toFixed(1)},${H}`;
  const areaPts   = `${areaFirst} ${pts} ${areaLast}`;

  svg.innerHTML = `
    <defs>
      <linearGradient id="${fillId}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%"   stop-color="${stroke}" stop-opacity="0.25"/>
        <stop offset="100%" stop-color="${stroke}" stop-opacity="0"/>
      </linearGradient>
    </defs>
    <polygon points="${areaPts}" fill="url(#${fillId})"/>
    <polyline points="${pts}" fill="none" stroke="${stroke}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
    <circle cx="${x(rates.length-1).toFixed(1)}" cy="${y(rates.at(-1)).toFixed(1)}" r="3" fill="${stroke}" opacity="0.9"/>
  `;
}

// ═════════════════════════════════════════════════════════════════════════════
// LLM LOGS
// ═════════════════════════════════════════════════════════════════════════════
async function saveSession(session) {
  const { [LOG_KEY]: logs = [] } = await chrome.storage.local.get(LOG_KEY);
  logs.unshift(session);
  if (logs.length > MAX_LOGS) logs.length = MAX_LOGS;
  await chrome.storage.local.set({ [LOG_KEY]: logs });
}

async function renderLogs() {
  const { [LOG_KEY]: logs = [] } = await chrome.storage.local.get(LOG_KEY);
  const list = document.getElementById('logs-list');
  if (!list) return;

  const countEl = document.getElementById('log-count');
  if (countEl) countEl.textContent = logs.length;

  if (!logs.length) {
    list.innerHTML = `<div class="empty-state">
      <svg width="28" height="28" viewBox="0 0 28 28" fill="none"><rect x="4" y="4" width="20" height="20" rx="3" stroke="#1e2d4a" stroke-width="1.5"/><path d="M8 10h12M8 14h12M8 18h8" stroke="#1e2d4a" stroke-width="1.5" stroke-linecap="round"/></svg>
      No sessions yet — run the agent first
    </div>`;
    return;
  }

  list.innerHTML = logs.map((s, idx) => {
    const ago      = timeAgo(s.timestamp);
    const toolsStr = s.toolCalls.map(t => t.tool.replace('get_','').replace('_',' ')).join(' → ');
    const dur      = s.duration_ms ? `${(s.duration_ms/1000).toFixed(1)}s` : '';
    const queryShort = (s.query || '').slice(0,80).replace(/\[Selected pair[^\]]+\]\n?/,'');
    return `
      <div class="log-card" data-idx="${idx}">
        <div class="log-card-header">
          <div class="log-card-meta">
            <div class="log-query">${escHtml(queryShort)}</div>
            <div class="log-details">
              <span class="log-tag pair">${s.pair || '—'}</span>
              <span class="log-tag tools">${s.toolCalls.length} tool${s.toolCalls.length!==1?'s':''}</span>
              <span class="log-tag time">${ago}${dur ? ' · ' + dur : ''}</span>
            </div>
          </div>
          <div class="log-actions">
            <button class="icon-btn cyan copy-session-btn" data-idx="${idx}" title="Copy this session's full log">
              <svg width="11" height="11" viewBox="0 0 11 11" fill="none"><rect x="3.5" y="3.5" width="6.5" height="6.5" rx="1" stroke="currentColor" stroke-width="1.2" fill="none"/><path d="M3.5 7.5H2a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1h4.5a1 1 0 0 1 1 1v1.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>
              Copy
            </button>
          </div>
          <svg class="log-expand-icon" width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path d="M5 3l4 4-4 4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </div>
        <div class="log-card-body" id="log-body-${idx}">
          <div class="log-body-actions">
            <button class="icon-btn teal view-messages-btn" data-idx="${idx}">📨 Full Messages</button>
            <button class="icon-btn cyan view-tools-btn" data-idx="${idx}">🔧 Tool Calls</button>
            <button class="icon-btn cyan view-raw-btn" data-idx="${idx}">📡 Raw API</button>
          </div>
          <pre class="log-pre" id="log-pre-${idx}">Click a view button above to inspect the log.</pre>
        </div>
      </div>`;
  }).join('');

  // Bind expand toggles
  list.querySelectorAll('.log-card-header').forEach(hdr => {
    hdr.addEventListener('click', (e) => {
      if (e.target.closest('.log-actions')) return;
      const idx  = hdr.closest('.log-card').dataset.idx;
      const body = document.getElementById(`log-body-${idx}`);
      const icon = hdr.querySelector('.log-expand-icon');
      body?.classList.toggle('open');
      icon?.classList.toggle('open');
    });
  });

  // Copy individual session
  list.querySelectorAll('.copy-session-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const idx = btn.dataset.idx;
      const session = logs[idx];
      await copyToClipboard(JSON.stringify(session, null, 2));
      btn.textContent = '✓ Copied';
      setTimeout(() => { btn.innerHTML = '<svg width="11" height="11" viewBox="0 0 11 11" fill="none"><rect x="3.5" y="3.5" width="6.5" height="6.5" rx="1" stroke="currentColor" stroke-width="1.2" fill="none"/><path d="M3.5 7.5H2a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1h4.5a1 1 0 0 1 1 1v1.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg> Copy'; }, 2000);
    });
  });

  // View buttons
  list.querySelectorAll('.view-messages-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const pre = document.getElementById(`log-pre-${btn.dataset.idx}`);
      if (pre) pre.textContent = JSON.stringify(logs[btn.dataset.idx].messages, null, 2);
    });
  });

  list.querySelectorAll('.view-tools-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const pre = document.getElementById(`log-pre-${btn.dataset.idx}`);
      if (pre) pre.textContent = JSON.stringify(logs[btn.dataset.idx].toolCalls, null, 2);
    });
  });

  list.querySelectorAll('.view-raw-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const pre = document.getElementById(`log-pre-${btn.dataset.idx}`);
      if (pre) pre.textContent = JSON.stringify(logs[btn.dataset.idx].rawResponses, null, 2);
    });
  });
}

async function exportLogs() {
  const { [LOG_KEY]: logs = [] } = await chrome.storage.local.get(LOG_KEY);
  if (!logs.length) { alert('No logs to export.'); return; }
  const blob = new Blob([JSON.stringify(logs, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `fx-agent-logs-${new Date().toISOString().slice(0,10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

async function copyAllLogs() {
  const { [LOG_KEY]: logs = [] } = await chrome.storage.local.get(LOG_KEY);
  if (!logs.length) return;
  await copyToClipboard(JSON.stringify(logs, null, 2));
  const btn = document.getElementById('copy-all-btn');
  if (btn) { btn.textContent = '✓ Copied!'; setTimeout(() => { btn.innerHTML = '<svg width="12" height="12" viewBox="0 0 12 12" fill="none"><rect x="4" y="4" width="7" height="7" rx="1" stroke="currentColor" stroke-width="1.3" fill="none"/><path d="M4 8H2a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v2" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg> Copy All'; }, 2000); }
}

async function clearLogs() {
  if (!confirm('Clear all LLM session logs?')) return;
  await chrome.storage.local.remove(LOG_KEY);
  await renderLogs();
}

// ═════════════════════════════════════════════════════════════════════════════
// ALERTS
// ═════════════════════════════════════════════════════════════════════════════
async function renderAlerts() {
  const { alerts = [] } = await chrome.storage.local.get('alerts');
  const list  = document.getElementById('alerts-list');
  const count = document.getElementById('alert-count');
  if (count) count.textContent = alerts.length;
  if (!list) return;

  if (!alerts.length) {
    list.innerHTML = `<div class="empty-state"><svg width="28" height="28" viewBox="0 0 28 28" fill="none"><circle cx="14" cy="14" r="12" stroke="#1e2d4a" stroke-width="1.5"/><path d="M14 8v6l4 3" stroke="#1e2d4a" stroke-width="1.5" stroke-linecap="round"/></svg> No alerts yet</div>`;
    return;
  }

  list.innerHTML = alerts.map(a => {
    const cur = a.lastRate || a.currentRate;
    // Progress: how close to target (0-100%)
    const totalDist = Math.abs(a.target - a.currentRate);
    const curDist   = Math.abs(a.target - cur);
    const progress  = totalDist > 0 ? clamp((1 - curDist/totalDist)*100, 0, 100) : 50;
    const statusCls = a.triggered ? 'hit' : 'live';
    const statusTxt = a.triggered
      ? `🎯 Triggered at ${a.triggeredRate?.toFixed(4) || '—'}`
      : `Monitoring · now: ${cur?.toFixed(4) || 'pending'}`;

    return `<div class="alert-card ${a.triggered ? 'triggered' : ''}" data-id="${a.id}">
      <div class="alert-body">
        <div class="alert-pair">${a.from}/${a.to}</div>
        <div class="alert-cond">
          ${a.direction === 'above' ? 'Rises above' : 'Drops below'}
          <span class="tval"> ${a.target}</span>
          ${a.note ? `· <em style="color:var(--text-3)">${a.note}</em>` : ''}
        </div>
        ${!a.triggered ? `
          <div class="alert-progress-wrap">
            <div class="alert-progress-label">
              <span>${a.currentRate?.toFixed(4)||'—'}</span>
              <span>${Math.round(progress)}% to target</span>
              <span>${a.target}</span>
            </div>
            <div class="alert-progress-bar">
              <div class="alert-progress-fill" style="width:${progress}%"></div>
            </div>
          </div>` : ''}
        <div class="alert-status ${statusCls}">${statusTxt}</div>
      </div>
      <button class="del-btn" data-id="${a.id}">✕</button>
    </div>`;
  }).join('');

  list.querySelectorAll('.del-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const { alerts: cur = [] } = await chrome.storage.local.get('alerts');
      await chrome.storage.local.set({ alerts: cur.filter(a => a.id !== btn.dataset.id) });
      renderAlerts();
    });
  });
}

async function handleSetAlert() {
  const from   = document.getElementById('alert-from')?.value;
  const to     = document.getElementById('alert-to')?.value;
  const dir    = document.getElementById('alert-dir')?.value;
  const target = parseFloat(document.getElementById('alert-target')?.value);
  const msgEl  = document.getElementById('alert-msg');

  msgEl.className = 'msg-box hidden';

  if (!from || !to || from === to) { showMsg(msgEl, 'Select two different currencies', true); return; }
  if (!target || isNaN(target) || target <= 0) { showMsg(msgEl, 'Enter a valid target rate', true); return; }

  try {
    const result = await tools.set_rate_alert({ from_currency: from, to_currency: to, target_rate: target, direction: dir });
    showMsg(msgEl, `✅ ${result.message}`);
    document.getElementById('alert-target').value = '';
    await renderAlerts();
  } catch (err) {
    showMsg(msgEl, `Error: ${err.message}`, true);
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// SETTINGS
// ═════════════════════════════════════════════════════════════════════════════
async function loadSettings() {
  const data = await chrome.storage.local.get(['geminiKey','newsKey','geminiModel']);
  geminiKey   = data.geminiKey   || '';
  newsKey     = data.newsKey     || '';
  geminiModel = data.geminiModel || 'gemini-2.5-flash-preview-04-17';

  if (geminiKey) document.getElementById('gemini-key').value = '•'.repeat(20);
  if (newsKey)   document.getElementById('news-key').value   = '•'.repeat(20);

  const sel = document.getElementById('gemini-model');
  if (sel) {
    const inList = [...sel.options].some(o => o.value === geminiModel);
    if (!inList && geminiModel) {
      const opt = document.createElement('option');
      opt.value = geminiModel; opt.textContent = `${geminiModel} (saved)`; opt.selected = true;
      sel.insertAdjacentElement('afterbegin', opt);
    } else {
      sel.value = geminiModel;
    }
  }

  document.getElementById('no-key-banner').classList.toggle('hidden', !!geminiKey);
}

async function saveSettings() {
  const rawG  = document.getElementById('gemini-key').value.trim();
  const rawN  = document.getElementById('news-key').value.trim();
  const model = document.getElementById('gemini-model').value;
  const msgEl = document.getElementById('save-msg');

  if (rawG && !rawG.startsWith('•')) geminiKey = rawG;
  if (rawN && !rawN.startsWith('•')) newsKey   = rawN;
  geminiModel = model;

  if (!geminiKey) { showMsg(msgEl, '⚠ Gemini API key is required', true); return; }

  await chrome.storage.local.set({ geminiKey, newsKey, geminiModel });
  document.getElementById('no-key-banner').classList.add('hidden');
  showMsg(msgEl, '✅ Settings saved');
}

async function testNotification() {
  const statusEl = document.getElementById('notif-status');
  try {
    // Check permission level first
    const level = await new Promise(resolve =>
      chrome.notifications.getPermissionLevel(resolve)
    );

    if (level !== 'granted') {
      showMsg(statusEl, `❌ Notifications blocked (level: ${level}). On macOS: System Settings → Notifications → Google Chrome → Allow. On Windows: Action Center settings.`, true);
      return;
    }

    await chrome.notifications.create('fx-test-notif', {
      type:    'basic',
      iconUrl: 'icons/icon48.png',
      title:   '✅ FX Agent — Notifications Working!',
      message: 'Great! You will receive rate alerts as Chrome notifications.\n\nPolling runs every 2 minutes in the background.',
      priority: 2,
      buttons: [{ title: '✕ Dismiss' }]
    });

    showMsg(statusEl, '✅ Test notification sent! Check your system notifications.');
  } catch (err) {
    showMsg(statusEl, `❌ Error: ${err.message}. Make sure the extension has notification permission.`, true);
  }
}

async function fetchModels() {
  if (!geminiKey) { showMsg(document.getElementById('model-status'), 'Save your Gemini API key first', true); return; }
  const btn  = document.getElementById('fetch-models-btn');
  const icon = document.getElementById('fetch-icon');
  const spin = document.getElementById('fetch-spin');
  const lbl  = document.getElementById('fetch-label');
  const st   = document.getElementById('model-status');

  btn.disabled = true; icon.classList.add('hidden'); spin.classList.remove('hidden'); lbl.textContent = 'Fetching…';

  try {
    const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${geminiKey}&pageSize=50`);
    if (!resp.ok) { const e = await resp.json().catch(()=>({})); throw new Error(e?.error?.message||`HTTP ${resp.status}`); }
    const data   = await resp.json();
    const models = (data.models || [])
      .filter(m => m.supportedGenerationMethods?.includes('generateContent') && !m.name.includes('embedding') && !m.name.includes('aqa'))
      .map(m => ({ id: m.name.replace('models/',''), name: m.displayName || m.name.replace('models/','') }))
      .sort((a,b) => {
        const rank = id => id.includes('2.5')?0:id.includes('2.0')?1:id.includes('1.5')?2:3;
        return rank(a.id) - rank(b.id) || a.id.localeCompare(b.id);
      });

    if (!models.length) throw new Error('No compatible models found');
    const RECS = ['gemini-2.5-flash','gemini-2.5-pro'];
    const sel  = document.getElementById('gemini-model');
    const cur  = sel.value;
    sel.innerHTML = models.map(m => {
      const isRec = RECS.some(r => m.id.startsWith(r));
      return `<option value="${m.id}" ${m.id===cur?'selected':''}>${m.id}${isRec?' ✦':''}</option>`;
    }).join('');
    if (![...sel.options].some(o => o.value === cur) && cur) sel.insertAdjacentHTML('afterbegin',`<option value="${cur}" selected>${cur} (saved)</option>`);
    showMsg(st, `✅ Loaded ${models.length} models`, false, 3000);
  } catch (e) {
    showMsg(st, `❌ ${e.message}`, true);
  } finally {
    btn.disabled = false; icon.classList.remove('hidden'); spin.classList.add('hidden'); lbl.textContent = 'Fetch latest models';
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// UTILITIES
// ═════════════════════════════════════════════════════════════════════════════
async function fxFetch(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Frankfurter error: ${r.status}`);
  return r.json();
}

function clamp(v, min, max) { return Math.min(Math.max(v, min), max); }

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function showMsg(el, txt, isError = false, autoHide = 0) {
  if (!el) return;
  el.textContent = txt;
  el.className   = `msg-box${isError ? ' error' : ''}`;
  if (autoHide) setTimeout(() => el.classList.add('hidden'), autoHide);
}

async function copyToClipboard(text) {
  try { await navigator.clipboard.writeText(text); }
  catch { /* fallback silently */ }
}

function timeAgo(iso) {
  const ms = Date.now() - new Date(iso).getTime();
  const m  = Math.floor(ms / 60000);
  const h  = Math.floor(m / 60);
  const d  = Math.floor(h / 24);
  if (d  > 0) return `${d}d ago`;
  if (h  > 0) return `${h}h ago`;
  if (m  > 0) return `${m}m ago`;
  return 'just now';
}

function populateSelects() {
  document.querySelectorAll('.csel').forEach(sel => {
    if (sel.id === 'alert-dir' || sel.id === 'gemini-model') return;
    const defaults = { 'from-currency':'GBP','to-currency':'INR','alert-from':'USD','alert-to':'EUR' };
    const def = defaults[sel.id] || 'USD';
    sel.innerHTML = CURRENCIES.map(c => `<option value="${c}"${c===def?' selected':''}>${c}</option>`).join('');
  });
}

function switchTab(name) {
  document.querySelectorAll('.tnav').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.id === `tab-${name}`));
  if (name === 'alerts') renderAlerts();
  if (name === 'logs')   renderLogs();
}

// ═════════════════════════════════════════════════════════════════════════════
// INIT
// ═════════════════════════════════════════════════════════════════════════════
document.addEventListener('DOMContentLoaded', async () => {
  populateSelects();
  await loadSettings();
  await renderLogs();
  showChainEmpty();

  // Sparkline + live rate on load
  refreshSparklineAndRate();
  liveTimer = setInterval(refreshSparklineAndRate, 30_000);

  // Tab navigation
  document.querySelectorAll('.tnav').forEach(btn => {
    btn.addEventListener('click', () => { if (btn.dataset.tab) switchTab(btn.dataset.tab); });
  });

  // Banner
  document.querySelector('.banner-cta')?.addEventListener('click', e => switchTab(e.target.dataset.tab));

  // Pair change
  ['from-currency','to-currency'].forEach(id => {
    document.getElementById(id)?.addEventListener('change', refreshSparklineAndRate);
  });

  // Swap
  document.getElementById('swap-btn')?.addEventListener('click', () => {
    const f = document.getElementById('from-currency');
    const t = document.getElementById('to-currency');
    const tmp = f.value; f.value = t.value; t.value = tmp;
    refreshSparklineAndRate();
  });

  // Chips
  document.querySelectorAll('.chip').forEach(c => {
    c.addEventListener('click', () => { document.getElementById('query-input').value = c.dataset.prompt; });
  });

  // Chain empty-state example clicks
  document.getElementById('chain')?.addEventListener('click', e => {
    const ex = e.target.closest('.ce-example');
    if (ex) { document.getElementById('query-input').value = ex.textContent.replace(/['"]/g,''); }
  });

  // Ask
  document.getElementById('ask-btn')?.addEventListener('click', async () => {
    if (!geminiKey) { switchTab('settings'); return; }
    const input = document.getElementById('query-input');
    const q     = input.value.trim();
    if (!q) return;
    const from = document.getElementById('from-currency').value;
    const to   = document.getElementById('to-currency').value;
    await runAgent(`[Selected pair: ${from}/${to}]\n${q}`);
  });

  document.getElementById('query-input')?.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); document.getElementById('ask-btn').click(); }
  });

  // New chat
  document.getElementById('new-chat-btn')?.addEventListener('click', clearConversation);

  // Alerts
  document.getElementById('set-alert-btn')?.addEventListener('click', handleSetAlert);

  // Logs toolbar
  document.getElementById('export-btn')?.addEventListener('click', exportLogs);
  document.getElementById('copy-all-btn')?.addEventListener('click', copyAllLogs);
  document.getElementById('clear-logs-btn')?.addEventListener('click', clearLogs);

  // Settings
  document.getElementById('save-btn')?.addEventListener('click', saveSettings);
  document.getElementById('fetch-models-btn')?.addEventListener('click', fetchModels);
  document.getElementById('test-notif-btn')?.addEventListener('click', testNotification);

  // Eye toggle
  document.querySelectorAll('.eye-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const inp = document.getElementById(btn.dataset.target);
      if (inp) inp.type = inp.type === 'password' ? 'text' : 'password';
    });
  });
});

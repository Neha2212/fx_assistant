/* ══════════════════════════════════════════════════════════════
   FX AGENT — background.js (Service Worker)
   Polls exchange rates every 2 min · dismissible notifications
   ══════════════════════════════════════════════════════════════ */

'use strict';

const ALARM_NAME    = 'fx-agent-poll';
const POLL_INTERVAL = 2; // minutes
const FRANKFURTER   = 'https://api.frankfurter.app';

// Notification ID: fxalert::<alertId>  — parseable so button clicks map back to alerts
const makeNotifId  = (alertId) => `fxalert::${alertId}`;
const parseAlertId = (notifId) => notifId.startsWith('fxalert::') ? notifId.slice(9) : null;

// ─── Lifecycle ────────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => ensureAlarm());
chrome.runtime.onStartup.addListener(() => ensureAlarm());

async function ensureAlarm() {
  const existing = await chrome.alarms.get(ALARM_NAME);
  if (!existing) {
    chrome.alarms.create(ALARM_NAME, { periodInMinutes: POLL_INTERVAL });
  }
}

// ─── Alarm → Poll ─────────────────────────────────────────────────────────────

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM_NAME) return;
  await checkAllAlerts();
});

// ─── Core Check Logic ─────────────────────────────────────────────────────────

async function checkAllAlerts() {
  const { alerts = [] } = await chrome.storage.local.get('alerts');
  if (!alerts.length) return;

  let changed = false;
  const updated = [];

  for (const alert of alerts) {
    if (alert.triggered) { updated.push(alert); continue; }

    try {
      const rate    = await fetchRate(alert.from, alert.to);
      const crossed = alert.direction === 'above'
        ? rate >= alert.target
        : rate <= alert.target;

      if (crossed) {
        await fireNotification(alert, rate, false);
        updated.push({ ...alert, triggered: true, triggeredAt: Date.now(), triggeredRate: rate });
        changed = true;
      } else {
        updated.push({ ...alert, lastChecked: Date.now(), lastRate: rate });
        changed = true;
      }
    } catch (err) {
      console.warn(`[FX Agent] Poll error ${alert.from}/${alert.to}:`, err.message);
      updated.push(alert);
    }
  }

  if (changed) await chrome.storage.local.set({ alerts: updated });
}

// ─── Notification ─────────────────────────────────────────────────────────────

async function fireNotification(alert, currentRate, immediate = false) {
  const arrow   = alert.direction === 'above' ? '↑' : '↓';
  const diff    = ((currentRate - alert.target) / alert.target * 100);
  const diffStr = `${diff >= 0 ? '+' : ''}${diff.toFixed(2)}%`;

  const title = immediate
    ? '⚡ FX Agent — Condition Already Met!'
    : '🎯 FX Agent — Rate Alert Triggered!';

  const lines = [
    `${alert.from}/${alert.to} is now ${currentRate.toFixed(4)} ${arrow}`,
    `Target: ${alert.direction === 'above' ? 'above' : 'below'} ${alert.target} (${diffStr})`,
    alert.note ? `📝 ${alert.note}` : null
  ].filter(Boolean);

  // Remove any existing notification for this alert before creating a new one
  await chrome.notifications.clear(makeNotifId(alert.id)).catch(() => {});

  await chrome.notifications.create(makeNotifId(alert.id), {
    type:    'basic',
    iconUrl: 'icons/icon48.png',
    title,
    message: lines.join('\n'),
    priority: 2,
    requireInteraction: true,
    buttons: [
      { title: '✕  Dismiss this alert' },
      { title: '📋 Open FX Agent'       }
    ]
  });
}

// ─── Notification Button Clicks ───────────────────────────────────────────────

chrome.notifications.onButtonClicked.addListener(async (notifId, buttonIndex) => {
  const alertId = parseAlertId(notifId);
  if (!alertId) return;

  if (buttonIndex === 0) {
    // "Dismiss this alert" — delete from storage and close the notification
    await removeAlert(alertId);
    await chrome.notifications.clear(notifId);
  } else if (buttonIndex === 1) {
    // "Open FX Agent" — attempt to open the popup
    chrome.notifications.clear(notifId);
    chrome.action.openPopup?.().catch(() => {});
  }
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function removeAlert(alertId) {
  const { alerts = [] } = await chrome.storage.local.get('alerts');
  await chrome.storage.local.set({ alerts: alerts.filter(a => a.id !== alertId) });
}

async function fetchRate(from, to) {
  const resp = await fetch(`${FRANKFURTER}/latest?from=${from}&to=${to}`);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const data = await resp.json();
  const rate = data.rates[to];
  if (!rate) throw new Error(`No rate for ${to}`);
  return +rate;
}

// ─── Message Listener (from popup) ────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'ENSURE_ALARM') {
    ensureAlarm().then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.type === 'CHECK_NOW') {
    checkAllAlerts().then(() => sendResponse({ ok: true }));
    return true;
  }
  // Popup asks background to fire an immediate notification (condition already met at set time)
  if (msg.type === 'FIRE_IMMEDIATE') {
    fireNotification(msg.alert, msg.rate, true).then(() => sendResponse({ ok: true }));
    return true;
  }
  // Popup asks background to remove an alert (e.g. triggered + dismissed from within popup)
  if (msg.type === 'DISMISS_ALERT') {
    removeAlert(msg.alertId)
      .then(() => chrome.notifications.clear(makeNotifId(msg.alertId)))
      .then(() => sendResponse({ ok: true }));
    return true;
  }
});

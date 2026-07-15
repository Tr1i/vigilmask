/**
 * VigilMask — Background Service Worker
 * ----------------------------------------
 * In Manifest V3, the background script is a "service worker" — it doesn't
 * run continuously like old-style background pages; it wakes up on events
 * and can be killed by the browser when idle. That's WHY the redaction
 * engine's session state should eventually be persisted to
 * chrome.storage.session (in-memory, cleared when browser closes) rather
 * than kept purely in a JS variable, if you need it to survive the
 * service worker being unloaded mid-conversation. For a v0.1 prototype,
 * keeping it in memory is fine to start.
 *
 * This file is the single source of truth for the entity map — the
 * content script (which touches the actual webpage) sends text here to
 * be redacted/rehydrated, rather than doing redaction itself. Keeping
 * the engine centralized means one map per tab/session instead of one
 * per page reload.
 */

const { RedactionEngine } = require("./redaction-engine");

// One engine per active tab, so different conversations don't leak
// entities into each other's token maps.
const engines = new Map(); // tabId -> RedactionEngine

function getEngine(tabId) {
  if (!engines.has(tabId)) {
    engines.set(tabId, new RedactionEngine());
  }
  return engines.get(tabId);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tabId = sender.tab?.id;
  const engine = getEngine(tabId);

  if (message.type === "REDACT") {
    // message.nerEntities would come from a local NER pass — see
    // ner-pipeline.js (wink-nlp) or a call to the desktop daemon.
    const redacted = engine.redact(message.text, message.nerEntities || []);
    sendResponse({ redacted });
  }

  if (message.type === "REHYDRATE") {
    const rehydrated = engine.rehydrate(message.text);
    sendResponse({ rehydrated });
  }

  if (message.type === "CLEAR_SESSION") {
    engine.clearSession();
    sendResponse({ cleared: true });
  }

  // Required for async sendResponse in Manifest V3
  return true;
});

// Clean up the engine's memory when a tab closes — don't let entity
// maps linger longer than the conversation that created them.
chrome.tabs.onRemoved.addListener((tabId) => {
  engines.delete(tabId);
});

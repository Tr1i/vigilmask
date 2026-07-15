/**
 * VigilMask — Content Script
 * ----------------------------
 * Content scripts are the only part of an extension that can directly
 * read/modify the actual webpage DOM. This is where we grab what the
 * user typed BEFORE it's sent to the LLM, and where we watch for the
 * LLM's response coming back IN the page so we can rehydrate it for
 * display.
 *
 * DESIGN CHOICE — UI-layer interception vs network interception:
 * This v0.1 rewrites the text sitting in the input box right before
 * the user hits "send", rather than intercepting the raw network
 * request. This is simpler and more transparent to the user (they can
 * literally see their prompt get redacted in the textbox), at the cost
 * of being coupled to each site's specific DOM structure. A more robust
 * v2 could use chrome.declarativeNetRequest or a MutationObserver-based
 * approach that works across arbitrary sites without per-site selectors.
 */

// NOTE: selectors below are illustrative placeholders — each target site
// (ChatGPT, Claude.ai, Gemini) has its own DOM structure and will need
// its own selector + submit-event hookup. This is the main site-specific
// maintenance burden of a UI-layer interceptor.
const INPUT_SELECTOR = "textarea, [contenteditable='true']";
const SUBMIT_BUTTON_SELECTOR = "button[data-testid='send-button']";

function getInputElement() {
  return document.querySelector(INPUT_SELECTOR);
}

async function redactBeforeSend(event) {
  const input = getInputElement();
  if (!input) return;

  const rawText = input.value ?? input.innerText;
  if (!rawText || !rawText.trim()) return;

  // Stop the original send — we'll resubmit once redaction completes.
  event.preventDefault();
  event.stopPropagation();

  // In v0.1, NER entities would come from a local wink-nlp pass run
  // right here in the content script (pure JS, no network needed).
  // Left as a stub — see roadmap Phase 1.
  const nerEntities = await runLocalNER(rawText);

  chrome.runtime.sendMessage(
    { type: "REDACT", text: rawText, nerEntities },
    (response) => {
      if (input.value !== undefined) {
        input.value = response.redacted;
      } else {
        input.innerText = response.redacted;
      }
      // Re-trigger the site's own submit handler now that the text is safe
      input.dispatchEvent(new Event("input", { bubbles: true }));
      const submitBtn = document.querySelector(SUBMIT_BUTTON_SELECTOR);
      submitBtn?.click();
    }
  );
}

// Stub for Phase 1 — will call wink-nlp's NER pipeline directly in-browser
async function runLocalNER(text) {
  return []; // placeholder until wink-nlp integration lands
}

/**
 * Watches the page for new response text appearing (the LLM's reply)
 * and rehydrates any placeholder tokens back to real values before the
 * user reads them. MutationObserver watches for DOM changes since chat
 * UIs stream text in dynamically rather than doing a page reload.
 */
function watchForResponses() {
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType === Node.TEXT_NODE || node.nodeType === Node.ELEMENT_NODE) {
          const text = node.textContent;
          if (text && text.includes("⟦")) {
            chrome.runtime.sendMessage(
              { type: "REHYDRATE", text },
              (response) => {
                node.textContent = response.rehydrated;
              }
            );
          }
        }
      }
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });
}

document.addEventListener(
  "keydown",
  (e) => {
    if (e.key === "Enter" && !e.shiftKey) redactBeforeSend(e);
  },
  true
);

watchForResponses();

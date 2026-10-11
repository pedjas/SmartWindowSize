import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("Virtual Rules Configuration surface follows Rules and uses worker-owned refresh and clear actions", async () => {
  const [html, source] = await Promise.all([readFile(new URL("../options/options.html", import.meta.url), "utf8"), readFile(new URL("../options/options.js", import.meta.url), "utf8")]);
  const virtualRenderer = source.slice(source.indexOf("async function refreshVirtualRules"), source.indexOf("/** Returns the stored local display identifier"));
  assert.ok(html.indexOf('id="rules-tab"') < html.indexOf('id="virtual-rules-tab"'));
  assert.match(source, /virtualRules: \{ panel: "virtual-rules-panel", control: "virtual-rules-tab" \}/);
  assert.match(html, /No virtual rules in this browser session\./);
  assert.match(html, /id="clear-virtual-rules"/);
  assert.match(source, /request\(\{ type: "get-virtual-rules" \}\)/);
  assert.match(source, /request\(\{ type: "clear-virtual-rules" \}\)/);
  assert.match(source, /function renderTabCount\(tabId, label, items\)/);
  assert.match(source, /renderTabCount\("virtual-rules-tab", "Virtual Rules", rules\)/);
  assert.match(source, /message\.type === "virtual-rules-changed"\) refreshVirtualRules/);
  assert.match(source, /refreshVirtualRules\(\)\.catch\(\(error\) => showClientError\("Refresh virtual rules", error\)\)/);
  assert.match(html, /id="clear-virtual-rules-top"/);
  assert.match(html, /virtual-rules-row virtual-rules-header/);
  assert.match(virtualRenderer, /className = "virtual-rules-row"/);
  assert.match(virtualRenderer, /textContent: "Domain"/);
  assert.match(virtualRenderer, /textContent: "Size"/);
  assert.doesNotMatch(virtualRenderer, /domain_tree\|\$\{rule\.domain\}/);
  assert.doesNotMatch(virtualRenderer, /className = "rule-card"/);
  assert.doesNotMatch(source, /setInterval\(/);
});

test("Rules tab count derives from the same rendered real-rule collection", async () => {
  const source = await readFile(new URL("../options/options.js", import.meta.url), "utf8");
  const renderer = source.slice(source.indexOf("function renderRules"), source.indexOf("/** Sends a granular write"));
  assert.match(renderer, /renderTabCount\("rules-tab", "Rules", config\.rules\)/);
  assert.match(source, /await refreshVirtualRules\(\);/);
});

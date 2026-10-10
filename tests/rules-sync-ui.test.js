/** Verifies Rules Sync presentation uses shared identity helpers without cluttering rule actions. */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { canonicalizeScopeValue } from "../core/rule-matcher.js";
import { originLabel } from "../core/rule-presentation.js";
import { RULE_TYPE_LABELS } from "../core/rule-types.js";


test("Rules cards show matcher-derived effective scope and keep technical sync details separate", async () => {
  const [source, styles] = await Promise.all([
    readFile(new URL("../options/options.js", import.meta.url), "utf8"),
    readFile(new URL("../options/options.css", import.meta.url), "utf8")
  ]);
  assert.match(source, /canonicalMatchKey.*from "\.\.\/core\/rule-sync\.js"/);
  assert.match(source, /scope\.textContent = RULE_TYPE_LABELS\[rule\.scope\.type\]/);
  assert.match(source, /value\.textContent = rule\.scope\.value/);
  assert.match(source, /const effectiveScope = canonicalMatchKey\(rule\.scope\)/);
  assert.match(source, /createRuleDetail\("Effective scope", effectiveScope/);
  assert.match(source, /summary\.textContent = "Sync details"/);
  assert.match(source, /refresh\.append\(materialIcon\("refresh"\), "Refresh from cloud"\)/);
  assert.match(source, /actions\.append\(toggle, remove, refresh\)/);
  assert.doesNotMatch(source, /seed\.textContent = "Set current size as synced default"/);
  assert.match(styles, /\.rule-card-value \{ margin: 0; font-size: 18px; font-weight: 700; line-height: 1;/);
  assert.match(styles, /\.rule-card h3 \{ margin: 0; font-size: 14px; font-weight: 500;/);
  assert.match(styles, /\.rule-card-header \+ \.rule-card-value \{ margin-top: -8px; \}/);
  assert.match(styles, /\.rule-card-details \{ display: grid; grid-template-columns: repeat\(auto-fit, minmax\(145px, 1fr\)\); align-items: start; gap: 8px 16px; \}/);
  assert.match(styles, /\.sync-details-grid \{ display: grid; grid-template-columns: minmax\(320px, 2fr\) repeat\(2, minmax\(150px, 1fr\)\); align-items: start; gap: 8px 16px; overflow-wrap: anywhere; \}/);
  assert.match(styles, /\.rule-card-details strong \{ white-space: pre-line; font-weight: 500; \}/);
  assert.match(styles, /\.effective-scope \{ overflow-wrap: anywhere; \}/);
  assert.match(styles, /\.effective-scope strong \{ font-weight: 500; \}/);
  assert.doesNotMatch(styles, /\.effective-scope \{[^}]*border-left/);
  assert.doesNotMatch(styles, /\.effective-scope \{[^}]*background/);
});


test("rule-detail UI keeps monitor state local and uses labelled bundled icon controls", async () => {
  const [options, popup, popupCss, html] = await Promise.all([
    readFile(new URL("../options/options.js", import.meta.url), "utf8"),
    readFile(new URL("../rule-delete/rule-delete.js", import.meta.url), "utf8"),
    readFile(new URL("../rule-delete/rule-delete.css", import.meta.url), "utf8"),
    readFile(new URL("../options/options.html", import.meta.url), "utf8")
  ]);
  assert.match(options, /createRuleDetail\("Monitor", rememberedMonitorValue\(rule\)\)/);
  assert.match(popup, /Remembered monitor: \$\{rememberedMonitorValue\(rule\)\}/);
  assert.match(popup, /aria-label", "Edit rule"/);
  assert.match(popup, /aria-label", "Delete rule"/);
  assert.match(popup, /materialIcon\("edit"\)/);
  assert.match(popup, /materialIcon\("delete"\)/);
  assert.match(popupCss, /\.icon-button \{ width: 32px/);
  assert.match(popupCss, /\.row-actions \{ align-self: start;/);
  assert.match(html, /title="Copy Client ID" aria-label="Copy Client ID"/);
});


test("Options exposes a full, copyable client identity and keeps environment data outside the event log", async () => {
  const [html, source] = await Promise.all([
    readFile(new URL("../options/options.html", import.meta.url), "utf8"),
    readFile(new URL("../options/options.js", import.meta.url), "utf8")
  ]);
  assert.match(html, /id="client-identity"/);
  assert.match(html, /id="copy-client-id"/);
  assert.match(html, /Environment \/ Sync information/);
  assert.match(source, /element\.textContent = client/);
  assert.match(source, /navigator\.clipboard\.writeText\(config\.sync\?\.clientId/);
  assert.match(source, /environment-sync-log/);
  assert.match(source, /Extension ID: \$\{sync\.extensionId \?\? "—"\}/);
  assert.match(source, /Client ID: \$\{sync\.clientId \?\? "—"\}/);
  assert.match(source, /Malformed cloud records: \$\{sync\.visibility\.malformed \?\? 0\}/);
  assert.match(source, /if \(tab === "diagnostics"\) refreshDiagnosticsWhenOpened\(\);/);
  assert.match(source, /if \(tab === "environmentSync"\) refreshDiagnosticsWhenOpened\(\);/);
  assert.match(source, /result\.skippedReason === "storage-sync-unavailable" \? "Browser sync storage is unavailable\." : "Sync is disabled\."/);
  assert.match(source, /formatClientIdForDisplay\(rule\.sync\?\.modifiedByClientId, sync\.clientId\)/);
  assert.match(source, /formatClientIdForDisplay\(rule\.sync\?\.modifiedByClientId, config\.sync\?\.clientId\)/);
});

test("all human-readable Modified by fields use the shared local-client attribution helper", async () => {
  const [options, editor, worker] = await Promise.all([
    readFile(new URL("../options/options.js", import.meta.url), "utf8"),
    readFile(new URL("../rule-delete/rule-delete.js", import.meta.url), "utf8"),
    readFile(new URL("../background/service-worker.js", import.meta.url), "utf8")
  ]);
  for (const source of [options, editor]) assert.match(source, /formatClientIdForDisplay.*core\/client-id-presentation\.js/);
  assert.match(editor, /formatClientIdForDisplay\(rule\.sync\?\.modifiedByClientId, state\.clientId\)/);
  assert.match(worker, /syncEnabled: config\.global\.syncRules, clientId: config\.sync\.clientId/);
});

test("Configuration and Set rules use the shared Rules Sync status interpretation", async () => {
  const [options, editor] = await Promise.all([
    readFile(new URL("../options/options.js", import.meta.url), "utf8"),
    readFile(new URL("../rule-delete/rule-delete.js", import.meta.url), "utf8")
  ]);
  for (const source of [options, editor]) {
    assert.match(source, /formatRuleSyncStatus, originLabel, ruleSyncStatus.*core\/rule-presentation\.js/);
    assert.match(source, /formatRuleSyncStatus\(ruleSyncStatus\(/);
    assert.doesNotMatch(source, /Local only/);
  }
});

test("all rule presentation surfaces import the shared rule-type labels", async () => {
  const [popup, options, editor] = await Promise.all([
    readFile(new URL("../popup/popup.js", import.meta.url), "utf8"),
    readFile(new URL("../options/options.js", import.meta.url), "utf8"),
    readFile(new URL("../rule-delete/rule-delete.js", import.meta.url), "utf8")
  ]);
  for (const source of [popup, options, editor]) assert.match(source, /RULE_TYPE_LABELS.*core\/rule-types\.js/);
  assert.doesNotMatch(popup, /domain_exact: "This domain only"/);
});

test("Rules cards distinguish local, legacy, and received-from-sync lineage", async () => {
  const [options, editor] = await Promise.all([
    readFile(new URL("../options/options.js", import.meta.url), "utf8"),
    readFile(new URL("../rule-delete/rule-delete.js", import.meta.url), "utf8")
  ]);
  assert.equal(originLabel("legacy"), "Migrated from previous version");
  assert.equal(originLabel("sync"), "Received from sync");
  assert.equal(originLabel("user"), "Created locally");
  for (const source of [options, editor]) assert.match(source, /originLabel.*core\/rule-presentation\.js/);
  assert.match(options, /createRuleDetail\("Origin", originLabel\(rule\.sync\?\.origin\)\)/);
  assert.match(editor, /Origin: \$\{originLabel\(rule\.sync\?\.origin\)\}/);
});

test("popup Active rule shows shared labels and only the canonical scope value", async () => {
  const [html, source] = await Promise.all([
    readFile(new URL("../popup/popup.html", import.meta.url), "utf8"),
    readFile(new URL("../popup/popup.js", import.meta.url), "utf8")
  ]);
  assert.match(html, /<fieldset id="active-rule-details" hidden><legend>Active rule<\/legend>/);
  assert.match(html, /<dt>Rule<\/dt><dd id="active-rule-type"><\/dd>/);
  assert.match(html, /<dt>Scope<\/dt><dd id="active-rule-scope"><\/dd>/);
  assert.doesNotMatch(html, /Effective scope/);
  assert.match(source, /canonicalizeScopeValue\(rule\.scope\.type, rule\.scope\.value\)/);
  assert.doesNotMatch(source, /canonicalMatchKey/);
  assert.match(source, /rememberedMonitorLabel\(rule\)/);
  assert.match(source, /currentSize\.hidden = true/);
  assert.match(source, /label\.hidden = true/);
  assert.match(source, /positionRow\.hidden = !rule\.position/);

  assert.equal(RULE_TYPE_LABELS.domain_www_pair, "Domain with and without www");
  assert.equal(canonicalizeScopeValue("domain_www_pair", "www.example.com"), "example.com");
  assert.equal(RULE_TYPE_LABELS.domain_tree, "This domain and its subdomains");
  assert.equal(canonicalizeScopeValue("domain_tree", "www.example.com"), "example.com");
  assert.equal(RULE_TYPE_LABELS.domain_exact, "Exact hostname");
  assert.equal(canonicalizeScopeValue("domain_exact", "www.example.com"), "www.example.com");
  assert.equal(canonicalizeScopeValue("url_exact_parameters", "https://example.com/path?b=two&a=one"), "https://example.com/path?a=one&b=two");
});

import test from "node:test";
import assert from "node:assert/strict";
import { createDefaultConfig, normalizeConfig } from "../core/config.js";
import { matchingRulesForUrl, resolveRule } from "../core/rule-resolver.js";
import { updateRuleDimensions, updateRuleForResize } from "../core/rule-updater.js";
import { constrainWindowBounds, displayForWindow, FALLBACK_MAXIMUM_WINDOW_SIZE, isAllowedManualSize, isWindowOnDisplay, windowUpdateInfo } from "../background/window-manager.js";
import { WINDOW_PRESETS, findHorizontalPresetIndex, orientedPresetSize } from "../core/window-presets.js";
import { windowBoundsChanged } from "../core/window-bounds.js";
import { resolveContextMenuTab } from "../core/context-menu-tab.js";
import { iconPaths, isActionActive } from "../background/action-icon.js";


/**
 * Verifies shared rule resolution and update behavior without a live browser.
 * The tests cover precedence, selected-scope isolation, and explicit disabled rules.
 */

/** Creates a compact valid rule fixture for deterministic resolver tests. @param {string} type Scope type. @param {string} value Scope value. @param {number} width Window width. @param {boolean} enabled Rule enabled state. @returns {object} Rule fixture. */
function rule(type, value, width, enabled = true) { return { id: `${type}-${value}`, scope: { type, value }, enabled, width, height: 900, position: { enabled: false, x: null, y: null }, display: { enabled: false, id: null } }; }

test("resolver uses URL coverage before exact domain and domain tree priority", () => {
  const config = createDefaultConfig();
  config.rules = [rule("domain_tree", "example.com", 1200), rule("domain_exact", "blog.example.com", 1300), rule("url_subpaths", "https://blog.example.com/news", 1400), rule("url_exact_parameters", "https://blog.example.com/news/test?id=1", 800)];
  assert.equal(resolveRule("https://blog.example.com/news/test?id=1", config).rule.width, 800);
  assert.equal(resolveRule("https://blog.example.com/news/other", config).rule.width, 1400);
  assert.equal(resolveRule("https://blog.example.com/other", config).rule.width, 1300);
  assert.equal(resolveRule("https://admin.example.com/other", config).rule.width, 1200);
});

test("legacy selected scope cannot override the resolved parent rule", () => {
  const config = createDefaultConfig(); config.rules = [rule("domain_tree", "example.com", 1200)];
  const first = updateRuleForResize(config, { url: "https://blog.example.com/news/test", selectedScope: "url_any_parameters" }, 800, 700);
  assert.equal(first.config.rules.length, 1);
  assert.equal(first.rule.scope.value, "example.com");
  assert.equal(first.config.rules.find((item) => item.scope.type === "domain_tree").width, 800);
  const second = updateRuleForResize(first.config, { url: "https://blog.example.com/news/test", selectedScope: "url_any_parameters" }, 900, 800);
  assert.equal(second.config.rules.length, 1);
  assert.equal(second.rule.width, 900);
});

test("a disabled matching rule is explicit, not a default", () => {
  const config = createDefaultConfig(); config.rules = [rule("domain_tree", "example.com", 1200, false)];
  assert.equal(resolveRule("https://example.com/a", config).status, "DISABLED");
});


test("query coverage distinguishes any, exact, and non-exact parameter rules", () => {
  const config = createDefaultConfig();
  config.rules = [
    rule("url_any_parameters", "https://example.com/report", 1000),
    rule("url_non_exact_parameters", "https://example.com/report?view=print", 1100),
    rule("url_exact_parameters", "https://example.com/report?lang=sr&view=print", 1200)
  ];
  assert.equal(resolveRule("https://example.com/report?view=print&lang=sr", config).rule.width, 1200);
  assert.equal(resolveRule("https://example.com/report?view=print&lang=en", config).rule.width, 1100);
  assert.equal(resolveRule("https://example.com/report?lang=en", config).rule.width, 1000);
});


test("domain tree uses the current hostname without public suffix inference", () => {
  const config = createDefaultConfig();
  config.rules = [rule("domain_tree", "blog.example.co.uk", 1200)];
  assert.equal(resolveRule("https://admin.blog.example.co.uk/a", config).status, "RULE");
  assert.equal(resolveRule("https://example.co.uk/a", config).status, "NONE");
});


test("a normalized www domain-tree rule covers the apex, www, and subdomains", () => {
  const config = normalizeConfig({ global: {}, rules: [rule("domain_tree", "www.example.com", 1200)] });
  assert.equal(config.rules[0].scope.value, "example.com");
  for (const url of ["https://example.com/", "https://www.example.com/", "https://foo.example.com/"]) assert.equal(resolveRule(url, config).status, "RULE");
});

test("saved monitor bounds use absolute coordinates while preserving position opt-in", () => {
  const display = { workArea: { left: -1920, top: 0, width: 1920, height: 1080 } };
  const current = { left: 120, top: 80, width: 900, height: 700 };
  const rule = { width: 1000, height: 700, position: { enabled: true, x: -1800, y: 90 } };
  assert.deepEqual(constrainWindowBounds(current, { width: 1000, height: 700 }, rule, display, true), { width: 1000, height: 700, left: -1800, top: 90, sizeAdjusted: false });
  assert.equal(constrainWindowBounds(current, { width: 1000, height: 700 }, rule, display, false).left, -1000);
});

test("www-pair scope covers only the apex and www hostname", () => {
  const config = normalizeConfig({ global: {}, rules: [rule("domain_www_pair", "www.example.com", 1200)] });
  assert.equal(config.rules[0].scope.value, "example.com");
  for (const url of ["https://example.com/", "https://www.example.com/"]) assert.equal(resolveRule(url, config).status, "RULE");
  assert.equal(resolveRule("https://catalog.example.com/", config).status, "NONE");
});


test("legacy scope types migrate into the explicit coverage model", () => {
  const config = normalizeConfig({ global: { defaultRememberType: "domain" }, rules: [rule("subdomain", "blog.example.com", 1200)] });
  assert.equal(Object.hasOwn(config.global, "defaultRememberType"), false);
  assert.equal(config.rules[0].scope.type, "domain_exact");
});


test("matching rules are listed in resolver priority order", () => {
  const config = createDefaultConfig();
  config.rules = [rule("domain_tree", "example.com", 1000), rule("domain_exact", "blog.example.com", 1100), rule("url_any_parameters", "https://blog.example.com/a", 1200)];
  assert.deepEqual(matchingRulesForUrl("https://blog.example.com/a?x=1", config).map((item) => item.width), [1200, 1100, 1000]);
});


test("manual dimensions require whole pixels within the accepted range", () => {
  assert.equal(isAllowedManualSize(320, 240, FALLBACK_MAXIMUM_WINDOW_SIZE), true);
  assert.equal(isAllowedManualSize(319, 240, FALLBACK_MAXIMUM_WINDOW_SIZE), false);
  assert.equal(isAllowedManualSize(320, 239, FALLBACK_MAXIMUM_WINDOW_SIZE), false);
  assert.equal(isAllowedManualSize(7681, 4320, FALLBACK_MAXIMUM_WINDOW_SIZE), false);
  assert.equal(isAllowedManualSize(800.5, 600, FALLBACK_MAXIMUM_WINDOW_SIZE), false);
});


test("initial window bounds establish a baseline without creating a resize change", () => {
  const initial = { width: 1200, height: 900, left: 20, top: 20 };
  assert.equal(windowBoundsChanged(undefined, initial), false);
  assert.equal(windowBoundsChanged(initial, { ...initial }), false);
  assert.equal(windowBoundsChanged(initial, { ...initial, width: 1100 }), true);
});


test("the shared default preset is available in horizontal and vertical orientations", () => {
  assert.equal(WINDOW_PRESETS[0].label, "Default · 5:4");
  assert.deepEqual(orientedPresetSize(WINDOW_PRESETS[0], false), { width: 1200, height: 960 });
  assert.deepEqual(orientedPresetSize(WINDOW_PRESETS[0], true), { width: 960, height: 1200 });
  assert.equal(findHorizontalPresetIndex(1200, 960), 0);
  assert.equal(findHorizontalPresetIndex(1111, 999), -1);
});


test("automatic bounds correction preserves a fitting size and moves only the position", () => {
  const display = { workArea: { left: 0, top: 0, width: 1920, height: 1080 } };
  const currentWindow = { left: 1000, top: 400, width: 900, height: 700 };
  const result = constrainWindowBounds(currentWindow, { width: 1200, height: 960 }, null, display);
  assert.deepEqual(result, { width: 1200, height: 960, left: 720, top: 120, sizeAdjusted: false });
});


test("saved position is corrected before a fitting size is changed", () => {
  const display = { workArea: { left: 0, top: 0, width: 1920, height: 1080 } };
  const currentWindow = { left: 10, top: 10, width: 800, height: 600 };
  const ruleWithPosition = { position: { enabled: true, x: 1800, y: 1000 } };
  const result = constrainWindowBounds(currentWindow, { width: 1200, height: 960 }, ruleWithPosition, display);
  assert.deepEqual(result, { width: 1200, height: 960, left: 720, top: 120, sizeAdjusted: false });
});


test("existing browser windows ignore a saved rule position while keeping resized bounds visible", () => {
  const display = { workArea: { left: 0, top: 0, width: 1920, height: 1080 } };
  const currentWindow = { left: 100, top: 100, width: 800, height: 600 };
  const ruleWithPosition = { position: { enabled: true, x: 1400, y: 400 } };
  const result = constrainWindowBounds(currentWindow, { width: 1200, height: 960 }, ruleWithPosition, display, false);
  assert.deepEqual(result, { width: 1200, height: 960, left: 100, top: 100, sizeAdjusted: false });
});


test("manual recovery keeps a fitting current size and minimally returns it to the screen", () => {
  const display = { workArea: { left: 0, top: 0, width: 1920, height: 1080 } };
  const currentWindow = { left: 1700, top: 800, width: 800, height: 600 };
  const result = constrainWindowBounds(currentWindow, { width: currentWindow.width, height: currentWindow.height }, null, display);
  assert.deepEqual(result, { width: 800, height: 600, left: 1120, top: 480, sizeAdjusted: false });
});


test("display selection uses the largest window overlap rather than its center point", () => {
  const displays = [
    { id: "left", isPrimary: true, workArea: { left: 0, top: 0, width: 1920, height: 1080 } },
    { id: "right", workArea: { left: 1920, top: 0, width: 1920, height: 1080 } }
  ];
  const windowInfo = { left: 1500, top: 100, width: 1000, height: 800 };
  assert.equal(displayForWindow(windowInfo, displays).id, "right");
});


test("visible-bound verification rejects a window that remains outside the selected work area", () => {
  const display = { workArea: { left: 0, top: 0, width: 1920, height: 1080 } };
  assert.equal(isWindowOnDisplay({ left: 100, top: 100, width: 800, height: 600 }, display), true);
  assert.equal(isWindowOnDisplay({ left: 1700, top: 100, width: 800, height: 600 }, display), false);
});


test("browser window updates omit internal bounds metadata", () => {
  const calculated = { width: 800, height: 600, left: 120, top: 80, sizeAdjusted: false };
  assert.deepEqual(windowUpdateInfo(calculated), { width: 800, height: 600, left: 120, top: 80 });
});


test("global or scope-disabled contexts use the inactive toolbar icon family", () => {
  assert.equal(isActionActive({ status: "DISABLED" }), false);
  assert.equal(iconPaths(isActionActive({ status: "DISABLED" }))[32], "icons/inactive-32.png");
  assert.equal(isActionActive({ status: "RULE" }), true);
  assert.equal(iconPaths(isActionActive({ status: "RULE" }))[32], "icons/active-32.png");
  assert.equal(iconPaths(true, true)[32], "icons/error-32.png");
});


test("toolbar context actions use the browser callback tab when it is available", async () => {
  const clickedTab = { id: 17, windowId: 3 };
  let queried = false;
  const result = await resolveContextMenuTab(clickedTab, async () => {
    queried = true;
    return [{ id: 99 }];
  });
  assert.equal(result, clickedTab);
  assert.equal(queried, false);
});


test("toolbar context actions recover the active tab from the last focused window", async () => {
  let queryInfo;
  const result = await resolveContextMenuTab(undefined, async (receivedQueryInfo) => {
    queryInfo = receivedQueryInfo;
    return [{ id: 22, windowId: 8 }];
  });
  assert.deepEqual(result, { id: 22, windowId: 8 });
  assert.deepEqual(queryInfo, { active: true, lastFocusedWindow: true });
});


test("oversized site rules are reduced and can persist their applied dimensions", () => {
  const display = { workArea: { left: 0, top: 0, width: 1280, height: 720 } };
  const currentWindow = { left: 100, top: 100, width: 900, height: 600 };
  const bounds = constrainWindowBounds(currentWindow, { width: 1920, height: 1080 }, null, display);
  assert.deepEqual(bounds, { width: 1280, height: 720, left: 0, top: 0, sizeAdjusted: true });
  const config = createDefaultConfig();
  config.rules = [rule("domain_tree", "example.com", 1920)];
  const update = updateRuleDimensions(config, config.rules[0].id, bounds.width, bounds.height);
  assert.equal(update.config.rules[0].width, 1280);
  assert.equal(update.config.rules[0].height, 720);
});

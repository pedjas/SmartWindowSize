SmartWindowSize
===============

Project repository: https://github.com/pedjas/SmartWindowSize

Keeps desktop browser windows visible and optionally remembers their size and
position for websites. The active tab selects the matching rule.
Loading an inactive tab does not resize its window. Each window follows its
own active tab even when another window has focus.

Behavior and controls
---------------------

* With no rule, keep the window visible by moving it first and shrinking it
  only when necessary. Automatic remembering is off by default.
* Optionally apply a global default size (initially 1200 x 960) when no rule
  matches. This does not create a website rule or modify the stored default.
* Optionally remember user size changes using This domain and its subdomains
  when no matching rule exists.
* Set rules for this site opens one dialog listing all matching rules.
  Add, Edit, and Delete are staged until Save changes; Cancel discards edits.
  Saving immediately applies the narrowest remaining rule.
  Add starts with Select rule scope… and requires an explicit choice before
  adding or saving. Edit keeps the existing scope selected. There is no
  Default rule coverage setting.
  Confirm or cancel the inner form before Save changes. Conflicting edits or
  a changed source URL are rejected; Reload rules discards staged changes and
  loads rules for the original URL. Editing captures fresh window dimensions.
  The full Source URL is always shown as ordinary text, but is not editable.
  Opening Add or Edit scrolls the complete form into view. Reload rules is in
  the footer next to the source-window focus button.
  Close and reopen the dialog if the source page navigates or closes.
  Only the first open dialog can edit; all others are completely read-only
  and refresh automatically. Focus editable dialog brings the writer to front.
  Closing it releases access; choose Enable editing in another dialog to edit.
  Configuration Delete, Import and Reset are blocked while a writer is open.
  Background size updates continue; Save still checks for conflicting changes.
* Remember position for this rule is optional and initially off.
* A manual resize saves only the narrowest matching rule. Manually set window
  size uses the same behavior, with presets, Custom dimensions, Vertical,
  Apply to current window, and Cancel. It starts with the actual window size.
  Reopening the dialog focuses the existing instance for that window.
* Bring window on screen is available from the toolbar right-click menu.
  Deliberately moving off screen is allowed and may be saved; automatic
  restoration later makes the minimum necessary correction.
* Maximized and fullscreen windows are exempt from automatic size rules.
* Extension enabled controls the entire extension. Per-site exclusions and
  Disable current rule are not current user actions.
* Configuration has Configuration, Rules, and Diagnostics tabs. Rules includes
  descriptions and fictional URL examples. Retention offers Never.
* About SmartWindowSize opens a single information dialog.
  About and Configuration include Open local README, which focuses one local
  browser tab containing this versioned installation guide.
* Toolbar icons show enabled, disabled, or error state. The main identity icon
  remains unchanged. Diagnostics stores session-local errors for copying.
  The log and toolbar warning update immediately. URLs are hidden unless debug
  is enabled. Without session storage, the log lasts for the background process.

Rule scopes, highest priority first
-----------------------------------

This URL — exact query parameters
  Same origin and path, with exactly the saved parameters and values.
This URL — non-exact query parameters
  Same origin and path, requiring saved parameters while allowing extra ones.
This URL — any parameters
  Same origin and path, regardless of query parameters.
This URL and its subpaths
  Same origin, matching the saved path or paths below it; ignores query.
This domain only
  The exact hostname, with any path.
This domain and its subdomains
  The current hostname and its descendants, with any path.

Rules coexist; the narrowest matching rule wins. Creating a narrower rule does
not delete broader rules. HTTP and HTTPS websites support rule creation.
For internal browser pages, Set rules for this site is disabled in both the
popup and toolbar context menu; normal windows still receive visibility
protection. The popup shows Current size and the user-facing active rule name.

Install from an extension repository
------------------------------------

When published, install the Chromium package from Chrome Web Store, or the
signed Firefox package from Mozilla Add-ons (AMO). No store listing is claimed
by this package.

Manual local installation
-------------------------

Chrome, Brave, Edge, Vivaldi, and compatible desktop Chromium browsers:
1. Extract the -chrome.zip archive or use install/SmartWindowSize-chrome/.
2. Open the browser extensions page and enable Developer mode.
3. Choose Load unpacked and select the folder containing manifest.json.
4. For updates, keep the same folder and reload the existing extension.
   Removing the extension deletes its browser-local rules and settings; export
   JSON before intentional removal when a backup is needed.

Firefox:
1. Open about:debugging#/runtime/this-firefox.
2. Choose Load Temporary Add-on.
3. Select manifest.json in the supplied -firefox folder.
4. Development Gecko ID: SmartWindowSize@pedjas.

Temporary Firefox installation ends when Firefox restarts. For regular use,
install a signed package. Opera requires separate verification; Safari,
mobile browsers, and Netscape are unsupported.

Configuration is stored locally and can be exported/imported as JSON. Reload
preserves this storage, while browser removal of the extension deletes it.
No server or native messaging application is required. Display-specific
features depend on available browser APIs. Browser creation precedes extension
correction, so the first window position may briefly be visible before adjustment.
Without display information, Bring attempts approximate centering and logs that
screen visibility cannot be verified. Invalid backups do not change settings;
successful imports refresh all Configuration controls. Concurrent changes are
checked before saving so newer rules are not silently overwritten.

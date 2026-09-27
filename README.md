# SmartWindowSize

Project repository: [github.com/pedjas/SmartWindowSize](https://github.com/pedjas/SmartWindowSize)

User-visible release notes: [CHANGELOG.md](CHANGELOG.md)

SmartWindowSize helps keep desktop browser windows on screen and can remember
their size and optional position for websites. It controls the outer browser
window, not the web page viewport. The active tab determines which rule applies.
Loading an inactive tab does not resize the shared window. Each window follows
its own active tab, even when that window is not focused.

This guide describes the agreed application behavior. Browser compatibility
and fixes must still be verified using the project's smoke tests.

## Default behavior

With the extension enabled and no matching rule, the window is kept visible:
its position is corrected first, and its size is reduced only if necessary.
Sizes are not remembered automatically by default.

- **Apply default size when no rule matches** optionally applies the configured
  default size. Its initial value is 1200 × 960. Applying it does not create a
  website rule or change the saved default when the screen is smaller.
- **Automatically remember sizes by domain and subdomains** optionally creates
  a **This domain and its subdomains** rule after a user changes a window that
  has no matching rule.
- Maximized and fullscreen windows are exempt from automatic resizing and
  saving. Rules are reconsidered when the window returns to normal.

## Rule scopes

A site means the URLs covered by a rule. All examples below use fictional
hostnames under `.example`.

| Scope shown in the extension | Coverage and example |
| --- | --- |
| This domain and its subdomains | A rule for `https://library.silverpine.example/books` covers every path on `library.silverpine.example` and its descendants, such as `catalog.library.silverpine.example`, but not sibling hostnames. |
| This domain only | Covers the exact hostname `library.silverpine.example` and all its paths, but not its subdomains. |
| This URL and its subpaths | `https://library.silverpine.example/guides` covers that path and `/guides/start`, but not `/guides-extra`. Query parameters are ignored. |
| This URL — any parameters | Covers the same origin and path, such as `https://library.silverpine.example/search`, with any query parameters or none. |
| This URL — exact query parameters | `https://library.silverpine.example/search?q=maps&type=atlas` requires the same parameters and values, in any order. Extra or missing parameters do not match. |
| This URL — non-exact query parameters | `https://library.silverpine.example/search?q=maps` also covers `?q=maps&page=2`, but not `?q=stars`. All saved parameters and values must remain present. |

When rules overlap, the priority from highest to lowest is:

1. This URL — exact query parameters
2. This URL — non-exact query parameters
3. This URL — any parameters
4. This URL and its subpaths
5. This domain only
6. This domain and its subdomains

A more specific rule does not delete broader rules. Domain rules start at the
current complete hostname; the extension does not infer a registrable domain
using a Public Suffix List.

## Creating and editing rules

1. Open the website and set the browser window to the size you want.
2. Open the toolbar popup or right-click menu and choose **Set rules for this site**.
3. The dialog lists all matching rules, narrowest first, with the active rule
   in bold. Choose **Add rule**, **Edit**, or the delete button.
4. Choose a scope and optionally **Remember position for this rule**. Position
   saving is off by default. The editor captures the current window dimensions.
5. Choose **Save changes** to save the complete set of changes and immediately
   apply the narrowest remaining rule. **Cancel** discards the edits.

Changes inside the dialog are staged until saved. The separate Add rule button
is hidden while the editor is open. Reopening the dialog for the same tab
focuses the existing instance.

Confirm or cancel the inner edit form before saving the dialog. Edits sample
the source window's current dimensions, and retain the existing URL coverage
when its scope type is unchanged. If the source URL or matching saved rules
change while the dialog is open, saving is rejected rather than overwriting
newer data. **Reload rules** discards staged edits and loads rules for the original URL.
Each dialog shows its full **Source URL** as ordinary text and its hostname in
the caption. The URL is not an editable field. Opening Add or Edit scrolls the
dialog so the complete form is visible. **Reload rules** is in the footer next
to the source-window focus button. After source-page navigation or closure,
close the dialog and reopen it for the new page.

Only the first open rule dialog can edit. Other dialogs are completely read-only
and refresh their saved-rule lists automatically. **Focus editable dialog** brings
the writer to front. Closing the writer (including the window X) releases editing;
an observer can then choose **Enable editing**. The writable draft is never
overwritten by a live refresh. Configuration Delete, Import and Reset are blocked
while a writable dialog is open. Background resize persistence still works, so
the conflict check on Save remains an additional safeguard.

Save refreshes the dimensions of added or edited rules from the source window;
unchanged remaining rules keep their saved dimensions.

New rules start at **Select rule scope…** and require an explicit scope choice.
An incomplete scope selection blocks adding the rule and saving the dialog;
cancel the inner form to abandon it. Edit starts with the rule's existing scope.
There is no global Default rule coverage setting.

Rules can be created for HTTP and HTTPS websites, not internal browser pages.
The general keep-visible behavior still applies to normal browser windows
without a website rule, including newly opened windows without a URL.

After a user resizes a window, the new dimensions are saved to its narrowest
matching rule. Other rules are unchanged. Without a matching rule, nothing is
saved unless automatic remembering is enabled.

## Manual window dimensions

**Manually set window size** opens a separate dialog initialized from the
target browser window's actual size. It selects a matching preset and
orientation, or **Custom** when there is no match.

The preset list includes 1200 × 960 and common display resolutions. **Vertical**
rotates the dimensions when the resulting size fits the target screen. Custom
dimensions may also be rotated. Width and Height are editable only for Custom.

The minimum size is 320 × 240 pixels; the maximum is the target display's work
area when available. **Apply to current window** changes the browser window and
closes the dialog. **Cancel** closes it without applying changes.
This is a precise alternative to resizing with the mouse and uses the same
rule-saving behavior; it does not independently turn on remembering.
Reopening the size dialog for the same window focuses its existing instance.

## Position and screen visibility

**Remember position for this rule** is a per-rule setting, not a global choice.
A deliberate user move partly off screen may be saved. The next automatic
application corrects the position only as much as needed, reducing size only
when it cannot fit.

When a site opens, navigates, or becomes active in an existing browser window,
its saved position is not restored. The window keeps its current position and
is moved only as much as necessary to remain visible after the saved size is
applied. A new browser window may restore a saved position.

**Bring window on screen** in the toolbar right-click menu explicitly performs
this correction. The resulting size and optional position are saved under the
normal rule-saving conditions. With multiple displays, the current target
display is selected by the greatest overlap.

Optional monitor remembering uses display information when supported.
Unavailable display APIs limit monitor-specific behavior. The extension acts
after the browser creates a window, so a brief initial off-screen appearance
can occur before correction.
Without display data, Bring attempts approximate centering and records that
screen visibility cannot be verified. It does not claim a verified correction.

## Popup, menus, and Configuration

The toolbar popup shows **Current size** and the user-facing name of the active
rule, without repeating its dimensions. It opens the rule and manual-size dialogs.

The toolbar right-click menu provides **Bring window on screen**,
**Set rules for this site**, **Extension enabled**, Configuration access, and
**About SmartWindowSize**. The browser may supply its own Options entry.
About opens a single dialog containing the name, version, purpose, and OK button.

Configuration has three tabs:

- **Configuration**: global enable switch, optional default size, automatic
  remembering, rule retention, monitor preference, and JSON backup/import/reset.
- **Rules**: saved rules with scope, value, size, Remember position, position as
  `x,y`, status, last update, and Delete. An empty list says **No rules defined**.
  **Rule scopes description** links to the explanations below the table.
  Editing from this general list is deferred; use the site dialog to edit.
- **Diagnostics**: session-local errors with copy and clear actions. The tab
  turns red when errors are present.

Both **Configuration** and **About SmartWindowSize** provide **Open local
README**. It opens one internal browser tab that displays the versioned
`readme.txt` shipped with the extension.

Rule retention offers 90, 180, 365, 730 days, or **Never**. Cleanup uses the
last update timestamp, not a claim that the site was last visited on that date.

Disabling the extension globally stops automatic resizing and saving and
disables window-changing actions. The toolbar icon becomes gray. When enabled,
errors use a warning icon. Configuration's heading and the extension manager
use the fixed main icon. Per-site exclusions are deferred; **Disable current
rule** is not a current user action.

## Installation and updates

Use the Chromium package for Chrome, Brave, Edge, Vivaldi, and compatible
desktop Chromium browsers. Opera needs separate verification. Firefox uses
its own package. Safari, mobile browsers, and Netscape are not supported.

For local Chromium installation:

1. Open the browser's extensions page and enable Developer mode.
2. Choose **Load unpacked** and select `install/SmartWindowSize-Chrome/`.
3. On later builds, keep using that same directory and reload the existing
   extension. Repeated removal and reinstallation is not required: removing an
   extension deletes its browser-local rules and settings. Export JSON first if
   removal is intentional and those settings must be restored.

For local Firefox testing:

1. Open `about:debugging#/runtime/this-firefox`.
2. Choose **Load Temporary Add-on** and select the manifest in
   `install/SmartWindowSize-Firefox/`.
3. The development Gecko ID is `SmartWindowSize@pedjas`. Temporary installation
   ends when Firefox restarts.

Once published, install the Chromium edition from Chrome Web Store or the
signed Firefox edition from Mozilla Add-ons. No store listing is claimed here.

## Data and project documents

Configuration stays in browser-local extension storage. JSON export/import is
available for backups. No backend service or native messaging application is
required.
The browser preserves this storage when an existing local extension is reloaded,
but deletes it when the extension is removed.
Malformed backups are rejected before changing stored settings. Import refreshes
the complete Configuration form. Concurrent settings changes are checked before
saving, and rule updates from other windows are preserved. Diagnostics updates
live and hides URLs unless debug is enabled. When session storage is unavailable,
the temporary log and window state last only for the background process lifetime.

Private project documentation defines behavior, development process, runtime
requirements, and current manual checks. The handoff is historical and
must not override those documents. Package creation is performed only when
explicitly requested, using `tools/package-extension.ps1`.

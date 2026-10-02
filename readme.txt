SmartWindowSize
===============

SmartWindowSize keeps desktop browser windows visible on screen. You can also
save a preferred window size, and optionally a position, for a website.

Project page: https://github.com/pedjas/SmartWindowSize


Getting started
---------------

Open a website, set the browser window to the size you want, then open the
SmartWindowSize toolbar popup.

Choose Set rules for this site, select the coverage you want, and choose Save
changes. The rule uses the current window size.

When that website is opened again, SmartWindowSize restores its saved size.


Configuration
-------------

Configuration contains global settings, saved rules, diagnostics, and JSON
backup and restore.


Rules Sync

Rules Sync is optional and uses your browser account's built-in sync service.
SmartWindowSize does not operate a server or require a separate account. Rule
scope and remember choices can sync, while enabled state, actual size, position,
monitor, diagnostics, and runtime state remain local to each computer.

Cloud dimensions are a starting size only for a browser receiving a new rule.
Use Set current size as synced default from the toolbar context menu on a page
with an applicable rule to update that starting size. Refresh from cloud is in
the rule's Sync details and does not replace this computer's size or placement.
Rules show an Effective scope so you can see exactly what they match.
Set rules for this site also previews the Effective scope before saving a rule.
Effective scope shows which part of addresses this rule will actually apply to.
For This domain and its subdomains, www.example.com becomes example.com because
the rule covers the base domain and its subdomains. Domain with and without www
uses the same base value but covers only those two hostnames; Exact hostname keeps www.
Paths and parameters are shown only when the selected rule type uses them.
Set rules for this site also previews the Effective scope before saving a rule.

Disable Extension enabled to stop SmartWindowSize from resizing, saving, or
moving windows. The toolbar icon becomes gray while the extension is disabled.

Automatically set window size if no rules is optional. When it is enabled,
Width and Height are applied to a newly opened window for a website that has
no saved rule. It does not create a rule.

Click Save settings after changing the size. Manual input selects Custom.
Toggling automatic sizing keeps the entered dimensions.


Rules
-----

Rules can apply to a whole domain and its subdomains, a domain with and without
www, one exact hostname, a URL and its subpaths,
or a URL with different levels of query-parameter matching.

More specific rules take priority over broader rules: exact query parameters,
non-exact query parameters, any parameters, URL and subpaths, exact hostname,
domain with and without www, then domain and its subdomains.

The Set rules for this site dialog shows every rule that matches the current
website. You can add, edit, or delete rules there. Changes are saved only when
you choose Save changes.

Remember position for this rule and Remember monitor for this rule are optional
and are off by default. Remember monitor saves the display currently used by
the rule. When the rule opens in a new browser window, SmartWindowSize uses
that display if it is available. Otherwise, it uses an available display,
preferably the primary one.

When you open or switch to a website in an existing browser window, its
current position stays unchanged. The window moves only if required to keep it
fully visible after its saved size is applied. A newly opened browser window
may restore its saved position.


Window size and visibility
--------------------------

Use Manually set window size when you need exact dimensions. Choose a preset
or Custom, enter a width and height in pixels, then apply the size.

Use Bring window on screen from the toolbar right-click menu to return the
current window to the visible desktop area. The window is moved first and is
made smaller only if it cannot fit on the screen.

Maximized and fullscreen windows are not resized automatically.


Manual installation
-------------------

For Chrome, Brave, Edge, Vivaldi, and compatible desktop Chromium browsers:

1. Extract the SmartWindowSize-Chrome-vX.Y.Z.zip file.

2. Open the browser extensions page and enable Developer mode.

3. Choose Load unpacked and select the extracted folder containing
   manifest.json.

4. To update, replace the files in the same folder and use Reload on the
   existing extension. Do not remove the extension unless you have exported a
   backup.

For Firefox:

1. Open about:debugging#/runtime/this-firefox.

2. Choose Load Temporary Add-on.

3. Extract SmartWindowSize-Firefox-vX.Y.Z.zip and select manifest.json in the
   extracted Firefox folder.

Temporary Firefox installation ends when Firefox restarts. A regular Firefox
installation requires a signed add-on from Mozilla Add-ons.


Support and privacy
-------------------

SmartWindowSize keeps its settings only in your browser. It does not send
rules, website addresses, diagnostics, window information, or personal data
outside your browser.

SmartWindowSize does not use network requests, analytics, telemetry,
advertising, a server, or a native application.

Diagnostics are local to the browser session. You can review or clear them in
the Diagnostics tab of Configuration.

For updates and release notes, see the project page and CHANGELOG.md.


License
-------

SmartWindowSize is source-available software, not OSI-approved open-source software.

The source code may be viewed, studied, and forked for development and contributions to the official project. Redistribution, rebranding, publication of modified versions as separate products, and commercial use are not permitted without prior written permission.

See LICENSE for the complete license terms.


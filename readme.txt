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


Rules
-----

Rules can apply to a whole domain, one exact domain, a URL and its subpaths,
or a URL with different levels of query-parameter matching.

More specific rules take priority over broader rules. For example, a rule for
one URL takes priority over a rule for its domain.

The Set rules for this site dialog shows every rule that matches the current
website. You can add, edit, or delete rules there. Changes are saved only when
you choose Save changes.

Remember position for this rule is optional and is off by default.

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


Configuration
-------------

Configuration contains global settings, saved rules, diagnostics, and JSON
backup and restore.

Automatically set window size if no rules is optional. When it is enabled,
Width and Height are applied to a newly opened window for a website that has
no saved rule. It does not create a rule.

Enter Width and Height or choose a preset, then click Save settings. Manual
input selects Custom. Toggling automatic sizing keeps the entered dimensions.

Disable Extension enabled to stop SmartWindowSize from resizing, saving, or
moving windows. The toolbar icon becomes gray while the extension is disabled.

Export JSON before removing the extension if you want to keep your saved
rules. Reloading an installed extension keeps its settings; removing it from
the browser deletes them.


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

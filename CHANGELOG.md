# Changelog

## Unreleased

### Fixed

- Close auxiliary dialogs when their source browser window is closed.
- Group no-rule automatic sizing controls in Configuration and disable every
  dependent control while automatic sizing is off.
- Rename persisted automatic no-rule dimensions to `automaticWidth` and
  `automaticHeight`, preserving existing users' dimensions through schema
  migration.
- Apply Configuration Width and Height immediately to a new normal window
  without a URL when automatic no-rule sizing is enabled.
- Clarify Configuration so Width and Height belong only to automatic sizing
  for new windows without a matching rule.
- Preserve manually entered Configuration dimensions when toggling automatic
  sizing; manual input selects Custom instead of retaining a stale preset.
- Map **Automatically set window size if no rules** to the global default-size
  behavior, so custom Width and Height values are applied instead of the
  previous 1200 × 960 default.
- Enable Configuration `Width` and `Height` whenever automatic no-rule window
  sizing is enabled, including when a preset is selected.
- Treat a stale **Set rules for this site** dialog as an expected visible state
  rather than adding it to Diagnostics.
- Simplified Configuration default-size labels and aligned the two dimension
  fields in one row.
- Renamed the automatic no-rule sizing option for clearer Configuration text.
- Kept the extension-manager icon neutral instead of showing the in-extension
  diagnostic flag as the browser's default extension icon.
- Treat successful Git commands with normal stderr status output as successful
  and report any existing partial release state without attempting overwrite.

### Changed

- Document per-rule monitor remembering and its unavailable-display fallback in
  the packaged user guide.
- Group the Configuration automatic no-rule sizing controls below Extension
  enabled, including the preset, Vertical, Width, and Height controls.
- Moved the **Remember monitor** setting from global Configuration to each
  individual rule, displayed its state in the rule list, and added per-rule
  enable or disable controls.
- Added `tools\\make-install.bat` as the stable launcher for the existing
  installation-package procedure.

## 1.0.2 - 2026-09-27

### Changed

- Reset the application version baseline to 1.0.1 for future version
  increments.
- Added a temporary-package dry run for the local Draft Release procedure.
- Applied the project code-documentation standard explicitly to PowerShell and
  BAT release and package scripts.
- Added a guarded local GitHub Draft Release procedure that finalizes the
  changelog, uses the existing packages, and uploads only the two ZIP assets.
- Standardized installation artifact names: stable unpacked Chrome and Firefox
  directories, plus versioned Chrome and Firefox ZIP package names.
- Replaced the crowded Rules table with readable multi-row rule cards.
- Opening or switching to a site in an existing browser window retains that
  window's position while still applying the saved size and keeping it visible.
- Reworked the packaged user guide and added an explicit local-only privacy
  statement.

### Fixed
- Allow the first GitHub Draft Release to continue when GitHub CLI explicitly
  reports that its release tag does not exist, while retaining failures for
  every other GitHub CLI error.
- Fixed a stale native exit-code check that could have rejected a successful
  package build after an expected missing GitHub Release check.
- Fixed the dry-run result variable so it cannot collide with the `-DryRun`
  switch parameter.
- Fixed release-script Git calls on repositories that require an explicit
  safe-directory setting.
- Fixed **Set rules for this site** availability in the toolbar context menu so
  it follows the current tab URL immediately.
- Reloading unchanged rules no longer asks to discard changes.

## 0.2.61 - 2026-09-27

### Added

- Initial version of Manifest V3 SmartWindowSize extension for desktop Chromium browsers, with a
  separate Firefox manifest package.


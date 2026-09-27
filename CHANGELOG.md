# Changelog

## Unreleased

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

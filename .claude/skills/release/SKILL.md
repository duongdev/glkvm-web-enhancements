---
name: release
description: Cut a versioned release of the GLKVM Web Enhancements extension — bump the version in the two places that must match, regenerate the popup screenshot, ship, push, and publish a GitHub release. Use when the user asks to release, cut a release, publish a new version, or bump the extension version (e.g. "/release", "/release 1.1.0", "release a patch").
---

# /release

Orchestrates a release for this MV3 extension. The single source of truth for the
process is the **Releasing** section of the repo's `CLAUDE.md`; this skill executes it.

## Arguments

`$ARGUMENTS` — the target version. Either an explicit semver (`1.2.0`) or a bump
level (`major` | `minor` | `patch`). If empty, read the current version from
`manifest.json` and ask the user which to cut with `AskUserQuestion`.

## Steps

1. **Resolve the version.**
   - Read current `version` from `manifest.json`.
   - From `$ARGUMENTS`: an explicit `X.Y.Z` is used verbatim (must be > current);
     a bump level increments accordingly. Validate it's clean semver.
   - Run `gh release view "v$VERSION"` — if it already exists, **stop** and report.

2. **Bump the version in BOTH places (they must stay in sync):**
   - `manifest.json` → `"version": "X.Y.Z"`
   - `popup.html` → the `.version` chip: `<span class="version">vX.Y.Z</span>`
   Mismatched versions are a release defect — verify both with a grep afterward.

3. **Regenerate the popup screenshot** (only if `popup.html` changed since the last
   release, e.g. UI tweaks or the version chip): `python3 scripts/capture-popup.py`.

4. **Validate:** `python3 -c "import json;json.load(open('manifest.json'))"` and
   `node --check content.js && node --check bridge.js && node --check popup.js`.

5. **Ship + push:** invoke the `ship` skill with `then push`. It runs polish →
   docs-revise → one commit (which includes the version bump) and pushes `main`.
   - If `/ship` halts (polish stuck / scope-drift), surface it and ask before continuing.

6. **Publish the GitHub release** on the pushed commit:
   ```bash
   gh release create "v$VERSION" --title "v$VERSION" --target main --notes "$NOTES"
   ```
   `$NOTES` summarizes **user-facing** changes since the last tag (derive from
   `git log "$(gh release view --json tagName -q .tagName)"..HEAD` when a prior
   release exists; for the first release, summarize the feature set). Markdown,
   no AI attribution.

7. **Report:** version, commit hash, release URL.

## Guardrails

- The version bump must land in the same commit `/ship` creates — bump **before** step 5.
- Never push or publish if validation (step 4) fails.
- Confirm the new tag doesn't already exist before shipping (step 1).
- Honor the repo's hard rules (no AI attribution in commit or release notes, never commit personal hosts).

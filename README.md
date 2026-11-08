# UiPath XAML Diff for GitHub (Chrome Extension)

A Chrome extension for reviewing UiPath `.xaml` changes in GitHub Pull Requests as a **readable activity outline** instead of raw XML.

For example, a 222-line XML diff of `Main.xaml` (full of ViewState, HintSize and IdRef noise) becomes 17 lines like this:

```
+ Assign "Assign stepStartTime"
+     To = stepStartTime
+     Value = Now
+ InvokeWorkflowFile "Invoke GenerateCsv workflow"
+     // IDM CSV is generated from dt_masterEmployee ...
+     WorkflowFileName = "Framework\GenerateCsv.xaml"
+     Arguments:
+         in in_config = Config
+         out out_csvPath = csvPath
```

## Features

- A floating **XAML Diff** button on every GitHub Pull Request page.
- **Studio mode (default):** a layout modeled on the UiPath Studio 21.10 designer.
  - **Center canvas:** a single column with arrows between activities. Each box shows the input fields for its activity type: Assign `To = Value`, Multiple Assign, Log Message (Log Level + Message), Invoke Workflow File (file name + *Import Arguments*), If (Condition + Then/Else side by side), For Each, Read/Write Range, Read/Write Text File, Deserialize JSON, Add Data Row, and more.
  - Shows the **AFTER** version by default. Deleted activities stay in their original position as red ghost boxes (DELETED).
  - Changed fields are highlighted yellow, with the old value struck through below (`WAS`).
  - A **Before | After** toggle at the bottom flips versions while keeping the scroll position and the selected activity.
  - Containers that are unchanged or deeply nested show *"Double-click to view"* with a change-count chip. **Double-click** opens that container as the canvas root, and a **breadcrumb** at the top takes you back up. **Expand All / Collapse All** are also available.
  - **Outline** (left): an activity tree with markers (● new, ◐ changed, ✕ deleted, ↕ moved) and an *Only changed* filter. Click an item to jump to its activity.
  - **Properties** (right): grouped into Common / Input / Output / Misc, showing Before (red) → After (green).
  - **Variables · Arguments · Imports** (bottom): a variable diff for the selected activity's scope (or all scopes), plus the workflow arguments and namespaces. Zoom ranges from 50% to 100%.
  - **◀ Prev change / Next change ▶** navigation.
  - The **Outline** and **Properties** panels collapse into vertical strips with the « / » button in the panel title. Click a strip to reopen it; the state is remembered. Click the active bottom tab again to close the bottom panel.
- **Side-by-side mode:** Before and After next to each other.
  - Activities render as nested boxes: Sequence, If (Then/Else branches side by side), ForEach Body, Try/Catch, and so on.
  - Per-activity diff, matched by `IdRef` with a type + DisplayName fallback:
    **NEW** (green), **DELETED** (red, struck through), **CHANGED** (yellow), **MOVED** (blue).
  - Clicking an activity highlights its counterpart on the other side and scrolls to it. The **Properties** panel on the right shows Before → After, marks changed properties with ●, and has an "Only changed properties" filter.
  - **◀ Prev change / Next change ▶** jumps between changes on both sides.
  - *Changes only* collapses unchanged containers and shows only the header of unchanged activities. *Full outline* expands everything.
- **Text mode:** a line-based text outline with a +/− diff. The selected mode (Studio / Side-by-side / Text) is remembered.
  - Each activity is listed with its type, DisplayName, annotation (`// ...`), variables, arguments and expressions.
  - Designer noise is stripped: ViewState, HintSize, IdRef, namespace/assembly lists, xmlns and `{x:Null}`.
  - Line diff (+ green / − red), with inline highlighting of the changed part of modified lines.
  - **Changes only** (3 lines of context) or **Full outline**.
  - Files with only layout/designer changes are marked *No logical change*.
  - Added, removed and renamed files are supported. Non-XAML files are listed but not rendered.
- **Compare two local files:** click the extension icon on any page that is not a PR, then pick a Before and an After file. If you pick only one file, its outline is shown.

## Installation (Load unpacked)

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select this folder (`uipath-xaml-diff`).
4. (Optional) Pin the extension to the toolbar.

After changing files in this folder, click the **reload** button (↻) on the extension card in `chrome://extensions`.

## GitHub token (required for private repositories)

1. Create a **fine-grained personal access token**: GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens.
   - Repository access: only the repositories you want to review.
   - Permissions: **Contents: Read-only** and **Pull requests: Read-only**.
2. Open the extension **Options** (right-click the icon → Options, or use the "Options" link in the viewer), paste the token, click **Test token**, then **Save**.

The token is stored only in this browser (`chrome.storage.local`) and is sent only to `api.github.com`. Public repositories work without a token, but are limited to 60 requests per hour.

## Usage

1. Open a Pull Request on GitHub.
2. Click the orange **XAML Diff** button in the bottom right, or click the extension icon in the toolbar.
3. A new tab opens with a readable diff of every `.xaml` file in the PR. Click a file header to collapse or expand it.

## How it works

- The extension does not scrape GitHub's page. The button only looks at the URL (`/owner/repo/pull/N`), so it keeps working when GitHub changes its layout.
- The viewer fetches data through the GitHub REST API:
  - `GET /repos/{o}/{r}/pulls/{n}`: base and head commits
  - `GET /repos/{o}/{r}/pulls/{n}/files`: list of changed files
  - `GET /repos/{o}/{r}/contents/{path}?ref={sha}`: file contents at the base and head commits
- XAML is parsed with `DOMParser` → outline (`lib/xaml-outline.js`) → line-based LCS diff (`lib/diff.js`).

## Project structure

```
manifest.json        Manifest V3
background.js        Opens the viewer tab (from the button / toolbar icon)
content.js/.css      "XAML Diff" button on GitHub PR pages
viewer.html/.js/.css Diff page (PR mode and local compare)
options.html/.js     Save / test the GitHub token
lib/xaml-outline.js  XAML -> outline (also usable in Node with @xmldom/xmldom)
lib/diff.js          Line diff, hunks, inline highlighting (Text mode)
lib/xaml-tree.js     XAML -> activity tree + per-activity diff (visual modes)
studio.js/.css       Studio-style layout (default mode)
visual.js/.css       Side-by-side renderer + Properties panel
```

## Limitations

- Studio and Side-by-side modes render Sequence/If/Loop/TryCatch like the designer. **Flowcharts and State Machines are not drawn as diagrams yet**: their nodes appear as stacked boxes, without arrows or positions.
- Icons and styling are custom-made (not UiPath assets), so the look is similar to Studio but not identical. Everything is read-only (the Open Workflow button is disabled).
- In Text mode, a moved activity appears as a deletion plus an addition. Studio and Side-by-side modes detect it as MOVED.
- Up to 3000 files per PR (GitHub API limit).

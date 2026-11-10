# Native tester acceptance evidence

Initial native pass used the integrated Toolbelt Plugin Tester build, copied outside all
source checkouts into a disposable directory. HOME and tester profile were isolated;
PID 76822/debug port 47831 were owned by this test and closed afterward. No installed
Toolbelt or real user data was changed.

Processes evaluation package: architecture2-309ac87, SHA-256
`0e846395b9001200c6783b7f7f987ebacc664f288c5b5eb66d35f6eda2653ff0`.
Observed production rendering:

- Process table groups, nested folders, aggregate memory, agent tags/status and package
  SVG icons, app/Finder icons rendered in the native WKWebView.
- Native CmdK/CmdP/CmdS selected Kept/Processes/Settings; slash focused search, native
  typing produced a no-match result, clearing restored rows.
- Kept empty state and Add dialog showed command/folder/note/environment editors; no
  save/start action occurred. Settings showed engine/TUI versions and paths under the
  temporary managed profile.
- Read-only row selection opened the details inspector. Simulated quick view rendered
  plugin content. Native popover loaded the same production quick-view content.

Acceptance defects reported to host owner before final acceptance:

- Fixed Sidebar escaped tester frame and covered archive toolbar. Host fix pending retest.
- Native quick view remained at list height (145px) because null height request was ignored.
- Native CmdA in search failed to select all; tester lacks standard native Edit menu.

Screenshot evidence retained locally under temporary Orca screenshot storage and copied
into ignored artifacts during final handoff as needed. These are partial observations,
not a claim that themes/narrow/zoom/motion/native positioning passed. Final fixed tester
retest remains required. No action stopped, restarted, focused or typed into a user job.

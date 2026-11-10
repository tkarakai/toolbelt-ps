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

## Final runtime candidate on integrated Tester8

Candidate: `architecture2-582cd7a`, source
`582cd7a0a15a6814eb8597006e069c1de3c5a749`, archive SHA-256
`20029917a8c6f4d0406757d0b012cb8f46eb509df8d2860ca97f0b135e44df51`.
Tester copied outside checkouts, HOME/profile isolated; native runtime PID 70157 was
closed afterward. Self-extractor parent PIDs 70016/76699 were separately verified against
owned temporary paths and cleaned. Final distribution uses the extracted real app.

Passed through actual production WKWebView/native keyboard:

- Copied v1 kept fixture rendered with its name, command, note and environment. Native
  E opened Edit, fake secret remained a password field. CmdA selected the whole note;
  typing/Save persisted the edited disposable note. No command was started.
- X opened the explicit Forget confirmation. Confirming removed only the fixture;
  toast Undo restored it.
- Settings Install displayed an explicit machine-change confirmation, wrote only the
  temp HOME's wrapper/zsh hook, and the wrapper resolved registry.json stably. Remove
  displayed a separate confirmation and removed those marked temp-home additions.
- CmdK/P/S tabs, slash/search, selected-row inspector, package agent/Finder assets and
  simulated quick view passed across the combined native passes.
- Native Processes quick view resized to 380×520 from the two-plugin 380×197 list.
  Escape returned to the list; another Escape hid the panel. Shared native blur also
  hid it after activating the main tester window.
- Production Settings CmdComma worked; dark Nord palette applied. Native page zoom
  changed root font 16→17.6→16 px; reduced motion forced transition duration to zero.

Screenshots retained locally in ignored `artifacts/native/`: final-kept-fixture.png,
initial-tester-layout-defect.png. No screenshot was published remotely.

Initial Sidebar/popover-height/Edit-menu defects were corrected by the host owner and
retested successfully. Actual 414px native window had no root/body horizontal overflow.
Final narrow decorated-text and profile isolation/restore checks are recorded separately
when the final real-app snapshot is exercised.

## Final signed real Tester10 targeted checks

The real `.app` was copied outside the checkout and launched directly, then through
Launch Services. No self-extractor installer window was involved. Original profile
`final-ps-demo` and new `isolation-probe` used the same temporary HOME but different roots.
The new profile had default light appearance/counter zero/default screen and no original
renderer marker. Reopening the original profile restored its dark Nord appearance,
counter one and the actually persisted `PROFILE_ONE_ONLY_MARKER` search. Thus both managed
plugin data and namespaced renderer state stayed isolated and survived restart.

At an actual 414px native viewport, document/body widths were 414px. The host's corrected
primary-cell text had a measured 75px `Declarative ` text span instead of disappearing
behind supplemental decorations. This is DOM/layout evidence, not a final screenshot.
Exact signed Tester10 native capture was blocked: Orca reported visible windows but no AX
window despite granted Accessibility/Screen Recording; direct capture and alternative CUA
capture also failed. Earlier Tester8 native screenshots/keyboard/tray observations remain
valid; no exact-10 screenshot is claimed. The default 1000px embedded frame is below the
inspector's container breakpoint after sidebar width, so visible wide-inspector acceptance
is not claimed from mere presence of its hidden DOM. The 414px inspector hides correctly.

Owned real tester PIDs 32436, 42031 and 43455 were closed through explicit Quit confirmation;
checks found no remaining owned Bun/launcher processes. No real user job was modified.

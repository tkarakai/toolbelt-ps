# Production renderer browser acceptance

The remaining visible-inspector/tool-detail/narrow-layout checks passed in Chrome using
Toolbelt's production renderer. Source was staged from Toolbelt `892f5cc` into a disposable
copy, with the host owner's authorized latest App/Render/boundary/icon files. Its own Vite
build and preview server used port 5191 and an isolated HOME/config root. Parent checkout,
shared dist, installed apps and real dotfiles were untouched.

SDK4 runtime candidates:

| Package | Source | Archive SHA-256 |
| --- | --- | --- |
| Processes `architecture2-793142c` | `793142c849fd3281db67030d147c311f5907f457` | `04194342a9da8ddccc172d3d52bcb845c80209bac2fd2f32d7e4a47ea3a5465a` |
| SDK Explorer `architecture2-c89e2e9` | `c89e2e9926d8bbb1c677209081b2874d1c034248` | `e6d9e8694c8713f6737b30e8f1550776ad695c6321a429c1e0bf0f5a008e30d0` |

Both real archives were staged, initialized/probed and activated through production
PackageManager/PluginHost. Processes used the copied v1 kept/name/note/environment fixture.
No fixture command was started. No real process/terminal action was exercised.

At 1440×1000, Processes' selected kept row displayed the actual 340px inspector (`display:
flex`), with command/directory/note, masked fake secret, state/time and grouped actions.
SDK Explorer's inspector displayed its 340px drawer with sample statistic/trend, sectioned
identity/assets details and action groups. Both had zero root horizontal overflow. The
conversation tool row was expanded and visibly showed `Input: demo.json` and
`Output: {"safe": true}` in its readable detail panel.

The check found and reported a shared narrow overflow (414px viewport, 775px document)
from unconstrained header tabs/action groups. After the host's generic fix, Chrome CSS
viewport, visual viewport, document and body all measured 414px. All four toolbar actions
wrapped inside the viewport; horizontally scrolling the tab strip brought Lifecycle fully
into view (x249–388) without growing the document. The decorated primary label remained
readable; optional decoration was suppressed appropriately. The 340px inspector correctly
hid at this narrow container width.

Processes' real Edit dialog at 414×896 measured x16/width382/height762, with all fields and
masked fake secret visible and no document overflow. Escape closed it without saving.
SDK4's harmless optional native-handoff counter scenario also displayed its supported
label, incremented the counter and emitted the expected toast; no terminal focus occurred.

Screenshots were opened and visually inspected, retained locally in ignored artifacts:

- Processes: `artifacts/native/browser-wide-kept-inspector.png`,
  `artifacts/native/browser-414-kept-edit.png`.
- SDK Explorer: `artifacts/native/browser-wide-demo-inspector.png`,
  `artifacts/native/browser-expanded-tool-detail.png`,
  `artifacts/native/browser-414-final.png`.

The browser proof closes the visible-inspector/tool-detail/narrow geometry limits in the
earlier native evidence. It does not claim that the signed native tester's AX capture
limitation disappeared. Preview tab/session and own preview PID76368 were closed; port5191
and its owned plugin processes were stopped. Screenshots were not published remotely.

Tested UI source SHA-256 (so coordinator can match final host integration):

- App.tsx: `c1947ec25d1764851e76ebf7e0f16119fbb54a17f3c24df1786c7ad93bc0a97f`
- Render.tsx: `dc55cb93f08e66ff31f47f0087c243f410fe6a5a2f32038a1a4537a4f8da94bc`
- SafeRender.tsx: `0823daadd10a5fd511950829f675147707d0eedb9d51b5d10482623f403a785e`
- Boundary.tsx: `b19ba861eae6f871152ac2a38ec385126c7be9ec0e2216a52cbab0c3f5cfe780`
- icon.tsx: `004bf282253fedcb263945970b4ad0142c459dbc6278cd9f8041d31c01be7dff`

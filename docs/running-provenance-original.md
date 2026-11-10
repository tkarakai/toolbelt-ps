# Running provenance

The complete engine and TUI in `src/running` originated in tkarakai/running commit
`c9d55727a7b38b4738b31608b8480c1eccebf8d0` (v0.8.0), authored by Tamas Karakai.
Toolbelt's maintained patches were extracted from tkarakai/toolbelt commit
`229bd64b20599f621589e03e17d36ee72c604ff5`, including GUI-hosted agent detection,
noninteractive shell jobs, agent environment differences, CMUX workspace/surface
metadata and navigation. Original README and CHANGELOG remain alongside the code.
The original repository supplied no LICENSE file; no new license grant is implied.

This is now owned implementation of toolbelt-ps. There is no source refresh procedure
or build/runtime dependency on a legacy Running checkout.

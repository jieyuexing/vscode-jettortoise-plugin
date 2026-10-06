# JetTortoise VCS UI

`packages/vcs-ui` is the browser-only presentation layer shared by the Git and
CVS adapters inside JetTortoise. Both consumers import this source directly in
one Vite build. Cross-repository snapshot synchronization has been retired;
there is no vendor copy or runtime dependency on the former JetCVS repository.

## Interface

- `VcsRevision` describes a displayable history record. `revisionId` is an
  opaque VCS revision identifier; it is never assumed to be a Git hash.
- `VcsCapabilities` tells a consumer which actions it can expose. The UI never
  executes a VCS operation itself.
- `VcsHistoryLayout` composes commit, navigation, history and detail slots in
  that order. Consumers supply controlled `layout` / `onLayoutChange` state
  and localized labels. `readVcsLayoutState` validates saved preferences.
  Initial auxiliary widths are 280 / 180 / 280 px; history grows from 320 px.
  Narrow containers temporarily hide detail then navigation, preserving a
  focused pane and user preferences. All slots stay mounted when collapsed.
- `layoutRef.revealCommit()` expands the first column and focuses its textarea
  (or the pane if no editor is present). Consumers first select their Commit
  subtab if needed. Mouse and keyboard separators report only user changes.
- `VcsCommitLayout` composes the supplied toolbar and content. Neither layout
  imports stores, bridges, or backend services. The consumer owns one webview
  state writer and partitions history, layout and any existing draft strategy.
- `VcsContextMenu` renders capability-filtered actions and reports an item id
  to the consumer.
- `VcsFileTree`, `Tooltip`, and `RevisionInfo` are pure React components.

The package may import React and the existing browser-only `allotment` layout
dependency. It must not import Node APIs, VS Code APIs, Git services,
extension bridges, or VCS command implementations.

## License and attribution

This source is part of JetTortoise and is licensed under the included
[MIT License](./LICENSE); retained upstream copyright notices apply.
IntelliJ IDEA icon assets remain attributed under Apache-2.0 as documented in
the repository README. This directory contains original shared presentation
code and does not copy IntelliJ Platform source.

# CVS import provenance

The CVS CLI core and strict webview protocol were migrated from the local JetCVS implementation into `src/cvs/` for the JetTortoise consolidation. The original JetCVS repository remains unchanged. The migrated core retains array-based `cvs -f` execution, cancellation and output limits, CVS metadata validation, root/path/revision validation, symlink boundary checks, and redacted process errors.

The CVS webview is a consumer of the canonical `packages/vcs-ui` source. It has no vendor snapshot and does not create a separate React root. The enclosing JetTortoise Host owns registry, URI provider, commands, serializers and final package identity.

Source provenance at migration: `vscode-jetcvs-plugin/src/cvs.mjs` SHA-256 `b13325a19647149ba3672016c948c48794bc6b11711d193354e74963ebab3042`; `src/protocol.mjs` SHA-256 `4b297d6513d1a210758448e04c3ccf84c6f071fcdbe613f04137ce53d60a6034`.

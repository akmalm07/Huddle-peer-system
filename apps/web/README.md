# Huddle web reference

This installable PWA is a small reference surface for the reusable Huddle SDK.
It intentionally does not create accounts, keys, or message content while
`docs/ADR-001-E2EE-LIBRARY-EVALUATION.md` remains unapproved.

The service worker caches only public application-shell assets. It does not
cache chat history, tokens, keys, SDP, ICE, or encrypted envelopes.

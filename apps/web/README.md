# Huddle web reference

This installable PWA is the browser vertical slice for Huddle. It authenticates
through the passkey authorization API, keeps Firebase Auth in memory, creates a
non-exportable device key in IndexedDB, and encrypts messages before sending
them over WebRTC. See [the deployment guide](../../docs/DEPLOYMENT.md).

The service worker caches only public application-shell assets. It does not
cache chat history, tokens, keys, SDP, ICE, or encrypted envelopes.

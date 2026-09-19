# WebRTC peer-connection prototype

`@huddle/webrtc` owns the browser `RTCPeerConnection` lifecycle. It creates an
offer/data channel, consumes answers and ICE candidates, bounds outbound and
inbound frames at 64 KiB, and closes malformed channels. `@huddle/firebase-web`
implements its `WebRtcSignaler` interface using the authorized, expiring RTDB
path `signaling/{huddleId}/{recipientDeviceId}`.

The browser integration sequence is:

1. Obtain an in-memory Firebase session token from the authorization API.
2. Check both device records, revocation status, membership, epoch, and mesh
   capacity through the API before creating the route.
3. Create a `FirebaseRtdbWebRtcSignaler`, subscribe to it, then create a
   `WebRtcPeer` with the configured STUN/TURN URLs.
4. The initiating peer calls `offer()`; the receiving peer passes every incoming
   signal to `receive()`.
5. Before `send()`, encrypt a protocol envelope with
   `StaticWebCryptoE2eeProvider`; on receipt, validate, decrypt, deduplicate,
   and ACK it.

RTDB only stores the short-lived SDP/ICE coordination record. It does not relay
the resulting data channel or carry plaintext chat content. A production
Firebase configuration must use the committed Rules and a custom-token auth
flow; the repository does not ship a Firebase project or credentials.

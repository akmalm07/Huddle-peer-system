# Headless control-plane demo

From the repository root:

```powershell
npm install
npm run demo:headless
```

It creates two accounts and independent devices, creates a huddle, authorizes a
bounded non-content connection hint, and delivers it to the intended device.
It does **not** send chat text: message content remains blocked by the E2EE ADR.

Set public STUN/TURN relay addresses with `HUDDLE_ICE_SERVERS` as JSON:

```powershell
$env:HUDDLE_ICE_SERVERS='[{"urls":["stun:stun.example.test:3478"]},{"urls":["turns:turn.example.test:5349"]}]'
npm run demo:headless
```

Do not put a static TURN username or password in this variable. The future auth
API must mint short-lived TURN credentials after user and device authorization.

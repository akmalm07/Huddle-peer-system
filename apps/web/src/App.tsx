import "./style/app.css";

const statusItems = [
  ["PWA shell", "Installed-capable; the service worker caches only the public app shell."],
  ["Devices & huddles", "The reusable SDK now models independent devices, revocation, membership, and huddle epochs."],
  ["Coordination", "Bounded, expiring test-event signaling is designed for Firebase Realtime Database; it never logs SDP or ICE."],
  ["Messaging", "The crypto and WebRTC packages are ready; the browser chat UI is the remaining integration step."],
] as const;

export default function App() {
  return (
    <main>
      <p className="eyebrow">Huddle · local-first messaging prototype</p>
      <h1>Control plane foundation.</h1>
      <p className="summary">
        Huddle is a reusable messaging-system reference, not a consumer messenger. The
        account, device, huddle, and coordination boundaries are ready for integration;
        the reference UI intentionally does not yet expose live chat controls.
      </p>
      <section aria-label="Foundation status">
        {statusItems.map(([name, description]) => (
          <article key={name}>
            <h2>{name}</h2>
            <p>{description}</p>
          </article>
        ))}
      </section>
    </main>
  );
}

// Task-2 baseline helper: serves a minimal "console-side" opener page on a loopback origin so a
// real window.opener -> postMessage pairing handshake can run against the demo Stage.
// Read-only wrt product code; serves exactly one HTML page with a real-gesture button that
// window.open()s the Stage URL given as ?stage=<url>, and a message listener that records the
// display-join handshake (kept in-memory; the driver reads field names only).
import { serve } from "bun";

const html = `<!doctype html><meta charset="utf-8"><title>task2 opener stand-in</title>
<body>
<p>opener stand-in — plays the console side of the Stage opener handshake</p>
<button id="open" type="button">open stage</button>
<pre id="status">waiting</pre>
<script>
  window.__joins = [];
  window.addEventListener("message", (event) => {
    if (event.data && event.data.kind === "impromptu:display-join") {
      window.__joins.push(event.data.join);
      document.getElementById("status").textContent = "join-received fields=" +
        Object.keys(event.data.join).sort().join(",");
    }
    if (event.data && event.data.kind === "impromptu:display-bound-echo") {
      document.getElementById("status").textContent = "bound-echo";
    }
  });
  document.getElementById("open").addEventListener("click", () => {
    const target = new URLSearchParams(location.search).get("stage");
    window.__opened = window.open(target, "impromptu-stage", "popup");
    document.getElementById("status").textContent =
      window.__opened === null ? "popup-blocked" : "opened";
  });
</script></body>`;

serve({
  port: Number(process.env.OPENER_PORT ?? 4199),
  hostname: "127.0.0.1",
  fetch() {
    return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
  },
});
console.log(`opener-server listening on http://127.0.0.1:${process.env.OPENER_PORT ?? 4199}`);

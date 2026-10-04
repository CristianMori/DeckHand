// Codex hook relay: forwards the hook's stdin JSON to the hub and answers with
// JSON on stdout as Codex requires. Normally the hub answers 204 and the relay
// prints "{}"; when the hub has something to say (fleet etiquette warnings),
// its JSON body is passed through verbatim. usage: node codex-hook.mjs <port> <event>
const [port, event] = process.argv.slice(2);
let body = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (body += c));
process.stdin.on('end', async () => {
  let out = '{}';
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/hook?event=${encodeURIComponent(event)}&agent=codex`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(3000),
    });
    if (res.status === 200) {
      const text = await res.text();
      if (text.trim().startsWith('{')) out = text;
    }
  } catch {
    /* hub down — never fail the agent's turn over telemetry */
  }
  process.stdout.write(out);
});

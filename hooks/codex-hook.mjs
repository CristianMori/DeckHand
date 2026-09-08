// Codex hook relay: forwards the hook's stdin JSON to the hub and answers with
// the empty JSON object Codex expects on stdout. usage: node codex-hook.mjs <port> <event>
const [port, event] = process.argv.slice(2);
let body = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (body += c));
process.stdin.on('end', async () => {
  try {
    await fetch(`http://127.0.0.1:${port}/api/hook?event=${encodeURIComponent(event)}&agent=codex`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(3000),
    });
  } catch {
    /* hub down — never fail the agent's turn over telemetry */
  }
  process.stdout.write('{}');
});

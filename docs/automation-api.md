# Deckhand automation API — briefing for an agent

You are talking to **Deckhand**, a self-hosted fleet controller that owns
coding-agent sessions (Claude Code and OpenAI Codex CLI) on several machines.
Every session is a real interactive TUI running in a pseudo-terminal that the
hub owns. This document is everything you need to open sessions, send them
prompts, read replies and drive them programmatically over plain HTTP.

Requires hub build **74 or newer** (LAN access + beacon; the REST routes themselves need 71) (`GET /api/hub-info` → `build`).

## 1. Finding and reaching the hub

- Each machine runs one hub as a service on port **5959** (it walks up to
  5969 if 5959 is taken). From the machine itself: `http://127.0.0.1:5959`.
- Over the tailnet the same port on the machine's tailscale IP or MagicDNS
  name works.
- **Authentication depends on where you call from:**
  - localhost or the tailnet (`100.64.0.0/10`, `fd7a:115c:a1e0::/48`): none.
  - the private LAN (`10/8`, `172.16/12`, `192.168/16`): send
    `Authorization: Bearer <token>` on every request. The token is the
    contents of `data/api-token` on the hub's machine (ask the owner for
    it). Missing/wrong → **401**. For WebSockets the same header works, or
    `?token=` on the URL.
  - anywhere else: **403**, token or not. Do not try to expose it further.
- **Any hub can act on any session.** Per-session routes are forwarded to the
  machine that owns the session; spawn requests take a `machine` field. Use
  whichever hub is closest.
- **Discovery:** there is no registry. If you were not given a URL:
  1. Try `http://127.0.0.1:{5959..5969}/api/hub-info`; take the first that
     answers `{"hub":"deckhand",...}` (what the `deckhand` CLI does).
  2. On the LAN, send the UDP datagram `DECKHAND?` to port **5959** at the
     LAN's directed broadcast address (e.g. `192.168.1.255` — compute it from
     your interface's address and netmask; `255.255.255.255` alone is
     unreliable on Windows). Every hub replies within ~50 ms with JSON:
     `{"hub":"deckhand","machine":"thelaptop","build":74,"port":5959,
       "urls":["http://192.168.1.253:5959"],"auth":"token",...}`.
     Hubs also announce that JSON unprompted every 30 s to the same port.
  3. On the tailnet, probe each online device (`tailscale status --json` →
     `Peer[*].TailscaleIPs`) on 5959–5969 as in step 1.

  Once you have any one hub, `GET /api/fleet` →
  `[{"machine","self","connected","url"}]` gives you every other machine
  and its URL, and you never need to probe again.
- Probe response: `GET /api/hub-info` → `{"hub":"deckhand","machine":"thelaptop","build":74,...}`.

All request bodies are JSON (`Content-Type: application/json`). All responses
are JSON except `screen` and `export`. Errors are `{"error": "..."}` with a
4xx/5xx status.

## 2. Mental model

- A **session** is one running (or exited-but-resumable) agent TUI in one
  project folder on one machine. It is identified by a short **`hubId`**
  (e.g. `3724583a`). The agent's own conversation id is `claudeSessionId`
  (the field is named that for both engines).
- A session has a **state**:

  | state | meaning |
  |---|---|
  | `STARTING` | process launched, no turn seen yet (also: a startup prompt is on screen) |
  | `WORKING` | the agent is executing a turn |
  | `IDLE` | turn finished, composer is empty and waiting for you |
  | `WAITING_PERMISSION` | the agent asks to run a tool / edit a file |
  | `WAITING_QUESTION` | the agent asked the user a question (menu) |
  | `EXITED` | process gone; resumable |

  "**Settled**" = any state except `STARTING` and `WORKING`.

- **Prompts are typed into the TUI, replies are read from the transcript.**
  The `reply` field in responses is the agent's final text for that prompt,
  parsed from its on-disk conversation log. Tool calls and intermediate
  output are not included — use `screen` if you need to see them.
- **Engines** (`agentType`): `claude` (Claude Code) and `codex` (OpenAI Codex
  CLI). `GET /api/agents` (add `?machine=` for another machine) tells you
  which are installed there, plus their `models` and `permissionModes`.

## 3. Endpoints

### Create a session — `POST /api/sessions`

```json
{
  "cwd": "C:\\DataDrive\\myproject",      // absolute folder on the target machine, OR:
  "newFolder": "myproject",               // create <projectsRoot>/myproject instead of cwd
  "agentType": "claude",                  // default "claude"
  "name": "nightly-refactor",             // card name (optional)
  "model": "opus",                        // engine-specific, see /api/agents
  "permissionMode": "acceptEdits",        // engine-specific, see /api/agents
  "initialPrompt": "Summarize the README in one sentence.",
  "machine": "desktop-master",            // run there; omit = this hub's machine
  "wait": 120000,                         // true or ms — block until the first turn settles
  "force": false                          // override the "folder is live elsewhere" guard
}
```

Response: the session object (see §4), plus `machine`. With `wait` it also
carries `timedOut` and `reply`:

```json
{"hubId":"3724583a","agentType":"claude","claudeSessionId":"a577e8bf-…",
 "name":"nightly-refactor","cwd":"C:\\DataDrive\\myproject","state":"IDLE",
 "stateSince":1789138782699,"detail":"turn finished","createdAt":1789138779269,
 "alive":true,"autoYes":false,"machine":"thelaptop","timedOut":false,"reply":"…"}
```

Notes:
- The folder is auto-trusted for the engine before spawn (Claude's
  `~/.claude.json`, Codex's `config.toml`), so a brand-new folder starts its
  first turn without a "do you trust this folder?" prompt.
- 409 with `{"error":"…live elsewhere…"}` means another machine has a live
  session in a folder of the same name (folders sync across the fleet).
  Pass `"force": true` if you really want two.
- Without `initialPrompt`, `wait` just waits until the TUI is idle.

### Send a prompt — `POST /api/sessions/:id/prompt`

```json
{"text": "Now add tests for the parser.", "wait": 180000, "queue": false}
```

- Types the text into the composer and presses Enter.
- `wait` (true or ms) blocks until the turn settles; response = session
  object + `timedOut` + `reply`.
- **409 if the session is `WORKING`** — the TUI would stack the prompt behind
  the current turn. Either `wait` first or pass `"queue": true` to stack it
  deliberately.
- 409 if the session has exited — `resume` it first.
- 400 on empty text.

### Send keystrokes — `POST /api/sessions/:id/keys`

```json
{"keys": ["down", "enter"]}        // named keys and/or literal strings, in order
{"data": "\u001b[B\r"}             // raw bytes, sent verbatim
```

Named keys: `enter esc tab backspace up down left right ctrl-c ctrl-d ctrl-u
shift-tab`. Anything else in `keys` is typed as-is (`"1"`, `"y"`, `"/diff"`).
Use this to answer permission prompts, pick menu options, cancel a running
turn (`["ctrl-c"]` once — twice would exit Claude), or run slash commands
(`["/compact", "enter"]`).

### Wait for a state — `GET /api/sessions/:id/wait?until=settled&timeout=120000`

Long-poll. `until` is one of:
- `settled` (default) — anything but STARTING/WORKING
- `changed` — the state differs from `from` (default: the state at call time)
- a state name: `IDLE`, `WORKING`, `WAITING_PERMISSION`, `WAITING_QUESTION`, `EXITED`

Returns the session object + `timedOut: true|false`. **Timeouts are never
errors** — check the flag and call again.

### Read the screen — `GET /api/sessions/:id/screen`

Plain text of what a viewer sees (the visible rows). `?scrollback=200` adds up
to 5000 lines above. `?format=ansi` returns the exact serialized escape
stream instead. Use it when a turn doesn't start, to see menus/prompts, or to
watch tool output.

### Read the conversation — `GET /api/sessions/:id/exchanges?n=5`

`[{"q": "<user prompt>", "r": "<agent reply text>"}, …]`, oldest first, last
`n` (1–200). 404 if the engine keeps no readable transcript.
`GET /api/sessions/:id/export?replies=5` returns the same as a printable HTML page.

### Inspect — `GET /api/sessions/:id` and `GET /api/sessions`

One session object, or the whole fleet's list (every machine's sessions,
each tagged with `machine`).

### Lifecycle

| route | body | effect |
|---|---|---|
| `POST /api/sessions/:id/kill` | – | end the process; card stays as EXITED, resumable |
| `POST /api/sessions/:id/resume` | `{"force":false}` | relaunch the same conversation in place |
| `POST /api/sessions/:id/remove` | – | forget an EXITED card |
| `POST /api/sessions/:id/autoyes` | `{"on":true}` | auto-accept permission prompts (never the plan-mode exit) |

### Fleet-level (useful before spawning)

| route | returns |
|---|---|
| `GET /api/fleet` | machines and whether they are connected |
| `GET /api/agents?machine=X` | engines on X: `{id,label,available,models,permissionModes,canResume}` |
| `GET /api/projects?machine=X` | project folders on X: `[{name,path}]` |
| `GET /api/fleet-folders` | every folder across the fleet with its resumable conversations |
| `POST /api/fleet-resume` | `{folder, agentType, claudeSessionId, sourceMachine?, machine?}` → `{jobId, machine}`; poll `GET /api/fleet-resume/:jobId?machine=` until `phase:"done"` with `session` — resumes a conversation on any machine, syncing the folder there first |
| `POST /api/sessions/:id/handoff` | `{targetAgent, targetMachine?, targetFolder?|newFolder?, askBrief, includeDialogue}` → `{jobId}`; poll `GET /api/handoff/:jobId?machine=` — continue the work with the *other* engine (brief + dialogue dropped into `.deckhand/handoff.md`) |

## 4. The session object

```
hubId            short id used in every URL
agentType        "claude" | "codex"
claudeSessionId  the engine's own conversation id
name, cwd, model, permissionMode
state            see §2
stateSince       epoch ms when the state was entered
detail           human text for the state ("turn finished", "exit code 1", the permission being asked…)
summary          last assistant text, truncated (for cards)
createdAt, alive, autoYes
machine          owning fleet machine
frozen           folder is pinned to its machine, never synced
handoff          {fromAgent, fromSessionId, fromMachine} when this session continues a handoff
unreachable      owning hub is down; data is a cached snapshot
```

## 5. Timing rules (read this)

- **`wait` is capped at 240 s per call** (forwarded calls ride a hub-to-hub
  fetch with a 5-minute ceiling). Default 120 s. Long turns are a loop:

  ```
  r = POST prompt {text, wait: 240000}
  while r.timedOut == "done":  r = GET wait?until=settled&timeout=240000
  ```
  then read the reply with `GET exchanges?n=1` (the `reply` field is only
  filled when the same call saw the turn finish).
- `timedOut` values: `false` (finished), `"start"` (the prompt never began a
  turn — read `screen`: a prompt or menu is probably up), `"done"` (still
  working).
- The reply appears in the transcript a moment after the state flips; the
  hub already retries for ~4 s, so `reply` is normally present. If it is
  missing, call `exchanges` again after a second.
- Sending a prompt while `WAITING_PERMISSION` or `WAITING_QUESTION` types into
  a menu, not the composer. Answer with `keys` first (or turn on `autoyes`).

## 6. Recipes

**Ask one question, get one answer (creates and leaves a session):**
```
POST /api/sessions {"cwd":"C:\\DataDrive\\proj","initialPrompt":"…","wait":120000}
→ .reply
```

**Multi-turn conversation:**
```
s = POST /api/sessions {"cwd":…,"wait":true}                 # idle session
r = POST /api/sessions/{s.hubId}/prompt {"text":"…","wait":240000}
loop on timedOut=="done" with GET wait
r = POST /api/sessions/{s.hubId}/prompt {"text":"…","wait":240000}
…
POST /api/sessions/{s.hubId}/kill                              # optional; it can be resumed later
```

**Unattended work that will need permissions:**
```
POST /api/sessions {"cwd":…,"permissionMode":"acceptEdits"}   # or Codex "approve-for-me"
POST /api/sessions/{id}/autoyes {"on":true}
POST /api/sessions/{id}/prompt {"text":"…","wait":240000}
```
Or supervise: loop `GET wait?until=changed&from=WORKING`; when
`WAITING_PERMISSION`, read `detail`/`screen`, decide, `keys ["enter"]` (yes)
or `keys ["esc"]` (no).

**Start a brand-new project on a specific machine:**
```
POST /api/sessions {"machine":"desktop-master","newFolder":"toy-api",
                    "agentType":"codex","initialPrompt":"Scaffold a FastAPI hello world.","wait":240000}
```

**Continue yesterday's conversation anywhere:**
```
GET  /api/fleet-folders                        → find folder + claudeSessionId
POST /api/fleet-resume {"folder":"proj","claudeSessionId":"…","machine":"vps-node"}
poll GET /api/fleet-resume/{jobId}?machine=vps-node until phase=="done" → .session.hubId
```

## 7. Pitfalls

- `cwd` must exist on the **target** machine and be a directory; use
  `newFolder` (relative to that machine's projects root) to create one.
- Folder names are fleet-wide identities: the same folder name on two
  machines is treated as the same synced project.
- A frozen folder (`frozen: true`) can only run on its own machine; resuming
  it elsewhere is refused.
- Do not call `POST /api/admin/update` or `/api/admin/restart`. Updates are
  applied by the owner by hand; a restart kills every session on that hub.
- `kill` is graceful and keeps the conversation resumable; `remove` only
  applies to EXITED cards.
- Codex sessions mint their own id: `claudeSessionId` starts as `pending-…`
  for a second or two after creation until the first hook binds it.

## 8. Minimal client (Node 18+)

```js
const HUB = process.env.HUB_URL ?? 'http://127.0.0.1:5959';
const call = async (method, path, body) => {
  const r = await fetch(HUB + path, {
    method, headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${j.error}`);
  return j;
};
async function ask(hubId, text) {
  let r = await call('POST', `/api/sessions/${hubId}/prompt`, { text, wait: 240000 });
  while (r.timedOut === 'done') r = await call('GET', `/api/sessions/${hubId}/wait?until=settled&timeout=240000`);
  if (r.timedOut === 'start') throw new Error('turn never started:\n' + await (await fetch(`${HUB}/api/sessions/${hubId}/screen`)).text());
  return r.reply ?? (await call('GET', `/api/sessions/${hubId}/exchanges?n=1`)).at(-1)?.r;
}
const s = await call('POST', '/api/sessions', { cwd: 'C:\\DataDrive\\proj', wait: true });
console.log(await ask(s.hubId, 'What does this repo do? Two sentences.'));
```

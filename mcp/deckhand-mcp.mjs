#!/usr/bin/env node
// Deckhand's own MCP server (stdio). The hub hands it to every session it
// spawns, so an agent can see the fleet and talk to other sessions through
// the hub's REST API — the same dh_* tools the RavenAgents deckhand-agent
// server exposes, with the same camelCase parameter names.
//
// Configuration comes from the environment the hub sets on the session:
//   DECKHAND_HUB_URL      hub to talk to (default http://127.0.0.1:5959)
//   DECKHAND_TOKEN        bearer token, only needed off-loopback
//   DECKHAND_SESSION / DECKHAND_CONVERSATION / DECKHAND_MACHINE /
//   DECKHAND_ENGINE / DECKHAND_FOLDER   this session's own identity
//
// No dependencies: MCP over stdio is newline-delimited JSON-RPC 2.0.

import { createInterface } from 'node:readline';

const HUB = (process.env.DECKHAND_HUB_URL || 'http://127.0.0.1:5959').replace(/\/+$/, '');
const TOKEN = process.env.DECKHAND_TOKEN || '';
const ME = {
  hubId: process.env.DECKHAND_SESSION || '',
  conversationId: process.env.DECKHAND_CONVERSATION || '',
  machine: process.env.DECKHAND_MACHINE || '',
  engine: process.env.DECKHAND_ENGINE || '',
  folder: process.env.DECKHAND_FOLDER || '',
};

// ------------------------------------------------------------------ hub API

class HubError extends Error {}

async function call(method, path, body, timeoutMs = 30_000) {
  if (path.includes('/api/admin/')) throw new HubError('admin routes (update/restart) are not available through this server');
  const headers = { Accept: 'application/json' };
  if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res;
  try {
    res = await fetch(`${HUB}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new HubError(`hub unreachable at ${HUB}: ${err?.message ?? err}`);
  }
  const text = await res.text();
  if (!res.ok) {
    let msg = text;
    try {
      const j = JSON.parse(text);
      if (typeof j.error === 'string') msg = j.error;
    } catch {
      /* plain text */
    }
    throw new HubError(`${res.status}: ${msg.slice(0, 500)}`);
  }
  if (res.headers.get('content-type')?.includes('json')) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return text;
}

const get = (path, timeoutMs) => call('GET', path, undefined, timeoutMs);
const post = (path, body, timeoutMs) => call('POST', path, body ?? {}, timeoutMs);
const q = (s) => encodeURIComponent(String(s));
const arr = (x) => (Array.isArray(x) ? x : Array.isArray(x?.data) ? x.data : []);
const nz = (v) => v !== undefined && v !== null && v !== '';
const waitTimeout = (waitMs) => (waitMs > 0 ? waitMs + 30_000 : 30_000);

function fmtSession(s) {
  const detail = s.detail ? ` - ${s.detail}` : '';
  const me = s.hubId === ME.hubId ? '  (this session)' : '';
  return `  [${s.hubId}] ${s.name || '(unnamed)'}  (${s.agentType} on ${s.machine})${me}\n      state: ${s.state}${detail}\n      cwd: ${s.cwd}`;
}

function replyLine(s) {
  const head = `Session ${s.hubId} (${s.name || '(unnamed)'}) on ${s.machine}: state=${s.state}${s.timedOut ? ' timedOut=true' : ''}`;
  return s.reply ? `${head}\nREPLY:\n${s.reply}` : head;
}

// -------------------------------------------------------------------- tools

const S = (description) => ({ type: 'string', description });
const I = (description) => ({ type: 'integer', description });
const B = (description) => ({ type: 'boolean', description });

const TOOLS = [
  {
    name: 'dh_whoami',
    description: 'This session\'s own fleet identity (hub id, conversation id, engine, machine, folder) and the hub it talks to.',
    schema: {},
    run: async () => {
      let live = '';
      if (ME.hubId) {
        try {
          const s = await get(`/api/sessions/${q(ME.hubId)}`);
          live = `\nstate: ${s.state}${s.detail ? ` (${s.detail})` : ''} | autoYes: ${s.autoYes}`;
        } catch {
          /* hub may not know us yet */
        }
      }
      return `hubId: ${ME.hubId || '(unknown)'}\nconversationId: ${ME.conversationId || '(unknown)'}\nengine: ${ME.engine || '?'}\nmachine: ${ME.machine || '?'}\nfolder: ${ME.folder || '?'}\nhub: ${HUB}${live}`;
    },
  },
  {
    name: 'dh_etiquette',
    description: 'The fleet rules every Deckhand session is briefed with (plain text).',
    schema: {},
    run: async () => String(await get('/api/etiquette')),
  },
  {
    name: 'dh_hub_info',
    description: 'Get info about the reachable Deckhand hub (machine, build, port).',
    schema: {},
    run: async () => {
      const i = await get('/api/hub-info');
      return `Deckhand hub: machine=${i.machine} build=${i.build} version=${i.version} url=${HUB}`;
    },
  },
  {
    name: 'dh_list_fleet',
    description: 'List all machines in the Deckhand fleet and whether each is connected.',
    schema: {},
    run: async () => {
      const ms = arr(await get('/api/fleet'));
      if (!ms.length) return 'No machines in the fleet.';
      return `${ms.length} machine(s):\n` + ms.map((m) => `  ${m.machine}${m.self ? ' (self)' : ''} - ${m.connected ? 'connected' : 'OFFLINE'} - ${m.url ?? ''}`).join('\n');
    },
  },
  {
    name: 'dh_list_agents',
    description: 'List the coding-agent engines installed on a machine (models, permission modes). Omit machine for this hub\'s machine.',
    schema: { machine: S('fleet machine name; omit for this hub\'s machine') },
    run: async ({ machine }) => {
      const as = arr(await get(nz(machine) ? `/api/agents?machine=${q(machine)}` : '/api/agents'));
      if (!as.length) return 'No engines reported.';
      return `Engines on ${nz(machine) ? machine : 'this machine'}:\n` + as.map((a) => `  ${a.id} (${a.label}) - ${a.available ? 'available' : 'not installed'} | models: ${JSON.stringify(a.models)} | modes: ${JSON.stringify(a.permissionModes)} | resume: ${a.canResume}`).join('\n');
    },
  },
  {
    name: 'dh_list_projects',
    description: 'List project folders on a machine. Omit machine for this hub\'s machine.',
    schema: { machine: S('fleet machine name; omit for this hub\'s machine') },
    run: async ({ machine }) => {
      const ps = arr(await get(nz(machine) ? `/api/projects?machine=${q(machine)}` : '/api/projects'));
      if (!ps.length) return 'No projects found.';
      return `Projects on ${nz(machine) ? machine : 'this machine'}:\n` + ps.map((p) => `  ${p.name} - ${p.path}`).join('\n');
    },
  },
  {
    name: 'dh_list_sessions',
    description: 'List all agent sessions across the whole fleet (hubId, name, engine, machine, state). Your own session is marked.',
    schema: {},
    run: async () => {
      const ss = arr(await get('/api/sessions'));
      if (!ss.length) return 'No sessions running anywhere in the fleet.';
      return `${ss.length} session(s):\n` + ss.map(fmtSession).join('\n');
    },
  },
  {
    name: 'dh_get_session',
    description: 'Get full details of one session by its hubId (a conversation id or its unique 8+ char prefix also works).',
    schema: { hubId: S('session hub id') },
    required: ['hubId'],
    run: async ({ hubId }) => {
      const s = await get(`/api/sessions/${q(hubId)}`);
      return `Session ${s.hubId} - ${s.name || '(unnamed)'}\n  engine: ${s.agentType} | model: ${s.model ?? ''} | mode: ${s.permissionMode ?? ''}\n  machine: ${s.machine} | state: ${s.state} (${s.detail ?? ''})\n  cwd: ${s.cwd}\n  claudeSessionId: ${s.claudeSessionId} | autoYes: ${s.autoYes} | alive: ${s.alive}\n  summary: ${s.summary ?? ''}`;
    },
  },
  {
    name: 'dh_read_screen',
    description: 'Read the live TUI screen of a session (what a viewer sees). scrollback adds up to 5000 lines above (0 = visible only).',
    schema: { hubId: S('session hub id'), scrollback: I('lines of scrollback to include, 0-5000') },
    required: ['hubId'],
    run: async ({ hubId, scrollback }) => {
      const t = await get(`/api/sessions/${q(hubId)}/screen${scrollback > 0 ? `?scrollback=${Number(scrollback)}` : ''}`);
      const text = typeof t === 'string' ? t : (t.screen ?? t.text ?? JSON.stringify(t));
      return text.trim() ? text : '(blank screen)';
    },
  },
  {
    name: 'dh_read_exchanges',
    description: 'Read the last N prompt/reply exchanges of a session (agent\'s final replies, no tool output). n = 1-200.',
    schema: { hubId: S('session hub id'), n: I('how many exchanges, 1-200 (default 5)') },
    required: ['hubId'],
    run: async ({ hubId, n }) => {
      const es = arr(await get(`/api/sessions/${q(hubId)}/exchanges?n=${Number(n) > 0 ? Number(n) : 5}`));
      if (!es.length) return 'No exchanges recorded.';
      return es.map((e, i) => `- exchange ${i + 1} -\nQ: ${e.q}\nR: ${e.r}`).join('\n\n');
    },
  },
  {
    name: 'dh_last_reply',
    description: 'The agent\'s complete final reply to the most recent prompt of a session, verbatim and untruncated, with the prompt it answered. Use after dh_send_prompt / dh_wait_for_session instead of scraping dh_read_screen.',
    schema: { hubId: S('session hub id') },
    required: ['hubId'],
    run: async ({ hubId }) => {
      const es = arr(await get(`/api/sessions/${q(hubId)}/exchanges?n=1`));
      if (!es.length) return 'No completed exchange yet for this session.';
      const e = es[es.length - 1];
      return `PROMPT:\n${e.q}\n\nREPLY:\n${e.r}`;
    },
  },
  {
    name: 'dh_list_fleet_folders',
    description: 'List every project folder across the fleet with its resumable conversations (for resuming work anywhere).',
    schema: {},
    run: async () => {
      const d = await get('/api/fleet-folders');
      const json = JSON.stringify(d?.data ?? d, null, 2);
      return json.length > 4000 ? json.slice(0, 4000) + '\n…' : json;
    },
  },
  {
    name: 'dh_wait_for_session',
    description: 'Long-poll until a session reaches a state. until = settled|changed|IDLE|WORKING|WAITING_PERMISSION|WAITING_QUESTION|EXITED. Returns the session + timedOut flag (a timeout is not an error - call again).',
    schema: { hubId: S('session hub id'), until: S('settled (default) | changed | IDLE | WORKING | WAITING_PERMISSION | WAITING_QUESTION | EXITED'), timeoutMs: I('how long to wait, default 120000') },
    required: ['hubId'],
    run: async ({ hubId, until, timeoutMs }) => {
      const t = Number(timeoutMs) > 0 ? Number(timeoutMs) : 120_000;
      const s = await get(`/api/sessions/${q(hubId)}/wait?until=${q(until || 'settled')}&timeout=${t}`, t + 30_000);
      return `Session ${s.hubId}: state=${s.state} (${s.detail ?? ''}) timedOut=${s.timedOut}`;
    },
  },
  {
    name: 'dh_send_prompt',
    description: 'Send a prompt to an existing session (typed into its composer). waitMs >= 0 blocks until the turn settles and returns the reply. queue=true stacks it behind a running turn (else the hub answers 409 while the session is WORKING). Fleet etiquette: this is how you ask another session before touching its code.',
    schema: { hubId: S('target session hub id'), text: S('the prompt'), waitMs: I('block until the turn settles, up to this many ms; omit to return immediately'), queue: B('queue behind a running turn instead of failing') },
    required: ['hubId', 'text'],
    run: async ({ hubId, text, waitMs, queue }) => {
      if (!nz(text) || !String(text).trim()) return 'Prompt text is empty.';
      const body = { text, queue: !!queue };
      const w = Number(waitMs);
      if (Number.isFinite(w) && w >= 0 && nz(waitMs)) body.wait = w;
      return replyLine(await post(`/api/sessions/${q(hubId)}/prompt`, body, waitTimeout(body.wait ?? 0)));
    },
  },
  {
    name: 'dh_send_keys',
    description: 'Send keystrokes to a session\'s TUI (answer permission/question menus, cancel a turn, run slash commands). keys = comma-separated named keys and/or literal strings in order, e.g. "down,enter" or "y" or "/compact,enter". Named: enter esc tab backspace up down left right ctrl-c ctrl-d ctrl-u shift-tab.',
    schema: { hubId: S('session hub id'), keys: S('comma-separated keys') },
    required: ['hubId', 'keys'],
    run: async ({ hubId, keys }) => {
      const list = String(keys).split(',').map((k) => k.trim()).filter(Boolean);
      if (!list.length) return 'No keys provided.';
      await post(`/api/sessions/${q(hubId)}/keys`, { keys: list });
      return `Sent keys [${list.join(', ')}] to ${hubId}.`;
    },
  },
  {
    name: 'dh_set_autoyes',
    description: 'Turn auto-accept of permission prompts on/off for a session (never auto-exits plan mode).',
    schema: { hubId: S('session hub id'), on: B('true = on') },
    required: ['hubId', 'on'],
    run: async ({ hubId, on }) => {
      await post(`/api/sessions/${q(hubId)}/autoyes`, { on: !!on });
      return `autoyes ${on ? 'ON' : 'OFF'} for ${hubId}.`;
    },
  },
  {
    name: 'dh_create_session',
    description: 'Spawn a new coding-agent session on a fleet machine. Provide either cwd (existing absolute folder on the target machine) OR newFolder (created under that machine\'s projects root). agentType: claude|codex. Optional: name, model, permissionMode (see dh_list_agents), initialPrompt, machine (omit = this hub), waitMs (>= 0 blocks until the first turn settles), force (override "folder live elsewhere").',
    schema: { cwd: S('existing absolute folder on the target machine'), newFolder: S('folder to create under the projects root'), agentType: S('claude | codex (default claude)'), name: S('card name'), model: S('model id'), permissionMode: S('permission mode'), initialPrompt: S('first prompt'), machine: S('target machine; omit for this hub'), waitMs: I('block until the first turn settles'), force: B('override the folder-live-elsewhere guard') },
    run: async (a) => {
      if (!nz(a.cwd) && !nz(a.newFolder)) return 'Provide either cwd (existing folder) or newFolder (to create one).';
      const body = { agentType: nz(a.agentType) ? a.agentType : 'claude' };
      for (const k of ['cwd', 'newFolder', 'name', 'model', 'permissionMode', 'initialPrompt', 'machine']) if (nz(a[k])) body[k] = a[k];
      if (a.force) body.force = true;
      const w = Number(a.waitMs);
      if (nz(a.waitMs) && Number.isFinite(w) && w >= 0) body.wait = w;
      const s = await post('/api/sessions', body, waitTimeout(body.wait ?? 0));
      return `Session created on ${s.machine}:\n${replyLine(s)}`;
    },
  },
  {
    name: 'dh_kill_session',
    description: 'End a session\'s process (the card stays as EXITED and is resumable).',
    schema: { hubId: S('session hub id') },
    required: ['hubId'],
    run: async ({ hubId }) => {
      await post(`/api/sessions/${q(hubId)}/kill`);
      return `Killed ${hubId} (resumable).`;
    },
  },
  {
    name: 'dh_resume_session',
    description: 'Relaunch an EXITED session\'s conversation in place. force overrides guards.',
    schema: { hubId: S('session hub id'), force: B('override guards') },
    required: ['hubId'],
    run: async ({ hubId, force }) => {
      const s = await post(`/api/sessions/${q(hubId)}/resume`, { force: !!force });
      return `Resumed ${hubId}: state=${s.state ?? 'ok'}`;
    },
  },
  {
    name: 'dh_remove_session',
    description: 'Forget an EXITED session card (only works on EXITED sessions).',
    schema: { hubId: S('session hub id') },
    required: ['hubId'],
    run: async ({ hubId }) => {
      await post(`/api/sessions/${q(hubId)}/remove`);
      return `Removed card ${hubId}.`;
    },
  },
  {
    name: 'dh_fleet_resume',
    description: 'Resume a conversation on any machine, syncing the folder there first. Provide folder + claudeSessionId (from dh_list_fleet_folders); optional agentType, sourceMachine, machine (target). Returns a jobId to poll.',
    schema: { folder: S('project folder name'), claudeSessionId: S('conversation id'), agentType: S('claude | codex (default claude)'), sourceMachine: S('machine that has the conversation'), machine: S('machine to run it on') },
    required: ['folder', 'claudeSessionId'],
    run: async (a) => {
      const body = { folder: a.folder, claudeSessionId: a.claudeSessionId, agentType: nz(a.agentType) ? a.agentType : 'claude' };
      if (nz(a.sourceMachine)) body.sourceMachine = a.sourceMachine;
      if (nz(a.machine)) body.machine = a.machine;
      const r = await post('/api/fleet-resume', body);
      return `fleet-resume started: jobId=${r.jobId} machine=${r.machine} (poll GET /api/fleet-resume/${r.jobId}?machine=${r.machine} until phase=done).`;
    },
  },
  {
    name: 'dh_handoff',
    description: 'Hand a session\'s work to the OTHER engine (Claude<->Codex), dropping a brief + dialogue into .deckhand/handoff.md. targetAgent: claude|codex. Optional targetMachine, and targetFolder OR newFolder, askBrief (text), includeDialogue. Returns a jobId to poll.',
    schema: { hubId: S('source session hub id'), targetAgent: S('claude | codex'), targetMachine: S('machine to run the target on'), targetFolder: S('existing folder for the target'), newFolder: S('folder to create for the target'), askBrief: S('what to ask the target to do'), includeDialogue: B('include the dialogue in the handoff file') },
    required: ['hubId', 'targetAgent'],
    run: async (a) => {
      const body = { targetAgent: a.targetAgent, includeDialogue: !!a.includeDialogue };
      for (const k of ['targetMachine', 'targetFolder', 'newFolder', 'askBrief']) if (nz(a[k])) body[k] = a[k];
      const r = await post(`/api/sessions/${q(a.hubId)}/handoff`, body);
      return `handoff started: jobId=${r.jobId} (poll the hub for the result).`;
    },
  },
];

const toolList = TOOLS.map((t) => ({
  name: t.name,
  description: t.description,
  inputSchema: { type: 'object', properties: t.schema, ...(t.required?.length ? { required: t.required } : {}) },
}));

// ------------------------------------------------------------------ JSON-RPC

const out = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
const reply = (id, result) => out({ jsonrpc: '2.0', id, result });
const fail = (id, code, message) => out({ jsonrpc: '2.0', id, error: { code, message } });

async function handle(msg) {
  const { id, method, params } = msg;
  if (id === undefined || id === null) return; // notification
  switch (method) {
    case 'initialize':
      return reply(id, {
        protocolVersion: params?.protocolVersion || '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'deckhand', version: '1.0.0' },
        instructions:
          'You are one session inside Deckhand, a fleet of coding-agent sessions. Use dh_whoami to learn who you are, dh_list_sessions to see the others, and dh_send_prompt / dh_wait_for_session / dh_last_reply to talk to another session before changing its code.',
      });
    case 'ping':
      return reply(id, {});
    case 'tools/list':
      return reply(id, { tools: toolList });
    case 'tools/call': {
      const tool = TOOLS.find((t) => t.name === params?.name);
      if (!tool) return fail(id, -32602, `unknown tool ${params?.name}`);
      try {
        const text = await tool.run(params?.arguments ?? {});
        return reply(id, { content: [{ type: 'text', text: String(text) }] });
      } catch (err) {
        const text = err instanceof HubError ? err.message : `error: ${err?.message ?? err}`;
        return reply(id, { content: [{ type: 'text', text }], isError: true });
      }
    }
    case 'resources/list':
    case 'resources/templates/list':
      return reply(id, { resources: [], resourceTemplates: [] });
    case 'resources/read':
      // small models sometimes try to "read" a tool as a resource — point them back
      return fail(id, -32002, `this server has no resources; call ${params?.uri ?? 'the tool'} with tools/call instead`);
    case 'prompts/list':
      return reply(id, { prompts: [] });
    default:
      return fail(id, -32601, `method not found: ${method}`);
  }
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return fail(null, -32700, 'parse error');
  }
  void handle(msg);
});
rl.on('close', () => process.exit(0));

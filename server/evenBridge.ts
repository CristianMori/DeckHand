import { createServer } from 'node:http';
import express from 'express';
import { authorize, cookieHeader } from './access.js';
import { hookBus } from './hooksReceiver.js';
import type { AlertKind } from './ntfy.js';
import type { SessionInfo, SessionState } from './types.js';

/**
 * Even Realities glasses bridge.
 *
 * The Even app's built-in Terminal client (G2 glasses + R1 ring) talks to an
 * `even-terminal` server: a small HTTP + server-sent-events protocol on port
 * 3456. This module speaks that protocol on behalf of the whole fleet, so the
 * glasses list every Deckhand session on every machine and drive them —
 * prompts (typed or spoken in the Even app), permission answers, questions,
 * interrupts. Nothing is spawned here: every action goes through this hub's
 * own REST API on loopback, which forwards to the owning machine.
 *
 * Wire format mirrors @evenrealities/even-terminal 0.10.x:
 *   GET  /api/sessions                 {sessions:[{id,title,timestamp,cwd,provider,status}]}
 *   GET  /api/events?sessionId=        SSE, `id: n` + `data: {type,…}`
 *   GET  /api/messages?sessionId=&after=
 *   GET  /api/status?sessionId=
 *   GET  /api/sessions/:id/history
 *   GET  /api/info, /api/update-check, /api/metrics
 *   POST /api/prompt                   {text, sessionId?, provider?, cwd?}
 *   POST /api/permission-response      {sessionId, decision}
 *   POST /api/question-response        {sessionId, answer}
 *   POST /api/interrupt                {sessionId}
 * Session ids are the agent's conversation id (stable across hub restarts);
 * a session that has none yet goes by its hub id.
 */

/** what the Even app is told it is talking to — the release this mirrors */
const EVEN_TERMINAL_VERSION = '0.10.5';
const TRACK_MS = 400;
/** how long an auto-yes session gets to answer its own prompt before the wearer hears of it */
const AUTO_YES_GRACE_MS = 3000;
const MAX_MESSAGES = 500;

type Msg = Record<string, unknown> & { type: string };
type Provider = 'claude' | 'codex';

interface Stream {
  messages: { id: number; msg: Msg }[];
  clients: Set<express.Response>;
  nextId: number;
}

/** A pending prompt on the glasses: what each offered key types into the session. */
interface PendingMenu {
  kind: 'permission' | 'question';
  keys: Map<string, string>;
  labels: Map<string, string>;
  toolName: string;
  summary: string;
}

interface Tracked {
  state: SessionState;
  detail?: string;
  lastReplyKey?: string;
  menu?: PendingMenu;
}

export interface EvenBridgeDeps {
  /** fleet-wide session list (this hub plus its peers) */
  sessions: () => SessionInfo[];
  /** loopback base URL of this hub's REST API */
  hubUrl: () => string;
  /** this machine's fleet name */
  selfName: () => string;
  /** where a session started from the glasses without a folder runs */
  defaultCwd: () => string;
  version: string;
  /** a session needs the wearer or finished: also tell the phone (ntfy) */
  onAlert?: (title: string, what: string, kind: AlertKind, click?: string) => void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const oneLine = (s: unknown) => String(s ?? '').replace(/\s+/g, ' ').trim();
const clip = (s: unknown, n: number) => {
  const t = oneLine(s);
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};
const baseName = (p: unknown) => String(p ?? '').split(/[\\/]/).filter(Boolean).pop() ?? 'file';

/** One display line per tool call, sized for the 576 px glasses canvas. */
export function summarizeTool(name: string, input: Record<string, unknown> = {}): string {
  switch (name) {
    case 'Bash':
      return `Bash ${clip(input.description ?? input.command, 50)}`;
    case 'Read':
      return `Read ${baseName(input.file_path)}`;
    case 'Edit':
    case 'MultiEdit':
      return `Edit ${baseName(input.file_path)}`;
    case 'Write':
      return `Write ${baseName(input.file_path)}`;
    case 'Glob':
      return `Glob ${clip(input.pattern, 40)}`;
    case 'Grep':
      return `Grep "${clip(input.pattern, 30)}"`;
    case 'WebSearch':
      return `Search "${clip(input.query, 36)}"`;
    case 'WebFetch':
      return `Fetch ${clip(input.url, 40)}`;
    case 'Agent':
    case 'Task':
      return `Agent ${clip(input.description, 40)}`;
    case 'TodoWrite':
      return 'Update tasks';
    default: {
      const m = name.match(/^mcp__(.+?)__(.+)$/);
      return m ? `MCP ${m[1]}.${clip(m[2], 30)}` : name;
    }
  }
}

/** The first input field worth showing under a permission request. */
function detailOf(input: Record<string, unknown> = {}): string {
  for (const k of ['command', 'file_path', 'url', 'query', 'pattern', 'prompt']) {
    if (typeof input[k] === 'string' && input[k]) return clip(input[k], 200);
  }
  return '';
}

/**
 * The numbered menu at the bottom of a TUI screen ("❯ 1. Yes", "2. Yes, and
 * don't ask again…", "3. No"). Returns the last contiguous block.
 */
export function parseMenu(screen: string): { n: string; text: string }[] {
  const lines = screen.split('\n').slice(-30);
  let block: { n: string; text: string }[] = [];
  let current: { n: string; text: string }[] = [];
  for (const line of lines) {
    const m = line.match(/^\s*[│|]?\s*(?:[❯›>]\s*)?(\d{1,2})[.)]\s+(.+?)\s*[│|]?\s*$/);
    if (m && (!current.length || Number(m[1]) === Number(current[current.length - 1].n) + 1)) {
      current.push({ n: m[1], text: m[2] });
    } else if (m && m[1] === '1') {
      if (current.length > 1) block = current;
      current = [{ n: m[1], text: m[2] }];
    } else if (current.length && (!line.trim() || /^\s{3,}\S/.test(line) || /^\s*[─━-]{8,}\s*$/.test(line))) {
      continue; // blank spacing, an option's indented description, or a divider inside the menu
    } else if (current.length) {
      if (current.length > 1) block = current;
      current = [];
    }
  }
  if (current.length > 1) block = current;
  return block;
}

/** Even's decision vocabulary for a permission option's text. */
function permissionKey(text: string, fallback: string): string {
  if (/^yes\b/i.test(text) && /(don.t ask|always|this session)/i.test(text)) return 'allowAlways';
  if (/^yes\b/i.test(text)) return 'allow';
  if (/^no\b/i.test(text)) return 'deny';
  return fallback;
}

export function startEvenBridge(port: number, deps: EvenBridgeDeps) {
  const streams = new Map<string, Stream>();
  const tracked = new Map<string, Tracked>();
  /** latest PreToolUse per hub session (local sessions only — hooks are per hub) */
  const lastTool = new Map<string, { name: string; input: Record<string, unknown> }>();
  /** AskUserQuestion payloads waiting to be shown, per hub session */
  const lastQuestions = new Map<string, unknown[]>();

  const evenId = (s: SessionInfo) => (s.claudeSessionId.startsWith('pending-') ? s.hubId : s.claudeSessionId);
  const providerOf = (s: SessionInfo): Provider => (s.agentType === 'codex' ? 'codex' : 'claude');
  const isAgent = (s: SessionInfo) => s.agentType !== 'shell';
  const find = (id: unknown): SessionInfo | undefined => {
    if (typeof id !== 'string' || !id) return undefined;
    const all = deps.sessions().filter(isAgent);
    return all.find((s) => s.claudeSessionId === id) ?? all.find((s) => s.hubId === id);
  };
  const statusOf = (s: SessionInfo): 'busy' | 'idle' | 'awaiting' =>
    s.state === 'WAITING_PERMISSION' || s.state === 'WAITING_QUESTION'
      ? 'awaiting'
      : s.state === 'WORKING' || s.state === 'STARTING'
        ? 'busy'
        : 'idle';

  // ---------------------------------------------------------- event streams

  function stream(sid: string): Stream {
    let st = streams.get(sid);
    if (!st) streams.set(sid, (st = { messages: [], clients: new Set(), nextId: 1 }));
    return st;
  }

  function emit(sid: string, msg: Msg) {
    const st = stream(sid);
    const id = st.nextId++;
    st.messages.push({ id, msg });
    if (st.messages.length > MAX_MESSAGES) st.messages.splice(0, st.messages.length - MAX_MESSAGES);
    const data = `id: ${id}\ndata: ${JSON.stringify(msg)}\n\n`;
    for (const res of st.clients) {
      try {
        res.write(data);
      } catch {
        st.clients.delete(res);
      }
    }
  }

  // ---------------------------------------------------------- hub API

  async function hub(path: string, init?: { method?: string; body?: unknown }) {
    const res = await fetch(deps.hubUrl() + path, {
      method: init?.method ?? 'GET',
      headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
      body: init?.body ? JSON.stringify(init.body) : undefined,
    });
    const text = await res.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      /* plain text (screen) */
    }
    if (!res.ok) {
      const err = (body as { error?: string })?.error ?? text;
      throw Object.assign(new Error(String(err)), { statusCode: res.status });
    }
    return body;
  }

  const sendKeys = (s: SessionInfo, keys: string[]) =>
    hub(`/api/sessions/${s.hubId}/keys`, { method: 'POST', body: { keys } });

  // ---------------------------------------------------------- tracking

  hookBus.on('hook', (session, event, body) => {
    if (event === 'PreToolUse' && body.tool_name) {
      const input = (body.tool_input ?? {}) as Record<string, unknown>;
      lastTool.set(session.hubId, { name: body.tool_name, input });
      if (body.tool_name === 'AskUserQuestion' && Array.isArray(input.questions)) {
        lastQuestions.set(session.hubId, input.questions);
      }
      const sid = session.claudeSessionId.startsWith('pending-') ? session.hubId : session.claudeSessionId;
      if (body.tool_name !== 'AskUserQuestion') {
        const toolId = `${session.hubId}-${Date.now()}`;
        emit(sid, { type: 'tool_start', name: body.tool_name, toolId });
        emit(sid, {
          type: 'tool_end',
          name: body.tool_name,
          toolId,
          summary: summarizeTool(body.tool_name, input),
          detail: { input },
        });
      }
    }
  });

  /** The menu the session is showing. The waiting signal can beat the TUI's
   *  redraw, so look a few times before settling for none. */
  async function readMenu(s: SessionInfo) {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const menu = parseMenu(String(await hub(`/api/sessions/${s.hubId}/screen`)));
        if (menu.length) return menu;
      } catch {
        /* the request still goes out, with default options */
      }
      await sleep(300);
    }
    return [];
  }

  // Claude reports its question menu (AskUserQuestion) as a permission
  // prompt, so every wait goes through here and is sorted by what it shows.
  async function onWaiting(s: SessionInfo, t: Tracked) {
    // Auto-yes answers ordinary prompts within a second; only the ones it
    // leaves alone (leaving plan mode) are worth the wearer's attention.
    if (s.autoYes) {
      await sleep(AUTO_YES_GRACE_MS);
      const now = deps.sessions().find((x) => x.hubId === s.hubId);
      if (!now || now.state !== s.state || now.stateSince !== s.stateSince) return;
    }
    const menu = await readMenu(s);
    const local = s.machine === deps.selfName();
    const asking = local
      ? lastTool.get(s.hubId)?.name === 'AskUserQuestion'
      : menu.length > 0 && !menu.some((o) => /^(yes|no)\b/i.test(o.text));
    if (asking || s.state === 'WAITING_QUESTION') return onQuestion(s, t, menu);
    return onPermission(s, t, menu);
  }

  async function onPermission(s: SessionInfo, t: Tracked, menu: { n: string; text: string }[]) {
    const sid = evenId(s);
    const tool = s.machine === deps.selfName() ? lastTool.get(s.hubId) : undefined;
    const toolName = tool?.name ?? (s.detail?.match(/use (\S+)/)?.[1] ?? 'Tool');
    const summary = tool ? summarizeTool(tool.name, tool.input) : clip(s.detail ?? 'Permission needed', 60);
    const pending: PendingMenu = { kind: 'permission', keys: new Map(), labels: new Map(), toolName, summary };
    const options = (menu.length ? menu : [{ n: '1', text: 'Yes' }, { n: '3', text: 'No' }]).map((o) => {
      const key = permissionKey(o.text, `option${o.n}`);
      pending.keys.set(key, o.n);
      pending.labels.set(key, o.text);
      return { text: clip(o.text, 80), key };
    });
    // a declined permission is Esc in every agent TUI, even when the menu has no "No"
    if (!pending.keys.has('deny')) {
      pending.keys.set('deny', '\x1b');
      options.push({ text: 'No', key: 'deny' });
    }
    t.menu = pending;
    alertOthers(s, 'permission', `needs permission: ${summary}`);
    emit(sid, {
      type: 'permission_request',
      toolName,
      description: summary,
      detail: tool ? detailOf(tool.input) : '',
      toolUseId: `${s.hubId}-${s.stateSince}`,
      options,
      suggestions: null,
    });
  }

  async function onQuestion(s: SessionInfo, t: Tracked, menu: { n: string; text: string }[]) {
    const sid = evenId(s);
    const pending: PendingMenu = { kind: 'question', keys: new Map(), labels: new Map(), toolName: 'AskUserQuestion', summary: '' };
    for (const o of menu) {
      pending.keys.set(o.text.toLowerCase(), o.n);
      pending.labels.set(o.text.toLowerCase(), o.text);
    }
    t.menu = pending;
    const asked = lastQuestions.get(s.hubId);
    lastQuestions.delete(s.hubId);
    const questions = Array.isArray(asked) && asked.length
      ? asked.map((q) => {
          const r = q as { question?: string; header?: string; multiSelect?: boolean; options?: { label?: string; description?: string }[] };
          return {
            question: String(r.question ?? ''),
            header: String(r.header ?? ''),
            multiSelect: r.multiSelect === true,
            options: (r.options ?? []).map((o) => ({ label: String(o.label ?? ''), description: String(o.description ?? ''), preview: '' })),
          };
        })
      : [
          {
            // no structured question (a remote session, or a plain menu): what the screen shows
            question: clip(s.detail ?? 'The agent is asking you something', 120),
            header: '',
            multiSelect: false,
            options: menu.map((o) => ({ label: clip(o.text, 80), description: '', preview: '' })),
          },
        ];
    alertOthers(s, 'question', `asks: ${questions[0]?.question || 'a question'}`);
    emit(sid, { type: 'user_question', questions, toolUseId: `${s.hubId}-${s.stateSince}` });
  }

  /**
   * Tell the wearer about a session they are not looking at: a notification
   * goes into every other session stream that has the Even client attached,
   * so switching between agents never hides one that needs attention.
   */
  function alertOthers(s: SessionInfo, kind: AlertKind, what: string) {
    const sid = evenId(s);
    const title = clip(`${s.name}${s.machine ? ` @ ${s.machine}` : ''}`, 48);
    for (const [other, st] of streams) {
      if (other === sid || !st.clients.size) continue;
      emit(other, { type: 'notification', title, message: clip(what, 120) });
    }
    deps.onAlert?.(title, what, kind);
  }

  /** The turn ended: hand the reply over as one text block plus a result. */
  async function onSettled(s: SessionInfo, t: Tracked) {
    const sid = evenId(s);
    let reply: { q: string; r: string } | undefined;
    // the transcript is flushed a moment after the stop hook
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        const ex = (await hub(`/api/sessions/${s.hubId}/exchanges?n=1`)) as { q: string; r: string }[];
        reply = ex[ex.length - 1];
      } catch {
        reply = undefined;
      }
      if (reply && `${reply.q}\u0000${reply.r}` !== t.lastReplyKey) break;
      await sleep(500);
    }
    const key = reply ? `${reply.q}\u0000${reply.r}` : undefined;
    // Claude's stand-in reply for an interrupted turn is not worth a screen
    if (reply && key !== t.lastReplyKey && reply.r.trim() !== 'No response requested.') {
      t.lastReplyKey = key;
      alertOthers(s, 'done', `done: ${reply.r}`);
      emit(sid, { type: 'status', state: 'text_start', sessionId: sid, provider: providerOf(s) });
      emit(sid, { type: 'text_delta', text: reply.r });
      emit(sid, { type: 'status', state: 'text_end', sessionId: sid, provider: providerOf(s) });
      emit(sid, {
        type: 'result',
        success: true,
        text: reply.r,
        sessionId: sid,
        costUsd: 0,
        provider: providerOf(s),
        turns: 1,
        durationMs: 0,
        inputTokens: 0,
        outputTokens: 0,
      });
    }
    emit(sid, { type: 'status', state: 'idle', sessionId: sid, provider: providerOf(s) });
  }

  function closeMenu(s: SessionInfo, t: Tracked, decision?: string) {
    const menu = t.menu;
    if (!menu) return;
    t.menu = undefined;
    if (menu.kind === 'permission') {
      emit(evenId(s), {
        type: 'permission_result',
        toolName: menu.toolName,
        summary: menu.summary,
        decision: decision === 'allowAlways' ? 'always' : decision === 'deny' ? 'denied' : 'allowed',
      });
    }
  }

  // Watch every agent session in the fleet and turn its state changes into
  // the events the Even client expects.
  let first = true;
  const timer = setInterval(() => {
    let list: SessionInfo[];
    try {
      list = deps.sessions().filter(isAgent);
    } catch {
      return;
    }
    const seen = new Set<string>();
    for (const s of list) {
      seen.add(s.hubId);
      const prev = tracked.get(s.hubId);
      if (!prev) {
        // first sight: remember, do not replay what already happened
        tracked.set(s.hubId, {
          state: s.state,
          detail: s.detail,
          lastReplyKey: first ? 'unknown' : undefined,
        });
        if (!first && (s.state === 'WAITING_PERMISSION' || s.state === 'WAITING_QUESTION')) void onWaiting(s, tracked.get(s.hubId)!);
        continue;
      }
      const sid = evenId(s);
      const was = prev.state;
      if (s.state !== was) {
        prev.state = s.state;
        if (was === 'WAITING_PERMISSION' || was === 'WAITING_QUESTION') closeMenu(s, prev);
        if (s.state === 'WORKING') {
          emit(sid, { type: 'status', state: 'busy', sessionId: sid, provider: providerOf(s) });
        } else if (s.state === 'WAITING_PERMISSION' || s.state === 'WAITING_QUESTION') {
          void onWaiting(s, prev);
        } else if (s.state === 'EXITED') {
          // the process is gone — nothing new to say, the next prompt resumes it
          emit(sid, { type: 'notification', title: 'Session ended', message: `${s.name} exited; a new prompt resumes it` });
          emit(sid, { type: 'status', state: 'idle', sessionId: sid, provider: providerOf(s) });
        } else if (s.state === 'IDLE' && was !== 'STARTING') {
          if (prev.lastReplyKey === 'unknown') prev.lastReplyKey = undefined;
          void onSettled(s, prev);
        }
      } else if (
        s.state === 'WORKING' &&
        s.detail !== prev.detail &&
        s.machine !== deps.selfName() &&
        s.detail?.startsWith('using ')
      ) {
        // a remote session: no hook payloads here, the owning hub's detail line is all there is
        const name = s.detail.slice('using '.length);
        const toolId = `${s.hubId}-${Date.now()}`;
        emit(sid, { type: 'tool_start', name, toolId });
        emit(sid, { type: 'tool_end', name, toolId, summary: name, detail: {} });
      }
      prev.detail = s.detail;
    }
    for (const id of tracked.keys()) if (!seen.has(id)) tracked.delete(id);
    first = false;
  }, TRACK_MS);
  timer.unref();

  // ---------------------------------------------------------- HTTP

  const app = express();
  app.use((req, res, next) => {
    const verdict = authorize(req.socket.remoteAddress, req.headers, req.url);
    if (verdict.status === 403) return res.status(403).end();
    if (verdict.status === 401) return res.status(401).json({ error: { code: 'auth_failed', message: 'Unauthorized' } });
    if (verdict.setCookie) res.setHeader('Set-Cookie', cookieHeader());
    if (req.method === 'POST') console.log(`[even] POST ${req.path}`); // the client polls; reads stay quiet
    next();
  });
  app.use(express.json({ limit: '10mb' }));

  app.get('/api/info', (req, res) => {
    res.json({
      account: { email: '', organization: `Deckhand · ${deps.selfName()}`, subscriptionType: '' },
      model: 'Deckhand fleet',
      version: deps.version,
      provider: req.query.provider === 'codex' ? 'codex' : 'claude',
      extra: { expose: 'off' },
    });
  });

  app.get('/api/update-check', (_req, res) => {
    res.json({
      packageName: '@evenrealities/even-terminal',
      currentVersion: EVEN_TERMINAL_VERSION,
      newestVersion: EVEN_TERMINAL_VERSION,
      updateAvailable: false,
      checkedAt: new Date().toISOString(),
    });
  });

  // waiting sessions first, then working, then the rest by recency; live
  // before exited. Exited ones are listed too: prompting one resumes it.
  app.get('/api/sessions', (req, res) => {
    const provider = typeof req.query.provider === 'string' ? req.query.provider : undefined;
    const limit = Math.max(1, Math.min(50, Number(req.query.limit) || 20));
    const rank = (s: SessionInfo) =>
      s.unreachable ? 4 : statusOf(s) === 'awaiting' ? 0 : statusOf(s) === 'busy' ? 1 : s.state === 'EXITED' ? 3 : 2;
    const list = deps
      .sessions()
      .filter(isAgent)
      .filter((s) => !provider || providerOf(s) === (provider === 'codex' ? 'codex' : 'claude'))
      .sort((a, b) => rank(a) - rank(b) || b.stateSince - a.stateSince)
      .slice(0, limit)
      .map((s) => ({
        id: evenId(s),
        title: clip(`${s.name}${s.machine ? ` @ ${s.machine}` : ''}`, 64),
        timestamp: new Date(s.stateSince).toISOString(),
        cwd: s.cwd,
        provider: providerOf(s),
        status: statusOf(s),
      }));
    res.json({ sessions: list });
  });

  app.get('/api/status', (req, res) => {
    const s = find(req.query.sessionId);
    if (!s) return res.status(404).json({ error: 'Session not found' });
    res.json({ state: statusOf(s), sessionId: evenId(s), provider: providerOf(s) });
  });

  app.get('/api/messages', (req, res) => {
    const sid = String(req.query.sessionId ?? '');
    if (!sid) return res.status(400).json({ error: "Missing 'sessionId'" });
    const after = Number(req.query.after) || 0;
    const s = find(sid);
    const messages = (streams.get(sid)?.messages ?? []).filter((m) => m.id > after).map((m) => ({ id: m.id, ...m.msg }));
    res.json({ messages, state: s ? statusOf(s) : 'idle', sessionId: sid, provider: s ? providerOf(s) : null });
  });

  app.get('/api/events', (req, res) => {
    const sid = String(req.query.sessionId ?? '');
    if (!sid) return res.status(400).json({ error: "Missing 'sessionId' query parameter" });
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    res.write(':ok\n\n');
    const st = stream(sid);
    if (req.query.needReplay === 'true') {
      for (const m of st.messages) res.write(`id: ${m.id}\ndata: ${JSON.stringify(m.msg)}\n\n`);
    }
    st.clients.add(res);
    const heartbeat = setInterval(() => {
      try {
        res.write(':heartbeat\n\n');
      } catch {
        clearInterval(heartbeat);
        st.clients.delete(res);
      }
    }, 15_000);
    req.on('close', () => {
      clearInterval(heartbeat);
      st.clients.delete(res);
    });
    // a client joining mid-prompt still gets the pending request
    const s = find(sid);
    const t = s && tracked.get(s.hubId);
    if (s && t && !t.menu && (s.state === 'WAITING_PERMISSION' || s.state === 'WAITING_QUESTION')) void onWaiting(s, t);
  });

  app.get('/api/sessions/:id/history', async (req, res) => {
    const s = find(req.params.id);
    if (!s) return res.json({ history: [], error: 'Session not found' });
    const limit = Math.max(1, Math.min(10, Number(req.query.limit) || 10));
    try {
      const ex = (await hub(`/api/sessions/${s.hubId}/exchanges?n=${Math.ceil(limit / 2)}`)) as { q: string; r: string }[];
      const history = ex.flatMap((e) => [
        { role: 'user', text: e.q },
        { role: 'assistant', text: e.r },
      ]);
      res.json({ history: history.slice(-limit) });
    } catch (err) {
      res.json({ history: [], error: String((err as Error).message) });
    }
  });

  // A prompt from the glasses. An unknown or missing sessionId starts a new
  // session; an exited one is resumed first; a busy one queues it.
  app.post('/api/prompt', async (req, res) => {
    const { text, sessionId, provider, cwd } = req.body ?? {};
    if (!text || typeof text !== 'string') return res.status(400).json({ error: "Missing 'text' field" });
    const agentType: Provider = provider === 'codex' ? 'codex' : 'claude';
    let s = find(sessionId);
    try {
      if (!s) {
        const created = (await hub('/api/sessions', {
          method: 'POST',
          body: { cwd: typeof cwd === 'string' && cwd ? cwd : deps.defaultCwd(), agentType, initialPrompt: text, force: true },
        })) as SessionInfo;
        const sid = evenId(created);
        emit(sid, { type: 'user_prompt', text });
        return res.status(202).json({ ok: true, sessionId: sid, provider: agentType });
      }
      const target = s;
      const sid = evenId(target);
      emit(sid, { type: 'user_prompt', text });
      res.status(202).json({ ok: true, sessionId: sid, provider: providerOf(target) });
      if (target.state === 'EXITED' || !target.alive) {
        await hub(`/api/sessions/${target.hubId}/resume`, { method: 'POST', body: { force: true } });
        await hub(`/api/sessions/${target.hubId}/wait?until=settled&timeout=60000`);
      }
      await hub(`/api/sessions/${target.hubId}/prompt`, { method: 'POST', body: { text, queue: true } });
    } catch (err) {
      const e = err as Error & { statusCode?: number };
      console.warn(`[even] prompt failed: ${e.message}`);
      if (!res.headersSent) return res.status(e.statusCode ?? 500).json({ error: e.message });
      if (s) emit(evenId(s), { type: 'error', message: e.message });
    }
  });

  app.post('/api/permission-response', async (req, res) => {
    const { sessionId, decision } = req.body ?? {};
    const s = find(sessionId);
    if (!s) return res.status(404).json({ error: 'Session not found' });
    const t = tracked.get(s.hubId);
    const key = typeof decision === 'string' ? decision : 'deny';
    const press = t?.menu?.kind === 'permission' ? t.menu.keys.get(key) : undefined;
    if (!t || !press) {
      return res.status(400).json({ error: 'Permission decision was not offered or no permission request is pending' });
    }
    try {
      await sendKeys(s, [press]);
      closeMenu(s, t, key);
      res.json({ ok: true });
    } catch (err) {
      res.status(502).json({ error: (err as Error).message });
    }
  });

  // The answer is a label, a JSON map of question → label, free text, or "skip".
  app.post('/api/question-response', async (req, res) => {
    const { sessionId, answer } = req.body ?? {};
    const s = find(sessionId);
    if (!s) return res.status(404).json({ error: 'Session not found' });
    const t = tracked.get(s.hubId);
    let label = String(answer ?? 'skip');
    try {
      const parsed = JSON.parse(label);
      if (parsed && typeof parsed === 'object') label = String(Object.values(parsed)[0] ?? 'skip');
    } catch {
      /* a plain string */
    }
    try {
      const press = t?.menu?.keys.get(label.trim().toLowerCase());
      if (label === 'skip') await sendKeys(s, ['esc']);
      else if (press) await sendKeys(s, [press]);
      else {
        // free text: open the menu's write-in option if it has one, then
        // type the answer and submit
        const writeIn = [...(t?.menu?.keys.entries() ?? [])].find(([k]) => /type something|other/.test(k));
        if (writeIn) {
          await sendKeys(s, [writeIn[1]]);
          await sleep(200);
        }
        await hub(`/api/sessions/${s.hubId}/keys`, { method: 'POST', body: { data: label } });
        await sleep(120);
        await sendKeys(s, ['enter']);
      }
      if (t) closeMenu(s, t);
      emit(evenId(s), { type: 'question_answer', answers: { '0': label } });
      res.json({ ok: true });
    } catch (err) {
      res.status(502).json({ error: (err as Error).message });
    }
  });

  app.post('/api/interrupt', async (req, res) => {
    const s = find(req.body?.sessionId);
    if (!s) return res.status(404).json({ error: 'Session not found' });
    try {
      await sendKeys(s, ['esc']);
      res.json({ ok: true });
    } catch (err) {
      res.status(502).json({ error: (err as Error).message });
    }
  });

  app.get('/api/metrics', (_req, res) => res.json({ codex: { subscribedSessions: [] } }));
  app.post('/api/codex/ensure-app-server', (_req, res) => res.json({ started: true, port: 0 }));

  const server = createServer(app);
  server.on('error', (err: NodeJS.ErrnoException) => {
    // most likely a real even-terminal already owns the port — leave it be
    console.warn(`[even] glasses bridge not started on port ${port}: ${err.code ?? err.message}`);
    clearInterval(timer);
  });
  server.listen(port, '0.0.0.0', () => console.log(`[even] glasses bridge on port ${port}`));
  return server;
}

import type { AdminStatus, AgentInfo, FleetFolderGroup, FleetMachine, HandoffJob, ResumeJob, SessionInfo } from './types';

const mq = (machine?: string) => (machine ? `?machine=${encodeURIComponent(machine)}` : '');

/**
 * Run a launch call; if the hub answers ACTIVE_ELSEWHERE (live session in the
 * same folder on another machine), ask the human and retry with force.
 */
export async function withElsewhereConfirm<T>(run: (force: boolean) => Promise<T>): Promise<T> {
  try {
    return await run(false);
  } catch (err) {
    const text = String(err);
    if (!text.includes('ACTIVE_ELSEWHERE')) throw err;
    const machines = text.match(/"machines":\[([^\]]*)\]/)?.[1]?.replace(/"/g, '') || 'another machine';
    if (
      !confirm(
        `This folder has a LIVE session on: ${machines}.\n\nTwo Claudes working the same folder can overwrite each other's changes (and git state). Continue anyway?`,
      )
    ) {
      throw new Error('cancelled');
    }
    return run(true);
  }
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
  return res.json();
}

export const api = {
  sessions: () => fetch('/api/sessions').then((r) => json<SessionInfo[]>(r)),
  fleet: () => fetch('/api/fleet').then((r) => json<FleetMachine[]>(r)),
  agents: (machine?: string) =>
    fetch(`/api/agents${machine ? `?machine=${encodeURIComponent(machine)}` : ''}`).then((r) =>
      json<AgentInfo[]>(r),
    ),
  projects: (machine?: string) =>
    fetch(`/api/projects${machine ? `?machine=${encodeURIComponent(machine)}` : ''}`).then((r) =>
      json<{ name: string; path: string }[]>(r),
    ),
  spawn: (body: {
    cwd?: string;
    /** create this folder under the target's projects root and start there */
    newFolder?: string;
    agentType?: string;
    name?: string;
    model?: string;
    permissionMode?: string;
    initialPrompt?: string;
    machine?: string;
    force?: boolean;
  }) =>
    fetch('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => json<SessionInfo>(r)),
  conversations: () =>
    fetch('/api/conversations').then((r) =>
      json<
        {
          claudeSessionId: string;
          cwd?: string;
          title?: string;
          lastText?: string;
          updatedAt: number;
          activeElsewhere: boolean;
        }[]
      >(r),
    ),
  adopt: (body: { claudeSessionId: string; cwd: string; name?: string }) =>
    fetch('/api/sessions/adopt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => json<SessionInfo>(r)),
  dropFile: (hubId: string, file: File) =>
    fetch(`/api/sessions/${hubId}/drop?name=${encodeURIComponent(file.name)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: file,
    }).then((r) => json<{ path: string }>(r)),
  fleetFolders: () => fetch('/api/fleet-folders').then((r) => json<FleetFolderGroup[]>(r)),
  fleetResume: (body: {
    folder: string;
    agentType?: string;
    claudeSessionId: string;
    sourceMachine?: string;
    machine?: string;
    force?: boolean;
  }) =>
    fetch('/api/fleet-resume', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => json<{ jobId: string; machine: string }>(r)),
  handoff: (
    hubId: string,
    body: {
      targetAgent: string;
      targetMachine?: string;
      targetFolder?: string;
      newFolder?: string;
      askBrief: boolean;
      includeDialogue: boolean;
      model?: string;
      permissionMode?: string;
    },
  ) =>
    fetch(`/api/sessions/${hubId}/handoff`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => json<{ jobId: string; machine: string }>(r)),
  handoffStatus: (jobId: string, machine?: string) =>
    fetch(`/api/handoff/${jobId}${mq(machine)}`).then((r) => json<HandoffJob>(r)),
  fleetResumeStatus: (jobId: string, machine?: string) =>
    fetch(`/api/fleet-resume/${jobId}${machine ? `?machine=${encodeURIComponent(machine)}` : ''}`).then(
      (r) => json<ResumeJob>(r),
    ),
  adminStatus: (machine?: string) =>
    fetch(`/api/admin/status${mq(machine)}`).then((r) => json<AdminStatus>(r)),
  adminCheck: (machine?: string) =>
    fetch(`/api/admin/check${mq(machine)}`, { method: 'POST' }).then((r) => json<unknown>(r)),
  adminUpdate: (machine?: string) =>
    fetch(`/api/admin/update${mq(machine)}`, { method: 'POST' }).then((r) => json<unknown>(r)),
  adminRestart: (machine?: string) =>
    fetch(`/api/admin/restart${mq(machine)}`, { method: 'POST' }).then((r) => json<unknown>(r)),
  autoYes: (hubId: string, on: boolean) =>
    fetch(`/api/sessions/${hubId}/autoyes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ on }),
    }).then((r) => json<{ ok: boolean; autoYes: boolean }>(r)),
  kill: (hubId: string) => fetch(`/api/sessions/${hubId}/kill`, { method: 'POST' }),
  resumeForce: (hubId: string, force: boolean) =>
    fetch(`/api/sessions/${hubId}/resume`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ force }),
    }).then((r) => json<SessionInfo>(r)),
  resume: (hubId: string) => fetch(`/api/sessions/${hubId}/resume`, { method: 'POST' }),
  remove: (hubId: string) => fetch(`/api/sessions/${hubId}/remove`, { method: 'POST' }),
};

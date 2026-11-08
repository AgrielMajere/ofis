import { TRANSPORT_STATE_CONNECTED } from '../../../core/src/constants.js';
import type { ClientMessage, ServerMessage } from '../../../core/src/messages.js';
import type { MessageTransport, TransportState } from './types.js';

/**
 * Demo transport for the static web build (GitHub Pages).
 *
 * There is no Pixel Agents server behind a static page, so this transport
 * plays the server's part locally: the office assets come from browserMock
 * (bridged in as window 'message' events), the layout and agent seats persist
 * in localStorage, and a few simulated agents walk to their desks and "work".
 * "+ Agent" spawns another simulated agent; closing one removes it.
 */

const DEMO_VERSION = '1.5.0';
const LS_LAYOUT = 'pixelAgentsDemo.layout';
const LS_SEATS = 'pixelAgentsDemo.seats';
const LS_SETTINGS = 'pixelAgentsDemo.settings';

const DEMO_DIRECTORIES = [
  { name: 'game', path: '/demo/game', source: 'user' as const },
  { name: 'website', path: '/demo/website', source: 'user' as const },
  { name: 'bot', path: '/demo/bot', source: 'user' as const },
];

const DEMO_TOOLS: Array<{ toolName: string; status: string }> = [
  { toolName: 'Read', status: 'Reading src/main.ts' },
  { toolName: 'Grep', status: 'Searching "TODO"' },
  { toolName: 'Edit', status: 'Editing src/office.ts' },
  { toolName: 'Write', status: 'Writing README.md' },
  { toolName: 'Bash', status: 'Running npm test' },
  { toolName: 'Glob', status: 'Finding **/*.tsx' },
  { toolName: 'WebFetch', status: 'Fetching docs' },
  { toolName: 'Edit', status: 'Editing package.json' },
];

function lsGet<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function lsSet(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // storage unavailable (private mode etc.) — the demo still works, it just forgets
  }
}

export function loadDemoLayout(): Record<string, unknown> | null {
  return lsGet<Record<string, unknown>>(LS_LAYOUT);
}

interface DemoAgent {
  id: number;
  dir: string;
  timer: ReturnType<typeof setTimeout> | null;
  toolSeq: number;
  activeToolId: string | null;
}

export class DemoTransport implements MessageTransport {
  private handlers: Array<(msg: ServerMessage) => void> = [];
  private readonly agents = new Map<number, DemoAgent>();
  private nextId = 1;
  private started = false;
  private disposed = false;
  readonly ready: Promise<void> = Promise.resolve();
  readonly state: TransportState = TRANSPORT_STATE_CONNECTED;

  constructor() {
    // browserMock injects asset/layout messages as window events.
    window.addEventListener('message', (e: MessageEvent) => {
      const data = e.data as unknown;
      if (
        data &&
        typeof data === 'object' &&
        typeof (data as { type?: unknown }).type === 'string'
      ) {
        this.deliver(data as ServerMessage);
        // The layout is the last asset message: the office is ready for agents.
        if ((data as { type: string }).type === 'layoutLoaded') this.startDemo();
      }
    });
  }

  private deliver(message: ServerMessage): void {
    for (const handler of this.handlers) handler(message);
  }

  private emit(message: Record<string, unknown>): void {
    this.deliver(message as unknown as ServerMessage);
  }

  private startDemo(): void {
    if (this.started || this.disposed) return;
    this.started = true;
    const settings = lsGet<Record<string, unknown>>(LS_SETTINGS) ?? {};
    this.emit({
      type: 'settingsLoaded',
      soundEnabled: false,
      lastSeenVersion: '1.5',
      extensionVersion: DEMO_VERSION,
      watchAllSessions: false,
      alwaysShowLabels: true,
      ghostHeadlessAgents: false,
      hooksEnabled: false,
      hooksInfoShown: true,
      externalAssetDirectories: [],
      showAreas: false,
      bypassPermissions: false,
      showHostDirectories: false,
      ...settings,
    });
    this.emit({ type: 'directoriesLoaded', directories: DEMO_DIRECTORIES });
    this.emit({ type: 'terminalAvailability', available: true });
    // Seats saved by a previous visit keep each agent at the same desk/colour.
    const seats =
      lsGet<Record<string, { palette: number; hueShift: number; seatId: string | null }>>(LS_SEATS);
    const initial = [1, 2, 3];
    this.nextId = 4;
    const agentMeta: Record<string, unknown> = {};
    const directoryNames: Record<string, string> = {};
    initial.forEach((id, i) => {
      const dir = DEMO_DIRECTORIES[i % DEMO_DIRECTORIES.length].name;
      directoryNames[id] = dir;
      const s = seats?.[id];
      if (s)
        agentMeta[id] = { palette: s.palette, hueShift: s.hueShift, seatId: s.seatId ?? undefined };
      this.agents.set(id, { id, dir, timer: null, toolSeq: 0, activeToolId: null });
    });
    this.emit({
      type: 'existingAgents',
      agents: initial,
      agentMeta,
      directoryNames,
      externalAgents: {},
    });
    initial.forEach((id, i) => this.schedule(id, 1500 + i * 1200));
  }

  /** Each simulated agent alternates bursts of tool use with idle breaks. */
  private schedule(id: number, delay: number): void {
    const agent = this.agents.get(id);
    if (!agent || this.disposed) return;
    agent.timer = setTimeout(() => this.step(id), delay);
  }

  private step(id: number): void {
    const agent = this.agents.get(id);
    if (!agent) return;
    if (agent.activeToolId) {
      this.emit({ type: 'agentToolDone', id, toolId: agent.activeToolId });
      agent.activeToolId = null;
      // ~30% chance to finish the turn and wait for "input" for a while.
      if (Math.random() < 0.3) {
        this.emit({ type: 'agentToolsClear', id });
        this.emit({ type: 'agentStatus', id, status: 'waiting' });
        this.schedule(id, 6000 + Math.random() * 9000);
        return;
      }
      this.schedule(id, 400 + Math.random() * 800);
      return;
    }
    const tool = DEMO_TOOLS[Math.floor(Math.random() * DEMO_TOOLS.length)];
    agent.toolSeq += 1;
    agent.activeToolId = `demo-${id}-${agent.toolSeq}`;
    this.emit({ type: 'agentStatus', id, status: 'active' });
    this.emit({
      type: 'agentToolStart',
      id,
      toolId: agent.activeToolId,
      toolName: tool.toolName,
      status: tool.status,
    });
    this.schedule(id, 2000 + Math.random() * 4000);
  }

  private spawn(dirPath?: string): void {
    const dir = DEMO_DIRECTORIES.find((d) => d.path === dirPath)?.name ?? DEMO_DIRECTORIES[0].name;
    const id = this.nextId++;
    this.agents.set(id, { id, dir, timer: null, toolSeq: 0, activeToolId: null });
    this.emit({ type: 'agentCreated', id, directoryName: dir });
    this.schedule(id, 1500);
  }

  private close(id: number): void {
    const agent = this.agents.get(id);
    if (!agent) return;
    if (agent.timer) clearTimeout(agent.timer);
    this.agents.delete(id);
    this.emit({ type: 'agentClosed', id });
  }

  send(message: ClientMessage): void {
    const msg = message as unknown as Record<string, unknown> & { type: string };
    switch (msg.type) {
      case 'launchAgent':
        this.spawn(msg.directoryPath as string | undefined);
        break;
      case 'closeAgent':
        this.close(msg.id as number);
        break;
      case 'focusAgent':
        this.emit({ type: 'agentSelected', id: msg.id });
        break;
      case 'saveLayout':
        lsSet(LS_LAYOUT, msg.layout);
        break;
      case 'saveAgentSeats':
        lsSet(LS_SEATS, msg.seats);
        break;
      case 'setSoundEnabled':
      case 'setAlwaysShowLabels':
      case 'setGhostHeadlessAgents':
      case 'setLastSeenVersion': {
        const settings = lsGet<Record<string, unknown>>(LS_SETTINGS) ?? {};
        const { type, ...rest } = msg;
        const key =
          type === 'setSoundEnabled'
            ? 'soundEnabled'
            : type === 'setAlwaysShowLabels'
              ? 'alwaysShowLabels'
              : type === 'setGhostHeadlessAgents'
                ? 'ghostHeadlessAgents'
                : 'lastSeenVersion';
        const value = Object.values(rest)[0];
        lsSet(LS_SETTINGS, { ...settings, [key]: value });
        break;
      }
      default:
        // Everything else (hooks, terminals, asset folders) needs a real server.
        break;
    }
  }

  onMessage(handler: (message: ServerMessage) => void): () => void {
    this.handlers.push(handler);
    return () => {
      this.handlers = this.handlers.filter((h) => h !== handler);
    };
  }

  onStateChange(): () => void {
    return () => {};
  }

  dispose(): void {
    this.disposed = true;
    for (const agent of this.agents.values()) if (agent.timer) clearTimeout(agent.timer);
    this.agents.clear();
    this.handlers = [];
  }
}

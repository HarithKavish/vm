import { type CSSProperties, type PointerEvent as ReactPointerEvent, useEffect, useMemo, useRef, useState } from 'react';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import './App.css';
import startIcon from './assets/start-icon.svg';
import folderIcon from './assets/icon-folder.svg';
import terminalIcon from './assets/icon-terminal.svg';
import settingsIcon from './assets/icon-settings.svg';
import notepadIcon from './assets/icon-notepad.svg';
import {
  ExtensionVMConnection,
  type ConnectionProfile,
  type FileEntry,
  VMConnectionError,
} from './connection';
import { getStoredHandle, setStoredHandle } from './handles';

type AppId = 'files' | 'terminal' | 'settings' | 'notepad';
type Screen = 'lock' | 'login' | 'desktop';
type SnapZone = 'left' | 'right' | 'top';
// A single open (or closed-but-persistent) window. Most apps here only ever have one
// instance - files/terminal/settings keep a single fixed-id instance for their whole
// lifetime (created once, toggled open/closed) so stateful children like xterm.js never
// get unmounted. Notepad is the exception: each open file gets its own instance, created
// and fully removed on close, so multiple files can be open at once.
type WindowInstance = {
  id: string;
  appId: AppId;
  closed: boolean;
  minimized: boolean;
  maximized: boolean;
  snapped: SnapZone | null;
  x: number;
  y: number;
  zIndex: number;
};
// Notepad's editable content lives outside WindowInstance, keyed separately by instance id,
// so typing in one Notepad window doesn't churn the `windows` array that position-clamping
// and z-order effects watch - those only care about window chrome, not keystrokes.
type NotepadState = {
  path: string | null;
  content: string;
  savedContent: string;
  loading: boolean;
  saving: boolean;
  error: string;
};
type IconPosition = { x: number; y: number };

const SNAP_EDGE_THRESHOLD = 24;

type AppDescriptor = {
  id: AppId;
  name: string;
  icon: string;
  requiresConnection: boolean;
};

const APPS: AppDescriptor[] = [
  { id: 'files', name: 'File Explorer', icon: folderIcon, requiresConnection: true },
  { id: 'terminal', name: 'Terminal', icon: terminalIcon, requiresConnection: true },
  { id: 'notepad', name: 'Notepad', icon: notepadIcon, requiresConnection: true },
  { id: 'settings', name: 'Settings', icon: settingsIcon, requiresConnection: false },
];

// files/terminal/settings each get exactly one persistent instance, present from the start
// (just closed) - notepad has none initially, since instances are created on demand per file.
const initialWindows: WindowInstance[] = [
  { id: 'files', appId: 'files', closed: false, minimized: false, maximized: false, snapped: null, x: 132, y: 34, zIndex: 0 },
  { id: 'terminal', appId: 'terminal', closed: true, minimized: false, maximized: false, snapped: null, x: 176, y: 78, zIndex: 0 },
  { id: 'settings', appId: 'settings', closed: true, minimized: false, maximized: false, snapped: null, x: 210, y: 60, zIndex: 0 },
];

const ICON_GRID_X = 96;
const ICON_GRID_Y = 96;
const ICON_ORIGIN_X = 0;
const ICON_ORIGIN_Y = 0;

const defaultIconPositions: Record<AppId, IconPosition> = {
  files: { x: ICON_ORIGIN_X, y: ICON_ORIGIN_Y },
  terminal: { x: ICON_ORIGIN_X, y: ICON_ORIGIN_Y + ICON_GRID_Y },
  notepad: { x: ICON_ORIGIN_X, y: ICON_ORIGIN_Y + ICON_GRID_Y * 2 },
  settings: { x: ICON_ORIGIN_X, y: ICON_ORIGIN_Y + ICON_GRID_Y * 3 },
};

// Which app opens a file of a given extension by default - currently just Notepad for
// plain text files. Extend this map (and give the new app an icon) to add more associations.
const DEFAULT_APP_BY_EXTENSION: Partial<Record<string, AppId>> = {
  txt: 'notepad',
};

const FILE_TYPE_ICONS: Partial<Record<AppId, string>> = {
  notepad: notepadIcon,
};

const fileExtension = (name: string) => {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
};

const defaultAppFor = (fileName: string): AppId | undefined => DEFAULT_APP_BY_EXTENSION[fileExtension(fileName)];

const fileTypeIcon = (fileName: string): string | undefined => {
  const appId = defaultAppFor(fileName);
  return appId ? FILE_TYPE_ICONS[appId] : undefined;
};

const ICON_POSITIONS_KEY = 'vm-desktop-icon-positions';
const WALLPAPER_KEY = 'vm-desktop-wallpaper';

const snapToGrid = (value: number, grid: number, origin: number) =>
  Math.max(origin, origin + Math.round((value - origin) / grid) * grid);

const loadIconPositions = (): Record<AppId, IconPosition> => {
  try {
    const raw = window.localStorage.getItem(ICON_POSITIONS_KEY);
    if (!raw) {
      return defaultIconPositions;
    }
    const parsed = JSON.parse(raw) as Partial<Record<AppId, IconPosition>>;
    return { ...defaultIconPositions, ...parsed };
  } catch {
    return defaultIconPositions;
  }
};

const defaultProfile: ConnectionProfile = {
  id: 'local',
  name: 'Ubuntu VM',
  host: '',
  port: 22,
  username: 'ubuntu',
};
const LAST_TARGET_KEY = 'vm-desktop-last-target';

const parseTarget = (target: string) => {
  const trimmed = target.trim();
  const atIndex = trimmed.indexOf('@');
  if (atIndex <= 0 || atIndex === trimmed.length - 1) {
    return null;
  }

  const username = trimmed.slice(0, atIndex).trim();
  const hostPort = trimmed.slice(atIndex + 1).trim();
  if (!username || !hostPort) {
    return null;
  }

  const colonIndex = hostPort.lastIndexOf(':');
  if (colonIndex > 0 && colonIndex < hostPort.length - 1) {
    const host = hostPort.slice(0, colonIndex).trim();
    const portValue = Number(hostPort.slice(colonIndex + 1));
    if (host && Number.isInteger(portValue) && portValue > 0) {
      return { username, host, port: portValue };
    }
  }

  return { username, host: hostPort, port: 22 };
};

const formatTime = () =>
  new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date());

const formatLockDate = () =>
  new Intl.DateTimeFormat(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  }).format(new Date());

type PermissionState = 'granted' | 'denied' | 'prompt';
type FileHandleLike = {
  name: string;
  getFile(): Promise<File>;
  queryPermission?(opts: { mode: string }): Promise<PermissionState>;
  requestPermission?(opts: { mode: string }): Promise<PermissionState>;
};
type DirectoryHandleLike = {
  name: string;
  values(): AsyncIterable<{ kind: string; name: string; getFile?: () => Promise<File> }>;
  queryPermission?(opts: { mode: string }): Promise<PermissionState>;
  requestPermission?(opts: { mode: string }): Promise<PermissionState>;
};

const pickLocalDirectory = (): Promise<DirectoryHandleLike> | null => {
  const picker = (window as unknown as { showDirectoryPicker?: () => Promise<DirectoryHandleLike> })
    .showDirectoryPicker;
  return picker ? picker() : null;
};

const pickPrivateKeyFile = (): Promise<FileHandleLike[]> | null => {
  const picker = (
    window as unknown as {
      showOpenFilePicker?: (opts?: unknown) => Promise<FileHandleLike[]>;
    }
  ).showOpenFilePicker;
  return picker ? picker({ multiple: false }) : null;
};

const supportsFilePicker = typeof (window as unknown as { showOpenFilePicker?: unknown }).showOpenFilePicker === 'function';

const listImagesFromDirectory = async (
  dirHandle: DirectoryHandleLike,
): Promise<{ name: string; url: string }[]> => {
  const images: { name: string; url: string }[] = [];
  for await (const entry of dirHandle.values()) {
    if (entry.kind !== 'file' || !entry.getFile) {
      continue;
    }
    const file = await entry.getFile();
    if (!file.type.startsWith('image/')) {
      continue;
    }
    images.push({ name: file.name, url: URL.createObjectURL(file) });
  }
  return images;
};

const readFileAsDataUrl = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });

// `ok: false` means the request itself failed (transport/auth/protocol - see VMConnectionError).
// A command that ran but exited non-zero is still `ok: true`, with the real exit code in
// `exitCode` and its stdout/stderr (whatever the remote shell wrote) in `text`.
type CommandResult = { ok: boolean; text: string; exitCode?: number };

const shellQuote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;

const useTerminal = (
  onCommand: (command: string) => Promise<CommandResult>,
  connected: boolean,
) => {
  // A plain useRef + a [] effect misses the container: the div only mounts once the
  // Terminal window's section renders (gated by `connected`), which is false on the very
  // first render, so a mount-once effect would find ref.current still null. A callback ref
  // (stored in state) lets the init effect re-run exactly when the node actually appears.
  const [node, setNode] = useState<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const connectedRef = useRef(connected);
  const commandRef = useRef(onCommand);

  useEffect(() => {
    connectedRef.current = connected;
    terminalRef.current?.writeln(connected ? '\r\n[vm] connected' : '\r\n[vm] disconnected');
  }, [connected]);

  useEffect(() => {
    commandRef.current = onCommand;
  }, [onCommand]);

  useEffect(() => {
    if (!node || terminalRef.current) {
      return;
    }

    const terminal = new Terminal({
      convertEol: true,
      cursorBlink: true,
      fontFamily: 'Cascadia Mono, Consolas, monospace',
      fontSize: 13,
      theme: {
        background: '#0c1016',
        foreground: '#f2f4f8',
        cursor: '#ffffff',
        green: '#6ce38a',
      },
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(node);
    fitAddon.fit();
    terminalRef.current = terminal;
    fitRef.current = fitAddon;

    let input = '';
    let cursor = 0;
    const history: string[] = [];
    let historyIndex = 0;
    let historyDraft = '';
    const cwdRef: { current: string | null } = { current: null };
    const prompt = () => terminal.write(`\r\nubuntu@vm:${cwdRef.current ?? '~'}$ `);

    // Returns the cursor to the start of the current input, erases to end of line, writes
    // nextInput, then repositions the cursor at nextCursor - the one place that redraws the
    // line, used by history recall and mid-line edits so the visible line always matches
    // `input`/`cursor` exactly.
    const setLine = (nextInput: string, nextCursor: number) => {
      if (cursor > 0) {
        terminal.write(`\x1b[${cursor}D`);
      }
      terminal.write('\x1b[K');
      terminal.write(nextInput);
      const trailing = nextInput.length - nextCursor;
      if (trailing > 0) {
        terminal.write(`\x1b[${trailing}D`);
      }
      input = nextInput;
      cursor = nextCursor;
    };

    // A leading ~ needs to stay unquoted to still trigger the remote shell's tilde
    // expansion ($HOME) - quoting it (as shellQuote would) makes bash treat it as a
    // literal directory named "~", which doesn't exist. Only the part after it, if any,
    // gets quoted, so `cd ~/some dir` still can't break out into shell injection.
    const cdTargetArg = (target: string) => {
      if (target === '~') {
        return '~';
      }
      if (target.startsWith('~/')) {
        return `~/${shellQuote(target.slice(2))}`;
      }
      return shellQuote(target);
    };

    terminal.write('VM Desktop Terminal');
    // Seed the prompt with the real starting directory instead of assuming ~ - the SSH
    // session's actual login directory is whatever the server configured, and showing an
    // unverified guess is worse than one extra round trip before the first prompt.
    void (async () => {
      const result = await commandRef.current('pwd');
      if (result.ok && result.exitCode === 0) {
        cwdRef.current = result.text.trim() || cwdRef.current;
      }
      prompt();
    })();

    terminal.onData(async (data) => {
      if (!connectedRef.current) {
        return;
      }
      if (data === '\r') {
        const raw = input.trim();
        terminal.write('\r\n');
        input = '';
        cursor = 0;
        if (!raw) {
          historyIndex = history.length;
          prompt();
          return;
        }
        if (history[history.length - 1] !== raw) {
          history.push(raw);
        }
        historyIndex = history.length;

        const cdMatch = raw.match(/^cd(?:\s+(.*))?$/);
        if (cdMatch) {
          const targetArg = cdTargetArg((cdMatch[1] ?? '').trim() || '~');
          const cdCmd = cwdRef.current
            ? `cd ${shellQuote(cwdRef.current)} 2>/dev/null; cd ${targetArg} 2>&1 && pwd`
            : `cd ${targetArg} 2>&1 && pwd`;
          const result = await commandRef.current(cdCmd);
          if (result.ok && result.exitCode === 0) {
            cwdRef.current = result.text.trim().split('\n').pop() || cwdRef.current;
          } else {
            terminal.write(`\x1b[31m${result.text.trim() || `exit status ${result.exitCode}`}\x1b[0m`);
          }
          prompt();
          return;
        }

        const wrapped = cwdRef.current
          ? `cd ${shellQuote(cwdRef.current)} 2>/dev/null; ${raw}`
          : raw;
        const result = await commandRef.current(wrapped);
        if (!result.ok) {
          terminal.write(`\x1b[31m${result.text}\x1b[0m`);
        } else if (result.exitCode !== 0) {
          terminal.write(result.text ? `\x1b[31m${result.text}\x1b[0m` : `\x1b[31mexit status ${result.exitCode}\x1b[0m`);
        } else {
          terminal.write(result.text || '(no output)');
        }
        prompt();
        return;
      }

      if (data === '\x7f') {
        if (cursor > 0) {
          setLine(input.slice(0, cursor - 1) + input.slice(cursor), cursor - 1);
        }
        return;
      }
      if (data === '\x1b[3~') {
        if (cursor < input.length) {
          setLine(input.slice(0, cursor) + input.slice(cursor + 1), cursor);
        }
        return;
      }
      if (data === '\x1b[A') {
        if (history.length === 0) {
          return;
        }
        if (historyIndex === history.length) {
          historyDraft = input;
        }
        historyIndex = Math.max(0, historyIndex - 1);
        const next = history[historyIndex] ?? '';
        setLine(next, next.length);
        return;
      }
      if (data === '\x1b[B') {
        if (historyIndex >= history.length) {
          return;
        }
        historyIndex += 1;
        const next = historyIndex === history.length ? historyDraft : history[historyIndex];
        setLine(next, next.length);
        return;
      }
      if (data === '\x1b[C') {
        if (cursor < input.length) {
          terminal.write('\x1b[C');
          cursor += 1;
        }
        return;
      }
      if (data === '\x1b[D') {
        if (cursor > 0) {
          terminal.write('\x1b[D');
          cursor -= 1;
        }
        return;
      }
      if (data === '\x1b[H' || data === '\x1bOH' || data === '\x01') {
        if (cursor > 0) {
          terminal.write(`\x1b[${cursor}D`);
          cursor = 0;
        }
        return;
      }
      if (data === '\x1b[F' || data === '\x1bOF' || data === '\x05') {
        if (cursor < input.length) {
          terminal.write(`\x1b[${input.length - cursor}C`);
          cursor = input.length;
        }
        return;
      }
      if (data === '\x03') {
        terminal.write('^C');
        input = '';
        cursor = 0;
        historyIndex = history.length;
        prompt();
        return;
      }
      if (data === '\x0c') {
        terminal.clear();
        terminal.write(`ubuntu@vm:${cwdRef.current ?? '~'}$ ${input}`);
        const trailing = input.length - cursor;
        if (trailing > 0) {
          terminal.write(`\x1b[${trailing}D`);
        }
        return;
      }

      // Any other escape sequence (function keys, unsupported combos, ...) or stray
      // control character: swallow it instead of leaking raw bytes into the command line,
      // which used to get sent straight to the remote shell as garbage input.
      if (data.startsWith('\x1b') || (data.length === 1 && data.charCodeAt(0) < 0x20)) {
        return;
      }

      if (cursor === input.length) {
        input += data;
        cursor += data.length;
        terminal.write(data);
      } else {
        setLine(input.slice(0, cursor) + data + input.slice(cursor), cursor + data.length);
      }
    });

    const onResize = () => fitAddon.fit();
    window.addEventListener('resize', onResize);

    return () => {
      window.removeEventListener('resize', onResize);
      terminal.dispose();
      terminalRef.current = null;
      fitRef.current = null;
    };
  }, [node]);

  return setNode;
};

function App() {
  const [screen, setScreen] = useState<Screen>('lock');
  const [lockDate, setLockDate] = useState(formatLockDate);
  const [profile, setProfile] = useState<ConnectionProfile>(defaultProfile);
  const [target, setTarget] = useState(() => window.localStorage.getItem(LAST_TARGET_KEY) ?? 'ubuntu@');
  const [connected, setConnected] = useState(false);
  const [status, setStatus] = useState('Choose a key');
  const [error, setError] = useState('');
  const [explorerError, setExplorerError] = useState('');
  const [notepadState, setNotepadState] = useState<Record<string, NotepadState>>({});
  const [activeId, setActiveId] = useState<string>('files');
  const [windows, setWindows] = useState<WindowInstance[]>(initialWindows);
  const zCounterRef = useRef(1);
  const notepadCounterRef = useRef(0);
  // Apps mid-exit-animation on the taskbar: closeInstance marks the window closed immediately
  // (business state), but keeps the icon mounted here a bit longer so it can play the
  // shrink/fade-out animation instead of vanishing instantly. Tracked per-app (not per
  // instance): the icon only animates out when the LAST open instance of that app closes.
  const [closingApps, setClosingApps] = useState<AppId[]>([]);
  const [previewApp, setPreviewApp] = useState<AppId | null>(null);
  const previewTimeoutRef = useRef<number | null>(null);
  const [path, setPath] = useState('/');
  const [addressInput, setAddressInput] = useState('/');
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [clock, setClock] = useState(formatTime);
  const [startOpen, setStartOpen] = useState(false);
  const [startSearch, setStartSearch] = useState('');
  const [iconPositions, setIconPositions] = useState<Record<AppId, IconPosition>>(loadIconPositions);
  const [wallpaper, setWallpaper] = useState(() => window.localStorage.getItem(WALLPAPER_KEY) ?? '');
  const [wallpaperFolder, setWallpaperFolder] = useState('');
  const [wallpaperImages, setWallpaperImages] = useState<{ name: string; url: string }[]>([]);
  const [wallpaperStatus, setWallpaperStatus] = useState('');
  const [savedWallpaperFolderName, setSavedWallpaperFolderName] = useState('');
  const [savedKeyName, setSavedKeyName] = useState('');
  const [keyLookupDone, setKeyLookupDone] = useState(false);
  const [autoConnecting, setAutoConnecting] = useState(false);
  const autoConnectTriedRef = useRef(false);
  const [history, setHistory] = useState<string[]>(['/']);
  const [historyIndex, setHistoryIndex] = useState(0);
  const connection = useMemo(() => new ExtensionVMConnection(), []);
  const startMenuRef = useRef<HTMLDivElement | null>(null);
  const desktopRef = useRef<HTMLDivElement | null>(null);
  const windowElRefs = useRef<Partial<Record<string, HTMLElement>>>({});
  const [snapPreview, setSnapPreview] = useState<SnapZone | null>(null);

  useEffect(() => {
    const id = window.setInterval(() => {
      setClock(formatTime());
      setLockDate(formatLockDate());
    }, 15_000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    if (screen !== 'lock') {
      return;
    }
    const wake = () => setScreen('login');
    window.addEventListener('keydown', wake);
    window.addEventListener('pointerdown', wake);
    return () => {
      window.removeEventListener('keydown', wake);
      window.removeEventListener('pointerdown', wake);
    };
  }, [screen]);

  useEffect(() => {
    const parsed = parseTarget(target);
    if (!parsed) {
      return;
    }

    setProfile((current) => ({
      ...current,
      username: parsed.username,
      host: parsed.host,
      port: parsed.port,
      name: parsed.host,
    }));
  }, [target]);

  useEffect(() => {
    window.localStorage.setItem(ICON_POSITIONS_KEY, JSON.stringify(iconPositions));
  }, [iconPositions]);

  // Window default positions are fixed pixel offsets (a cascade look), but the window's own
  // width/height are CSS percentages of .desktop-surface. On a narrower viewport (a smaller
  // browser window, a laptop screen, etc.) that combination can push a window's right/bottom
  // edge — and with it the maximize/close buttons — past the visible area, where .os-shell's
  // overflow:hidden clips them into being unclickable. Re-clamp every open window's position to
  // stay fully inside .desktop-surface whenever a window opens or the viewport resizes.
  const clampWindowsToViewport = () => {
    const bounds = desktopRef.current?.getBoundingClientRect();
    if (!bounds) {
      return;
    }
    setWindows((current) => {
      let changed = false;
      const next = current.map((w) => {
        if (w.closed || w.maximized || w.snapped) {
          return w;
        }
        const el = windowElRefs.current[w.id];
        const rect = el?.getBoundingClientRect();
        if (!rect || rect.width <= 0 || rect.height <= 0) {
          return w;
        }
        const maxX = Math.max(8, bounds.width - rect.width - 8);
        const maxY = Math.max(8, bounds.height - rect.height - 8);
        const clampedX = Math.min(Math.max(8, w.x), maxX);
        const clampedY = Math.min(Math.max(8, w.y), maxY);
        if (clampedX !== w.x || clampedY !== w.y) {
          changed = true;
          return { ...w, x: clampedX, y: clampedY };
        }
        return w;
      });
      return changed ? next : current;
    });
  };

  // A string, not the array itself, so dragging (which updates x/y every pointermove) and
  // notepad typing (which lives outside `windows` entirely) don't retrigger this - only an
  // actual open/close transition, or a window appearing/disappearing, should.
  const openClosedSignature = windows.map((w) => `${w.id}:${w.closed ? 1 : 0}`).join(',');

  useEffect(() => {
    const raf = requestAnimationFrame(clampWindowsToViewport);
    return () => cancelAnimationFrame(raf);
  }, [openClosedSignature, screen, connected]);

  useEffect(() => {
    window.addEventListener('resize', clampWindowsToViewport);
    return () => window.removeEventListener('resize', clampWindowsToViewport);
  }, []);

  useEffect(() => {
    if (wallpaper) {
      window.localStorage.setItem(WALLPAPER_KEY, wallpaper);
    } else {
      window.localStorage.removeItem(WALLPAPER_KEY);
    }
  }, [wallpaper]);

  useEffect(() => {
    if (!startOpen) {
      return;
    }
    const onPointerDown = (event: PointerEvent) => {
      if (startMenuRef.current && !startMenuRef.current.contains(event.target as Node)) {
        setStartOpen(false);
        setStartSearch('');
      }
    };
    window.addEventListener('pointerdown', onPointerDown);
    return () => window.removeEventListener('pointerdown', onPointerDown);
  }, [startOpen]);

  useEffect(() => {
    void (async () => {
      const handle = await getStoredHandle<FileHandleLike>('sshKeyHandle');
      if (!handle) {
        setKeyLookupDone(true);
        return;
      }
      setSavedKeyName(handle.name);
      const perm = (await handle.queryPermission?.({ mode: 'read' })) ?? 'prompt';
      if (perm === 'granted') {
        const file = await handle.getFile();
        const content = await file.text();
        setProfile((current) => ({
          ...current,
          privateKeyContent: content,
          privateKeyName: file.name,
          privateKeyPath: '',
        }));
        setStatus(`${file.name} selected`);
      }
      setKeyLookupDone(true);
    })();

    void (async () => {
      const handle = await getStoredHandle<DirectoryHandleLike>('wallpaperFolderHandle');
      if (!handle) {
        return;
      }
      setSavedWallpaperFolderName(handle.name);
      const perm = (await handle.queryPermission?.({ mode: 'read' })) ?? 'prompt';
      if (perm === 'granted') {
        setWallpaperFolder(handle.name);
        setWallpaperImages(await listImagesFromDirectory(handle));
      }
    })();
  }, []);

  const execute = async (command: string): Promise<CommandResult> => {
    try {
      const { output, exitCode } = await connection.executeCommand(command);
      return { ok: true, text: output, exitCode };
    } catch (e) {
      const err = e as VMConnectionError;
      const text = `${err.code}: ${err.message}`;
      setError(text);
      return { ok: false, text };
    }
  };

  const terminalNodeRef = useTerminal(execute, connected);

  const instancesFor = (appId: AppId) => windows.filter((w) => w.appId === appId);
  const openInstancesFor = (appId: AppId) => instancesFor(appId).filter((w) => !w.closed);
  const topmostInstance = (instances: WindowInstance[]) =>
    instances.reduce<WindowInstance | null>((best, w) => (!best || w.zIndex > best.zIndex ? w : best), null);

  // Bumps a window's z-index above every other window and marks it active - the single
  // path all "bring this window forward" interactions (open, click, drag, maximize) go
  // through, so the topmost window and the active one never drift apart.
  const bringToFront = (
    instanceId: string,
    patch?: Partial<WindowInstance> | ((w: WindowInstance) => Partial<WindowInstance>),
  ) => {
    zCounterRef.current += 1;
    const z = zCounterRef.current;
    setActiveId(instanceId);
    setWindows((current) =>
      current.map((w) =>
        w.id === instanceId
          ? { ...w, ...(typeof patch === 'function' ? patch(w) : patch), zIndex: z }
          : w,
      ),
    );
  };

  // When the active window is hidden (minimized/closed), focus whichever remaining
  // visible window is now topmost - otherwise `activeId` keeps pointing at a hidden
  // window and nothing on screen reads as focused.
  const focusTopmostVisible = (excludeId: string) => {
    const next = topmostInstance(windows.filter((w) => w.id !== excludeId && !w.closed && !w.minimized));
    if (next) {
      setActiveId(next.id);
    }
  };

  // Opens (or focuses, if one's already open) the given app's window. For files/terminal/
  // settings that's the single persistent instance; for notepad with nothing open yet, it's
  // a fresh blank "Untitled" window (opening a *specific* file goes through openInNotepad
  // instead, which reuses an already-open instance for that path or creates a new one).
  const openOrFocusApp = (appId: AppId) => {
    setStartOpen(false);
    const open = openInstancesFor(appId);
    if (open.length > 0) {
      const top = topmostInstance(open);
      if (top) {
        bringToFront(top.id, { minimized: false });
      }
      return;
    }
    if (appId === 'notepad') {
      createNotepadInstance(null);
      return;
    }
    bringToFront(appId, { closed: false, minimized: false });
  };

  const minimizeWindow = (instanceId: string) => {
    setWindows((current) => current.map((w) => (w.id === instanceId ? { ...w, minimized: true } : w)));
    if (activeId === instanceId) {
      focusTopmostVisible(instanceId);
    }
  };

  // Taskbar/Start-menu click on an app (not a specific window): toggle the topmost open
  // instance the same way a single-window app always has, or open one if none are open.
  const toggleApp = (appId: AppId) => {
    const open = openInstancesFor(appId);
    if (open.length === 0) {
      openOrFocusApp(appId);
      return;
    }
    const top = topmostInstance(open);
    if (!top) {
      return;
    }
    if (activeId === top.id && !top.minimized) {
      minimizeWindow(top.id);
    } else {
      bringToFront(top.id, { minimized: false });
    }
  };

  const maximizeWindow = (instanceId: string) => {
    bringToFront(instanceId, (w) => ({ maximized: !w.maximized, minimized: false, snapped: null }));
  };

  const TASKBAR_EXIT_MS = 160;

  // files/terminal/settings keep their single instance around (just closed:true) so
  // stateful children like xterm.js never get unmounted; notepad instances are fully
  // removed, since a plain controlled <textarea> has nothing worth preserving once closed.
  const closeInstance = (instanceId: string) => {
    const instance = windows.find((w) => w.id === instanceId);
    if (!instance) {
      return;
    }
    const appId = instance.appId;
    const remainingOpen = openInstancesFor(appId).filter((w) => w.id !== instanceId).length;
    if (remainingOpen === 0) {
      setClosingApps((current) => (current.includes(appId) ? current : [...current, appId]));
      window.setTimeout(() => {
        setClosingApps((current) => current.filter((a) => a !== appId));
      }, TASKBAR_EXIT_MS);
    }

    if (appId === 'notepad') {
      setWindows((current) => current.filter((w) => w.id !== instanceId));
      setNotepadState((current) => {
        const next = { ...current };
        delete next[instanceId];
        return next;
      });
    } else {
      setWindows((current) =>
        current.map((w) => (w.id === instanceId ? { ...w, closed: true, minimized: false, maximized: false } : w)),
      );
    }
    if (activeId === instanceId) {
      focusTopmostVisible(instanceId);
    }
  };

  const beginDrag = (instanceId: string, event: ReactPointerEvent<HTMLElement>) => {
    const instance = windows.find((w) => w.id === instanceId);
    if (!instance || instance.maximized || event.button !== 0) {
      return;
    }

    const startX = event.clientX;
    const startY = event.clientY;
    const wasSnapped = instance.snapped;
    // Popping a snapped window back to free-floating starts it roughly under the cursor,
    // matching how Windows 11 un-snaps a window the moment you start dragging it away.
    const startWindow = wasSnapped ? { x: startX - 60, y: Math.max(8, startY - 8) } : instance;
    const pointerId = event.pointerId;
    const titlebar = event.currentTarget;
    titlebar.setPointerCapture(pointerId);
    bringToFront(instanceId);

    if (wasSnapped) {
      setWindows((current) =>
        current.map((w) => (w.id === instanceId ? { ...w, snapped: null, x: startWindow.x, y: startWindow.y } : w)),
      );
    }

    let zone: SnapZone | null = null;

    const moveWindow = (moveEvent: PointerEvent) => {
      const nextX = Math.max(8, startWindow.x + moveEvent.clientX - startX);
      const nextY = Math.max(8, startWindow.y + moveEvent.clientY - startY);
      setWindows((current) =>
        current.map((w) => (w.id === instanceId ? { ...w, x: nextX, y: nextY } : w)),
      );

      const bounds = desktopRef.current?.getBoundingClientRect();
      let nextZone: SnapZone | null = null;
      if (bounds) {
        const px = moveEvent.clientX - bounds.left;
        const py = moveEvent.clientY - bounds.top;
        if (py <= SNAP_EDGE_THRESHOLD) {
          nextZone = 'top';
        } else if (px <= SNAP_EDGE_THRESHOLD) {
          nextZone = 'left';
        } else if (px >= bounds.width - SNAP_EDGE_THRESHOLD) {
          nextZone = 'right';
        }
      }
      if (nextZone !== zone) {
        zone = nextZone;
        setSnapPreview(nextZone);
      }
    };

    const stopDrag = () => {
      titlebar.releasePointerCapture(pointerId);
      window.removeEventListener('pointermove', moveWindow);
      window.removeEventListener('pointerup', stopDrag);
      setSnapPreview(null);
      if (zone === 'top') {
        setWindows((current) =>
          current.map((w) => (w.id === instanceId ? { ...w, maximized: true, snapped: null } : w)),
        );
      } else if (zone) {
        setWindows((current) =>
          current.map((w) => (w.id === instanceId ? { ...w, snapped: zone, maximized: false } : w)),
        );
      }
    };

    window.addEventListener('pointermove', moveWindow);
    window.addEventListener('pointerup', stopDrag);
  };

  const beginIconDrag = (id: AppId, event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) {
      return;
    }

    const startX = event.clientX;
    const startY = event.clientY;
    const startPos = iconPositions[id];
    const pointerId = event.pointerId;
    const target = event.currentTarget;
    let dragged = false;

    const movePointer = (moveEvent: PointerEvent) => {
      const dx = moveEvent.clientX - startX;
      const dy = moveEvent.clientY - startY;
      if (!dragged && Math.hypot(dx, dy) > 4) {
        dragged = true;
        target.setPointerCapture(pointerId);
        target.classList.add('is-dragging');
      }
      if (!dragged) {
        return;
      }
      setIconPositions((current) => ({
        ...current,
        [id]: {
          x: snapToGrid(startPos.x + dx, ICON_GRID_X, ICON_ORIGIN_X),
          y: snapToGrid(startPos.y + dy, ICON_GRID_Y, ICON_ORIGIN_Y),
        },
      }));
    };

    const stopDrag = () => {
      window.removeEventListener('pointermove', movePointer);
      window.removeEventListener('pointerup', stopDrag);
      target.classList.remove('is-dragging');
      if (dragged) {
        target.releasePointerCapture(pointerId);
        // Suppress the click that follows pointerup after a real drag.
        target.dataset.suppressClick = '1';
      }
    };

    window.addEventListener('pointermove', movePointer);
    window.addEventListener('pointerup', stopDrag);
  };

  const handleIconClick = (id: AppId, event: React.MouseEvent<HTMLButtonElement>) => {
    if (event.currentTarget.dataset.suppressClick) {
      delete event.currentTarget.dataset.suppressClick;
      return;
    }
    openOrFocusApp(id);
  };

  const navigateTo = async (nextPath: string, opts?: { fromHistory?: boolean }) => {
    if (!connected) {
      return;
    }
    try {
      const list = await connection.listDirectory(nextPath);
      setEntries(list);
      setSelectedPath(null);
      setPath(nextPath);
      setAddressInput(nextPath);
      setExplorerError('');
      if (!opts?.fromHistory) {
        setHistory((current) => [...current.slice(0, historyIndex + 1), nextPath]);
        setHistoryIndex((current) => current + 1);
      }
    } catch (e) {
      const err = e as VMConnectionError;
      setExplorerError(`${err.code}: ${err.message}`);
    }
  };

  const goBack = () => {
    if (historyIndex === 0) {
      return;
    }
    const nextIndex = historyIndex - 1;
    setHistoryIndex(nextIndex);
    void navigateTo(history[nextIndex], { fromHistory: true });
  };

  const goForward = () => {
    if (historyIndex >= history.length - 1) {
      return;
    }
    const nextIndex = historyIndex + 1;
    setHistoryIndex(nextIndex);
    void navigateTo(history[nextIndex], { fromHistory: true });
  };

  const refreshDirectory = () => void navigateTo(path, { fromHistory: true });

  const handleKeyFile = async (file?: File) => {
    if (!file) {
      return;
    }

    const content = await file.text();
    setProfile((current) => ({
      ...current,
      privateKeyContent: content,
      privateKeyName: file.name,
      privateKeyPath: '',
    }));
    setStatus(`${file.name} selected`);
    setError('');
  };

  const chooseKeyFile = async () => {
    const pending = pickPrivateKeyFile();
    if (!pending) {
      return;
    }
    try {
      const [handle] = await pending;
      if (!handle) {
        return;
      }
      const file = await handle.getFile();
      await handleKeyFile(file);
      setSavedKeyName(handle.name);
      await setStoredHandle('sshKeyHandle', handle);
    } catch {
      // Picker cancelled.
    }
  };

  const applySavedKey = async () => {
    const handle = await getStoredHandle<FileHandleLike>('sshKeyHandle');
    if (!handle) {
      return;
    }
    const perm = (await handle.requestPermission?.({ mode: 'read' })) ?? 'denied';
    if (perm !== 'granted') {
      setStatus('Permission to reuse the saved key was denied.');
      return;
    }
    const file = await handle.getFile();
    await handleKeyFile(file);
  };

  const connect = async () => {
    const parsed = parseTarget(target);
    if (!parsed) {
      setError('Use the format ubuntu@w.x.y.z or ubuntu@w.x.y.z:22');
      return;
    }

    setError('');
    setStatus('Connecting...');
    try {
      const nextProfile = {
        ...profile,
        username: parsed.username,
        host: parsed.host,
        port: parsed.port,
        name: parsed.host,
      };
      await connection.connect(nextProfile, { userConsent: true });
      const list = await connection.listDirectory('/');
      setEntries(list);
      setPath('/');
      setAddressInput('/');
      setHistory(['/']);
      setHistoryIndex(0);
      setConnected(true);
      setActiveId('files');
      setProfile(nextProfile);
      window.localStorage.setItem(LAST_TARGET_KEY, target.trim());
      setWindows((current) =>
        current.map((w) => (w.id === 'files' ? { ...w, closed: false, minimized: false } : w)),
      );
      setStatus('Connected');
    } catch (e) {
      const err = e as VMConnectionError;
      if (err.code === 'HOST_UNTRUSTED') {
        const fingerprint = err.message.match(/SHA256:[A-Za-z0-9+/=]+/)?.[0];
        if (fingerprint && window.confirm(`Unknown host. Trust ${fingerprint}?`)) {
          await connection.trustHost(parsed.host, fingerprint);
          await connect();
          return;
        }
      }
      setConnected(false);
      setStatus('Disconnected');
      setError(`${err.code}: ${err.message}`);
    }
  };

  useEffect(() => {
    if (
      screen !== 'desktop' ||
      connected ||
      autoConnectTriedRef.current ||
      !keyLookupDone
    ) {
      return;
    }
    autoConnectTriedRef.current = true;
    if (!profile.privateKeyContent || !parseTarget(target)) {
      return;
    }
    setAutoConnecting(true);
    void connect().finally(() => setAutoConnecting(false));
  }, [screen, connected, keyLookupDone, profile.privateKeyContent, target]);

  const disconnect = async () => {
    await connection.disconnect();
    setConnected(false);
    setStatus('Disconnected');
    setEntries([]);
    setWindows((current) => current.filter((w) => w.appId !== 'notepad'));
    setNotepadState({});
  };

  const patchNotepadState = (instanceId: string, patch: Partial<NotepadState>) => {
    setNotepadState((current) =>
      current[instanceId] ? { ...current, [instanceId]: { ...current[instanceId], ...patch } } : current,
    );
  };

  const loadNotepadContent = async (instanceId: string, filePath: string) => {
    try {
      const content = await connection.readFile(filePath);
      patchNotepadState(instanceId, { content, savedContent: content, loading: false });
    } catch (e) {
      const err = e as VMConnectionError;
      patchNotepadState(instanceId, { loading: false, error: `${err.code}: ${err.message}` });
    }
  };

  // Always creates a brand-new window - callers are responsible for checking whether the
  // file is already open first (openInNotepad does; the taskbar/Start-menu "just launch
  // Notepad" path doesn't need to, since a blank Untitled window is never a duplicate).
  const createNotepadInstance = (entry: FileEntry | null) => {
    notepadCounterRef.current += 1;
    zCounterRef.current += 1;
    const id = `notepad-${notepadCounterRef.current}`;
    // Cascade each new window slightly down-right of the last, like Windows does, so
    // opening several files doesn't stack every window in an identical spot.
    const offset = (notepadCounterRef.current % 6) * 24;
    const instance: WindowInstance = {
      id,
      appId: 'notepad',
      closed: false,
      minimized: false,
      maximized: false,
      snapped: null,
      x: 250 + offset,
      y: 90 + offset,
      zIndex: zCounterRef.current,
    };
    setWindows((current) => [...current, instance]);
    setNotepadState((current) => ({
      ...current,
      [id]: { path: entry?.path ?? null, content: '', savedContent: '', loading: !!entry, saving: false, error: '' },
    }));
    setActiveId(id);
    if (entry) {
      void loadNotepadContent(id, entry.path);
    }
    return id;
  };

  const openInNotepad = (entry: FileEntry) => {
    const existing = windows.find(
      (w) => w.appId === 'notepad' && !w.closed && notepadState[w.id]?.path === entry.path,
    );
    if (existing) {
      bringToFront(existing.id, { minimized: false });
      return;
    }
    createNotepadInstance(entry);
  };

  const saveNotepad = async (instanceId: string) => {
    const state = notepadState[instanceId];
    if (!state?.path || state.saving) {
      return;
    }
    const path = state.path;
    const contentToSave = state.content;
    patchNotepadState(instanceId, { saving: true, error: '' });
    try {
      await connection.writeFile(path, contentToSave);
      patchNotepadState(instanceId, { saving: false, savedContent: contentToSave });
    } catch (e) {
      const err = e as VMConnectionError;
      patchNotepadState(instanceId, { saving: false, error: `${err.code}: ${err.message}` });
    }
  };

  const openFilePath = (entry: FileEntry) => {
    if (entry.isDirectory) {
      void navigateTo(entry.path);
      return;
    }
    if (defaultAppFor(entry.name) === 'notepad') {
      openInNotepad(entry);
    }
  };

  // Detect double-clicks manually instead of relying on the browser's native "dblclick" event:
  // two separate click() calls fired close together (real users double-clicking, or automated
  // clicks) don't always get recognized as a native double-click depending on exact timing, but
  // are still reliably close together in time — comparing timestamps ourselves is more robust.
  const lastRowClickRef = useRef<{ path: string; time: number } | null>(null);
  const handleRowClick = (entry: FileEntry) => {
    const now = Date.now();
    const last = lastRowClickRef.current;
    if (last && last.path === entry.path && now - last.time < 500) {
      lastRowClickRef.current = null;
      openFilePath(entry);
      return;
    }
    lastRowClickRef.current = { path: entry.path, time: now };
    setSelectedPath(entry.path);
  };

  const chooseWallpaperFolder = async () => {
    setWallpaperStatus('');
    const pending = pickLocalDirectory();
    if (!pending) {
      setWallpaperStatus('This browser does not support choosing a local folder.');
      return;
    }
    try {
      const dirHandle = await pending;
      const images = await listImagesFromDirectory(dirHandle);
      setWallpaperImages(images);
      setWallpaperFolder(dirHandle.name);
      setSavedWallpaperFolderName(dirHandle.name);
      setWallpaperStatus(images.length ? `${images.length} image(s) found.` : 'No images found in this folder.');
      await setStoredHandle('wallpaperFolderHandle', dirHandle);
    } catch {
      setWallpaperStatus('Folder selection was cancelled or failed.');
    }
  };

  const applySavedWallpaperFolder = async () => {
    const handle = await getStoredHandle<DirectoryHandleLike>('wallpaperFolderHandle');
    if (!handle) {
      return;
    }
    const perm = (await handle.requestPermission?.({ mode: 'read' })) ?? 'denied';
    if (perm !== 'granted') {
      setWallpaperStatus('Permission to reuse the saved folder was denied.');
      return;
    }
    setWallpaperStatus('');
    const images = await listImagesFromDirectory(handle);
    setWallpaperImages(images);
    setWallpaperFolder(handle.name);
    setWallpaperStatus(images.length ? `${images.length} image(s) found.` : 'No images found in this folder.');
  };

  const applyWallpaper = async (image: { name: string; url: string }) => {
    try {
      const response = await fetch(image.url);
      const blob = await response.blob();
      const dataUrl = await readFileAsDataUrl(new File([blob], image.name, { type: blob.type }));
      setWallpaper(dataUrl);
      setWallpaperStatus(`Wallpaper set to ${image.name}.`);
    } catch {
      setWallpaperStatus('Could not apply that image as wallpaper.');
    }
  };

  const canConnect = Boolean(parseTarget(target) && profile.privateKeyContent);

  const windowClassName = (instance: WindowInstance, extra: string) =>
    [
      'app-window',
      extra,
      activeId === instance.id ? 'is-focused' : '',
      instance.maximized ? 'is-maximized' : '',
      instance.minimized ? 'is-minimized' : '',
      instance.closed ? 'is-closed' : '',
      instance.snapped === 'left' ? 'is-snapped-left' : '',
      instance.snapped === 'right' ? 'is-snapped-right' : '',
    ]
      .filter(Boolean)
      .join(' ');

  const windowInlineStyle = (instance: WindowInstance): CSSProperties => ({
    zIndex: instance.zIndex,
    ...(instance.maximized || instance.snapped ? {} : { left: instance.x, top: instance.y }),
  });

  const instanceTitle = (w: WindowInstance) => {
    if (w.appId === 'notepad') {
      const p = notepadState[w.id]?.path;
      return p ? p.split('/').pop() || p : 'Untitled';
    }
    return APPS.find((a) => a.id === w.appId)?.name ?? w.appId;
  };

  const scheduleShowPreview = (appId: AppId) => {
    if (previewTimeoutRef.current) {
      window.clearTimeout(previewTimeoutRef.current);
    }
    previewTimeoutRef.current = window.setTimeout(() => setPreviewApp(appId), 350);
  };
  const cancelPreviewTimer = () => {
    if (previewTimeoutRef.current) {
      window.clearTimeout(previewTimeoutRef.current);
      previewTimeoutRef.current = null;
    }
  };
  const scheduleHidePreview = () => {
    cancelPreviewTimer();
    previewTimeoutRef.current = window.setTimeout(() => setPreviewApp(null), 200);
  };

  const backgroundStyle = wallpaper
    ? { backgroundImage: `url(${wallpaper})`, backgroundSize: 'cover', backgroundPosition: 'center' }
    : undefined;

  const filteredApps = APPS.filter((app) => app.name.toLowerCase().includes(startSearch.trim().toLowerCase()));

  if (screen === 'lock') {
    return (
      <div className="lock-screen" style={backgroundStyle}>
        <div className="lock-screen-scrim" />
        <div className="lock-screen-clock">
          <span className="lock-time">{clock}</span>
          <span className="lock-date">{lockDate}</span>
        </div>
        <div className="lock-screen-hint">Click or press any key to continue</div>
      </div>
    );
  }

  if (screen === 'login') {
    return (
      <div className="login-screen" style={backgroundStyle}>
        <div className="lock-screen-scrim" />
        <div className="login-card">
          <img src={startIcon} alt="" className="login-avatar" />
          <span className="login-name">User</span>
          <button className="login-signin" onClick={() => setScreen('desktop')} autoFocus>
            <span>Sign in</span>
            <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
              <path d="M3 8h9M8 3l5 5-5 5" stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </div>
        <div className="login-power">
          <button aria-label="Back to lock screen" onClick={() => setScreen('lock')}>‹ Back</button>
        </div>
      </div>
    );
  }

  // files/terminal/settings always have exactly one instance, present from initialWindows
  // onward - safe to assume non-null everywhere below.
  const filesWindow = windows.find((w) => w.id === 'files')!;
  const terminalWindow = windows.find((w) => w.id === 'terminal')!;
  const settingsWindow = windows.find((w) => w.id === 'settings')!;
  const notepadWindows = windows.filter((w) => w.appId === 'notepad');

  return (
    <div className="os-shell" style={backgroundStyle}>
      <main className="desktop-surface" ref={desktopRef}>
        {snapPreview && <div className={`snap-preview is-${snapPreview}`} />}
        {APPS.map((app) => (
          <button
            key={app.id}
            className="desktop-shortcut"
            style={{ left: iconPositions[app.id].x, top: iconPositions[app.id].y }}
            onPointerDown={(event) => beginIconDrag(app.id, event)}
            onClick={(event) => handleIconClick(app.id, event)}
            disabled={app.requiresConnection && !connected}
          >
            <img src={app.icon} alt="" className="shortcut-icon" />
            <span>{app.name}</span>
          </button>
        ))}

        {!connected && (!keyLookupDone || autoConnecting) && (
          <div className="auto-connect-status">
            <span className="auto-connect-spinner" />
            <span>{autoConnecting ? 'Connecting to VM…' : 'Loading…'}</span>
          </div>
        )}

        {!connected && keyLookupDone && !autoConnecting && (
          <section className="connect-panel" aria-label="VM connection">
            <div className="connect-header">
              <div>
                <span className="eyebrow">VM Desktop</span>
                <h1>Quick Connect</h1>
              </div>
              <span className="pc-badge">10</span>
            </div>

            <label className="target-field">
              SSH target
              <input
                value={target}
                onChange={(e) => setTarget(e.target.value)}
                placeholder="ubuntu@w.x.y.z"
              />
            </label>

            {supportsFilePicker ? (
              <button type="button" className="key-picker" onClick={() => void chooseKeyFile()}>
                <span className="key-icon" />
                <strong>{profile.privateKeyName ?? 'Choose VM key'}</strong>
              </button>
            ) : (
              <label className="key-picker">
                <input
                  type="file"
                  accept=".key,.pem,.txt"
                  onChange={(e) => void handleKeyFile(e.target.files?.[0])}
                />
                <span className="key-icon" />
                <strong>{profile.privateKeyName ?? 'Choose VM key'}</strong>
              </label>
            )}
            {savedKeyName && !profile.privateKeyContent && (
              <button type="button" className="use-saved-link" onClick={() => void applySavedKey()}>
                Use saved key: {savedKeyName}
              </button>
            )}

            <button className="connect-button" onClick={connect} disabled={!canConnect}>
              Connect
            </button>
            {error && <p className="connect-error">{error}</p>}
          </section>
        )}

        {connected && !filesWindow.closed && (
          <section
            ref={(el) => { windowElRefs.current.files = el ?? undefined; }}
            className={windowClassName(filesWindow, 'explorer-window')}
            style={windowInlineStyle(filesWindow)}
            onPointerDown={() => bringToFront('files')}
          >
            <header className="window-titlebar" onPointerDown={(event) => beginDrag('files', event)}>
              <img src={folderIcon} alt="" className="titlebar-icon" />
              <span>File Explorer</span>
              <div className="window-controls">
                <button aria-label="Minimize" onPointerDown={(event) => event.stopPropagation()} onClick={() => minimizeWindow('files')} />
                <button aria-label="Maximize" onPointerDown={(event) => event.stopPropagation()} onClick={() => maximizeWindow('files')} />
                <button className="is-close" aria-label="Close" onPointerDown={(event) => event.stopPropagation()} onClick={() => closeInstance('files')} />
              </div>
            </header>
            <div className="explorer-command-bar">
              <button
                className="cmd-arrow"
                aria-label="Back"
                onClick={goBack}
                disabled={!connected || historyIndex === 0}
              >
                ‹
              </button>
              <button
                className="cmd-arrow"
                aria-label="Forward"
                onClick={goForward}
                disabled={!connected || historyIndex >= history.length - 1}
              >
                ›
              </button>
              <button className="cmd-arrow" aria-label="Refresh" onClick={refreshDirectory} disabled={!connected}>
                ↻
              </button>
              <div className="explorer-breadcrumb">
                <input
                  value={addressInput}
                  onChange={(e) => setAddressInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      void navigateTo(addressInput);
                    }
                  }}
                />
              </div>
            </div>
            {explorerError && <p className="explorer-error">{explorerError}</p>}
            <div className="explorer-body">
              <aside>
                <div className="nav-section-label">Quick access</div>
                <button className={path === '/' ? 'is-active' : ''} onClick={() => void navigateTo('/')} disabled={!connected}>
                  <span className="nav-icon" /> Root
                </button>
                <button className={path === '/home' ? 'is-active' : ''} onClick={() => void navigateTo('/home')} disabled={!connected}>
                  <span className="nav-icon" /> Home
                </button>
                <button className={path === '/var/log' ? 'is-active' : ''} onClick={() => void navigateTo('/var/log')} disabled={!connected}>
                  <span className="nav-icon" /> Logs
                </button>
              </aside>
              <div className="explorer-list-pane">
                <div className="file-list-header">
                  <span />
                  <span>Name</span>
                  <span>Permissions</span>
                  <span>Size</span>
                  <span>Date modified</span>
                </div>
                <ul className="file-list">
                  {entries.map((entry) => (
                    <li
                      key={entry.path}
                      className={[
                        entry.isDirectory ? 'is-directory' : '',
                        selectedPath === entry.path ? 'is-selected' : '',
                      ].filter(Boolean).join(' ')}
                      onClick={() => handleRowClick(entry)}
                    >
                      {entry.isDirectory ? (
                        <span className="file-icon is-folder" />
                      ) : fileTypeIcon(entry.name) ? (
                        <img src={fileTypeIcon(entry.name)} alt="" className="file-icon is-typed" />
                      ) : (
                        <span className="file-icon" />
                      )}
                      <span>{entry.name}</span>
                      <small>{entry.permissions}</small>
                      <small>{entry.size}B</small>
                      <small>{entry.modifiedAt}</small>
                    </li>
                  ))}
                  {entries.length === 0 && (
                    <li className="empty-row">
                      <span>{connected ? 'This folder is empty' : 'Connect to browse files'}</span>
                    </li>
                  )}
                </ul>
                <div className="explorer-status-bar">
                  <span>{entries.length} item{entries.length === 1 ? '' : 's'}</span>
                </div>
              </div>
            </div>
          </section>
        )}

        {connected && (
          <section
            ref={(el) => { windowElRefs.current.terminal = el ?? undefined; }}
            className={windowClassName(terminalWindow, 'terminal-window')}
            style={windowInlineStyle(terminalWindow)}
            onPointerDown={() => bringToFront('terminal')}
          >
            <header className="window-titlebar is-dark" onPointerDown={(event) => beginDrag('terminal', event)}>
              <div className="terminal-tab">
                <img src={terminalIcon} alt="" className="titlebar-icon" />
                <span>Ubuntu</span>
              </div>
              <div className="window-controls">
                <button aria-label="Minimize" onPointerDown={(event) => event.stopPropagation()} onClick={() => minimizeWindow('terminal')} />
                <button aria-label="Maximize" onPointerDown={(event) => event.stopPropagation()} onClick={() => maximizeWindow('terminal')} />
                <button className="is-close" aria-label="Close" onPointerDown={(event) => event.stopPropagation()} onClick={() => closeInstance('terminal')} />
              </div>
            </header>
            <div ref={terminalNodeRef} className="terminal-pane" />
          </section>
        )}

        {connected && notepadWindows.map((instance) => {
          const state = notepadState[instance.id] ?? {
            path: null,
            content: '',
            savedContent: '',
            loading: false,
            saving: false,
            error: '',
          };
          const dirty = state.content !== state.savedContent;
          return (
            <section
              key={instance.id}
              ref={(el) => { windowElRefs.current[instance.id] = el ?? undefined; }}
              className={windowClassName(instance, 'notepad-window')}
              style={windowInlineStyle(instance)}
              onPointerDown={() => bringToFront(instance.id)}
            >
              <header className="window-titlebar" onPointerDown={(event) => beginDrag(instance.id, event)}>
                <img src={notepadIcon} alt="" className="titlebar-icon" />
                <span>
                  {dirty ? '*' : ''}
                  {state.path ? state.path.split('/').pop() || state.path : 'Untitled'} - Notepad
                </span>
                <div className="window-controls">
                  <button aria-label="Minimize" onPointerDown={(event) => event.stopPropagation()} onClick={() => minimizeWindow(instance.id)} />
                  <button aria-label="Maximize" onPointerDown={(event) => event.stopPropagation()} onClick={() => maximizeWindow(instance.id)} />
                  <button
                    className="is-close"
                    aria-label="Close"
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={() => {
                      if (dirty && !window.confirm('Discard unsaved changes?')) {
                        return;
                      }
                      closeInstance(instance.id);
                    }}
                  />
                </div>
              </header>
              <div className="notepad-toolbar">
                <button onClick={() => void saveNotepad(instance.id)} disabled={!state.path || state.loading || state.saving}>
                  {state.saving ? 'Saving…' : 'Save'}
                </button>
                {state.error && <span className="notepad-error">{state.error}</span>}
              </div>
              <textarea
                className="notepad-textarea"
                value={state.content}
                onChange={(e) => patchNotepadState(instance.id, { content: e.target.value })}
                onKeyDown={(e) => {
                  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
                    e.preventDefault();
                    void saveNotepad(instance.id);
                  }
                }}
                placeholder={state.loading ? 'Loading…' : 'Open a .txt file from File Explorer to edit it here.'}
                disabled={state.loading}
                spellCheck={false}
              />
              <div className="notepad-status-bar">
                <span>{state.path ?? 'No file open'}</span>
                <span>{dirty ? 'Unsaved changes' : state.path ? 'Saved' : ''}</span>
              </div>
            </section>
          );
        })}

        {!settingsWindow.closed && (
          <section
            ref={(el) => { windowElRefs.current.settings = el ?? undefined; }}
            className={windowClassName(settingsWindow, 'settings-window')}
            style={windowInlineStyle(settingsWindow)}
            onPointerDown={() => bringToFront('settings')}
          >
            <header className="window-titlebar" onPointerDown={(event) => beginDrag('settings', event)}>
              <img src={settingsIcon} alt="" className="titlebar-icon" />
              <span>Settings</span>
              <div className="window-controls">
                <button aria-label="Minimize" onPointerDown={(event) => event.stopPropagation()} onClick={() => minimizeWindow('settings')} />
                <button aria-label="Maximize" onPointerDown={(event) => event.stopPropagation()} onClick={() => maximizeWindow('settings')} />
                <button className="is-close" aria-label="Close" onPointerDown={(event) => event.stopPropagation()} onClick={() => closeInstance('settings')} />
              </div>
            </header>
            <div className="settings-shell">
              <aside className="settings-nav">
                <div className="settings-account">
                  <img src={startIcon} alt="" className="settings-avatar" />
                  <div>
                    <strong>User</strong>
                    <span>{connected ? 'Connected' : 'Local account'}</span>
                  </div>
                </div>
                <button className="is-active">
                  <span className="nav-icon" /> Personalization
                </button>
                <button disabled>
                  <span className="nav-icon" /> System
                </button>
                <button disabled>
                  <span className="nav-icon" /> Network &amp; internet
                </button>
                <button disabled>
                  <span className="nav-icon" /> Apps
                </button>
                <button disabled>
                  <span className="nav-icon" /> Accounts
                </button>
              </aside>
              <div className="settings-body">
                <h2>Personalization &gt; Background</h2>
                <p className="settings-hint">Choose a folder on your PC to browse its images and set one as your desktop background.</p>
                <div className="settings-row">
                  <button onClick={() => void chooseWallpaperFolder()}>Choose folder</button>
                  {wallpaperFolder && <span className="settings-folder-label">{wallpaperFolder}</span>}
                  {wallpaper && (
                    <button className="settings-secondary" onClick={() => setWallpaper('')}>
                      Clear wallpaper
                    </button>
                  )}
                </div>
                {savedWallpaperFolderName && !wallpaperImages.length && (
                  <button type="button" className="use-saved-link" onClick={() => void applySavedWallpaperFolder()}>
                    Use saved folder: {savedWallpaperFolderName}
                  </button>
                )}
                {wallpaperStatus && <p className="settings-status">{wallpaperStatus}</p>}
                {wallpaperImages.length > 0 && (
                  <div className="wallpaper-grid">
                    {wallpaperImages.map((image) => (
                      <button
                        key={image.url}
                        className={wallpaper && image.url === wallpaper ? 'wallpaper-thumb is-active' : 'wallpaper-thumb'}
                        onClick={() => void applyWallpaper(image)}
                        title={image.name}
                      >
                        <img src={image.url} alt={image.name} loading="lazy" />
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </section>
        )}
      </main>

      <footer className="taskbar">
        <div className="taskbar-center">
          <button
            className={startOpen ? 'start-button is-active' : 'start-button'}
            aria-label="Start"
            onClick={() => setStartOpen((open) => !open)}
          >
            <img src={startIcon} alt="" className="start-icon" />
          </button>
          {APPS.filter((app) => openInstancesFor(app.id).length > 0 || closingApps.includes(app.id)).map((app) => {
            const open = openInstancesFor(app.id);
            const isActive = open.some((w) => w.id === activeId && !w.minimized);
            return (
              <div
                key={app.id}
                className="taskbar-app-wrap"
                onMouseEnter={() => scheduleShowPreview(app.id)}
                onMouseLeave={scheduleHidePreview}
              >
                <button
                  aria-label={app.name}
                  title={app.name}
                  className={[
                    'taskbar-app',
                    open.length > 0 ? 'is-open' : '',
                    isActive ? 'is-active' : '',
                    closingApps.includes(app.id) ? 'is-closing' : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  onClick={() => toggleApp(app.id)}
                  disabled={app.requiresConnection && !connected}
                >
                  <img src={app.icon} alt="" className="task-icon" />
                </button>
                {previewApp === app.id && open.length > 0 && (
                  <div
                    className="taskbar-preview"
                    onMouseEnter={cancelPreviewTimer}
                    onMouseLeave={scheduleHidePreview}
                  >
                    {open.map((w) => (
                      <div
                        key={w.id}
                        className={w.id === activeId && !w.minimized ? 'taskbar-preview-item is-active' : 'taskbar-preview-item'}
                      >
                        <button
                          className="taskbar-preview-body"
                          onClick={() => {
                            bringToFront(w.id, { minimized: false });
                            setPreviewApp(null);
                          }}
                        >
                          <img src={app.icon} alt="" className="taskbar-preview-icon" />
                          <span>{instanceTitle(w)}</span>
                        </button>
                        <button
                          className="taskbar-preview-close"
                          aria-label={`Close ${instanceTitle(w)}`}
                          onClick={(event) => {
                            event.stopPropagation();
                            closeInstance(w.id);
                          }}
                        >
                          ×
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div className="taskbar-tray">
          <span className={connected ? 'network is-online' : 'network'} title={connected ? 'Connected' : 'Disconnected'} />
          <div className="tray-clock">
            <time>{clock}</time>
          </div>
        </div>

        {startOpen && (
          <div className="start-menu" ref={startMenuRef}>
            <div className="start-menu-search">
              <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                <circle cx="7" cy="7" r="5" stroke="currentColor" strokeWidth="1.3" fill="none" />
                <line x1="11" y1="11" x2="15" y2="15" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
              </svg>
              <input
                value={startSearch}
                onChange={(e) => setStartSearch(e.target.value)}
                placeholder="Type here to search"
              />
            </div>

            <div className="start-menu-pinned-label">Pinned</div>
            <div className="start-menu-apps">
              {filteredApps.map((app) => (
                <button
                  key={app.id}
                  onClick={() => {
                    toggleApp(app.id);
                    setStartOpen(false);
                    setStartSearch('');
                  }}
                  disabled={app.requiresConnection && !connected}
                >
                  <img src={app.icon} alt="" className="shortcut-icon" />
                  <span>{app.name}</span>
                </button>
              ))}
              {filteredApps.length === 0 && <p className="start-menu-empty">No results</p>}
            </div>

            <div className="start-menu-footer">
              <button className="start-menu-account" onClick={() => setScreen('lock')}>
                <img src={startIcon} alt="" className="settings-avatar" />
                <div>
                  <strong>User</strong>
                  <span>{connected ? 'Connected' : status}</span>
                </div>
              </button>
              {connected && (
                <button className="start-menu-disconnect" onClick={() => void disconnect()}>
                  Disconnect
                </button>
              )}
            </div>
          </div>
        )}
      </footer>
    </div>
  );
}

export default App;

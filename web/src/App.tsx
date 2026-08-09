import { type PointerEvent as ReactPointerEvent, useEffect, useMemo, useRef, useState } from 'react';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import './App.css';
import startIcon from './assets/start-icon.svg';
import folderIcon from './assets/icon-folder.svg';
import terminalIcon from './assets/icon-terminal.svg';
import settingsIcon from './assets/icon-settings.svg';
import {
  ExtensionVMConnection,
  type ConnectionProfile,
  type FileEntry,
  VMConnectionError,
} from './connection';
import { getStoredHandle, setStoredHandle } from './handles';

type AppId = 'files' | 'terminal' | 'settings';
type Screen = 'lock' | 'login' | 'desktop';
type SnapZone = 'left' | 'right' | 'top';
type WindowState = {
  closed: boolean;
  minimized: boolean;
  maximized: boolean;
  snapped: SnapZone | null;
  x: number;
  y: number;
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
  { id: 'settings', name: 'Settings', icon: settingsIcon, requiresConnection: false },
];

const defaultWindows: Record<AppId, WindowState> = {
  files: { closed: false, minimized: false, maximized: false, snapped: null, x: 132, y: 34 },
  terminal: { closed: true, minimized: false, maximized: false, snapped: null, x: 176, y: 78 },
  settings: { closed: true, minimized: false, maximized: false, snapped: null, x: 210, y: 60 },
};

const ICON_GRID_X = 96;
const ICON_GRID_Y = 96;
const ICON_ORIGIN_X = 0;
const ICON_ORIGIN_Y = 0;

const defaultIconPositions: Record<AppId, IconPosition> = {
  files: { x: ICON_ORIGIN_X, y: ICON_ORIGIN_Y },
  terminal: { x: ICON_ORIGIN_X, y: ICON_ORIGIN_Y + ICON_GRID_Y },
  settings: { x: ICON_ORIGIN_X, y: ICON_ORIGIN_Y + ICON_GRID_Y * 2 },
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

type CommandResult = { ok: boolean; text: string };

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
    const cwdRef: { current: string | null } = { current: null };
    const prompt = () => terminal.write(`\r\nubuntu@vm:${cwdRef.current ?? '~'}$ `);

    terminal.write('VM Desktop Terminal');
    prompt();

    terminal.onData(async (data) => {
      if (!connectedRef.current) {
        return;
      }
      if (data === '\r') {
        const raw = input.trim();
        terminal.write('\r\n');
        input = '';
        if (!raw) {
          prompt();
          return;
        }

        const cdMatch = raw.match(/^cd(?:\s+(.*))?$/);
        if (cdMatch) {
          const target = (cdMatch[1] ?? '').trim() || '~';
          const cdCmd = cwdRef.current
            ? `cd ${shellQuote(cwdRef.current)} 2>/dev/null; cd ${shellQuote(target)} 2>&1 && pwd`
            : `cd ${shellQuote(target)} 2>&1 && pwd`;
          const result = await commandRef.current(cdCmd);
          if (result.ok) {
            cwdRef.current = result.text.trim().split('\n').pop() || cwdRef.current;
          } else {
            terminal.write(`\x1b[31m${result.text}\x1b[0m`);
          }
          prompt();
          return;
        }

        const wrapped = cwdRef.current
          ? `cd ${shellQuote(cwdRef.current)} 2>/dev/null; ${raw}`
          : raw;
        const result = await commandRef.current(wrapped);
        if (result.ok) {
          terminal.write(result.text || '(no output)');
        } else {
          terminal.write(`\x1b[31m${result.text}\x1b[0m`);
        }
        prompt();
        return;
      }
      if (data === '\x7f') {
        if (input.length > 0) {
          input = input.slice(0, -1);
          terminal.write('\b \b');
        }
        return;
      }
      input += data;
      terminal.write(data);
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
  const [active, setActive] = useState<AppId>('files');
  const [windows, setWindows] = useState(defaultWindows);
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
  const windowElRefs = useRef<Partial<Record<AppId, HTMLElement>>>({});
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
      const next = { ...current };
      (Object.keys(current) as AppId[]).forEach((id) => {
        const w = current[id];
        if (w.closed || w.maximized || w.snapped) {
          return;
        }
        const el = windowElRefs.current[id];
        const rect = el?.getBoundingClientRect();
        if (!rect || rect.width <= 0 || rect.height <= 0) {
          return;
        }
        const maxX = Math.max(8, bounds.width - rect.width - 8);
        const maxY = Math.max(8, bounds.height - rect.height - 8);
        const clampedX = Math.min(Math.max(8, w.x), maxX);
        const clampedY = Math.min(Math.max(8, w.y), maxY);
        if (clampedX !== w.x || clampedY !== w.y) {
          changed = true;
          next[id] = { ...w, x: clampedX, y: clampedY };
        }
      });
      return changed ? next : current;
    });
  };

  useEffect(() => {
    const raf = requestAnimationFrame(clampWindowsToViewport);
    return () => cancelAnimationFrame(raf);
  }, [windows.files.closed, windows.terminal.closed, windows.settings.closed, screen, connected]);

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
      const text = await connection.executeCommand(command);
      return { ok: true, text };
    } catch (e) {
      const err = e as VMConnectionError;
      const text = `${err.code}: ${err.message}`;
      setError(text);
      return { ok: false, text };
    }
  };

  const terminalNodeRef = useTerminal(execute, connected);

  const openWindow = (id: AppId) => {
    setActive(id);
    setStartOpen(false);
    setWindows((current) => ({
      ...current,
      [id]: {
        ...current[id],
        closed: false,
        minimized: false,
      },
    }));
  };

  const minimizeWindow = (id: AppId) => {
    setWindows((current) => ({
      ...current,
      [id]: {
        ...current[id],
        minimized: true,
      },
    }));
  };

  const toggleApp = (id: AppId) => {
    const w = windows[id];
    if (!w.closed && !w.minimized && active === id) {
      minimizeWindow(id);
    } else {
      openWindow(id);
    }
  };

  const maximizeWindow = (id: AppId) => {
    setActive(id);
    setWindows((current) => ({
      ...current,
      [id]: {
        ...current[id],
        maximized: !current[id].maximized,
        minimized: false,
        snapped: null,
      },
    }));
  };

  const closeWindow = (id: AppId) => {
    setWindows((current) => ({
      ...current,
      [id]: {
        ...current[id],
        closed: true,
        minimized: false,
        maximized: false,
      },
    }));
  };

  const beginDrag = (id: AppId, event: ReactPointerEvent<HTMLElement>) => {
    if (windows[id].maximized || event.button !== 0) {
      return;
    }

    const startX = event.clientX;
    const startY = event.clientY;
    const wasSnapped = windows[id].snapped;
    // Popping a snapped window back to free-floating starts it roughly under the cursor,
    // matching how Windows 11 un-snaps a window the moment you start dragging it away.
    const startWindow = wasSnapped ? { x: startX - 60, y: Math.max(8, startY - 8) } : windows[id];
    const pointerId = event.pointerId;
    const titlebar = event.currentTarget;
    titlebar.setPointerCapture(pointerId);
    setActive(id);

    if (wasSnapped) {
      setWindows((current) => ({
        ...current,
        [id]: { ...current[id], snapped: null, x: startWindow.x, y: startWindow.y },
      }));
    }

    let zone: SnapZone | null = null;

    const moveWindow = (moveEvent: PointerEvent) => {
      const nextX = Math.max(8, startWindow.x + moveEvent.clientX - startX);
      const nextY = Math.max(8, startWindow.y + moveEvent.clientY - startY);
      setWindows((current) => ({
        ...current,
        [id]: {
          ...current[id],
          x: nextX,
          y: nextY,
        },
      }));

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
        setWindows((current) => ({
          ...current,
          [id]: { ...current[id], maximized: true, snapped: null },
        }));
      } else if (zone) {
        setWindows((current) => ({
          ...current,
          [id]: { ...current[id], snapped: zone, maximized: false },
        }));
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
    openWindow(id);
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
      setActive('files');
      setProfile(nextProfile);
      window.localStorage.setItem(LAST_TARGET_KEY, target.trim());
      setWindows((current) => ({
        ...current,
        files: {
          ...current.files,
          closed: false,
          minimized: false,
        },
      }));
      setStatus(`Connected to ${parsed.host}`);
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
  };

  const openFilePath = (entry: FileEntry) => {
    if (!entry.isDirectory) {
      return;
    }
    void navigateTo(entry.path);
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

  const windowClassName = (id: AppId, extra: string) =>
    [
      'app-window',
      extra,
      active === id ? 'is-focused' : '',
      windows[id].maximized ? 'is-maximized' : '',
      windows[id].minimized ? 'is-minimized' : '',
      windows[id].closed ? 'is-closed' : '',
      windows[id].snapped === 'left' ? 'is-snapped-left' : '',
      windows[id].snapped === 'right' ? 'is-snapped-right' : '',
    ]
      .filter(Boolean)
      .join(' ');

  const windowInlineStyle = (id: AppId) =>
    windows[id].maximized || windows[id].snapped ? undefined : { left: windows[id].x, top: windows[id].y };

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
            <span>{autoConnecting ? `Connecting to ${profile.name || 'your VM'}…` : 'Loading…'}</span>
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

        {connected && !windows.files.closed && (
          <section
            ref={(el) => { windowElRefs.current.files = el ?? undefined; }}
            className={windowClassName('files', 'explorer-window')}
            style={windowInlineStyle('files')}
            onPointerDown={() => setActive('files')}
          >
            <header className="window-titlebar" onPointerDown={(event) => beginDrag('files', event)}>
              <img src={folderIcon} alt="" className="titlebar-icon" />
              <span>File Explorer</span>
              <div className="window-controls">
                <button aria-label="Minimize" onPointerDown={(event) => event.stopPropagation()} onClick={() => minimizeWindow('files')} />
                <button aria-label="Maximize" onPointerDown={(event) => event.stopPropagation()} onClick={() => maximizeWindow('files')} />
                <button className="is-close" aria-label="Close" onPointerDown={(event) => event.stopPropagation()} onClick={() => closeWindow('files')} />
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
                      <span className={entry.isDirectory ? 'file-icon is-folder' : 'file-icon'} />
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
            className={windowClassName('terminal', 'terminal-window')}
            style={windowInlineStyle('terminal')}
            onPointerDown={() => setActive('terminal')}
          >
            <header className="window-titlebar is-dark" onPointerDown={(event) => beginDrag('terminal', event)}>
              <div className="terminal-tab">
                <img src={terminalIcon} alt="" className="titlebar-icon" />
                <span>Ubuntu</span>
              </div>
              <div className="window-controls">
                <button aria-label="Minimize" onPointerDown={(event) => event.stopPropagation()} onClick={() => minimizeWindow('terminal')} />
                <button aria-label="Maximize" onPointerDown={(event) => event.stopPropagation()} onClick={() => maximizeWindow('terminal')} />
                <button className="is-close" aria-label="Close" onPointerDown={(event) => event.stopPropagation()} onClick={() => closeWindow('terminal')} />
              </div>
            </header>
            <div ref={terminalNodeRef} className="terminal" />
          </section>
        )}

        {!windows.settings.closed && (
          <section
            ref={(el) => { windowElRefs.current.settings = el ?? undefined; }}
            className={windowClassName('settings', 'settings-window')}
            style={windowInlineStyle('settings')}
            onPointerDown={() => setActive('settings')}
          >
            <header className="window-titlebar" onPointerDown={(event) => beginDrag('settings', event)}>
              <img src={settingsIcon} alt="" className="titlebar-icon" />
              <span>Settings</span>
              <div className="window-controls">
                <button aria-label="Minimize" onPointerDown={(event) => event.stopPropagation()} onClick={() => minimizeWindow('settings')} />
                <button aria-label="Maximize" onPointerDown={(event) => event.stopPropagation()} onClick={() => maximizeWindow('settings')} />
                <button className="is-close" aria-label="Close" onPointerDown={(event) => event.stopPropagation()} onClick={() => closeWindow('settings')} />
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
          {APPS.filter((app) => app.id !== 'settings').map((app) => (
            <button
              key={app.id}
              aria-label={app.name}
              title={app.name}
              className={active === app.id && !windows[app.id].minimized && !windows[app.id].closed ? 'taskbar-app is-active' : 'taskbar-app'}
              onClick={() => toggleApp(app.id)}
              disabled={app.requiresConnection && !connected}
            >
              <img src={app.icon} alt="" className="task-icon" />
            </button>
          ))}
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
                  <span>{connected ? `Connected to ${profile.name}` : status}</span>
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

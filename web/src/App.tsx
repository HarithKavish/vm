import { type PointerEvent as ReactPointerEvent, useEffect, useMemo, useRef, useState } from 'react';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import './App.css';
import startIcon from './assets/start-icon.svg';
import {
  ExtensionVMConnection,
  type ConnectionProfile,
  type FileEntry,
  VMConnectionError,
} from './connection';
import { getStoredHandle, setStoredHandle } from './handles';

type AppId = 'files' | 'terminal' | 'settings';
type WindowState = {
  closed: boolean;
  minimized: boolean;
  maximized: boolean;
  x: number;
  y: number;
};
type IconPosition = { x: number; y: number };

type AppDescriptor = {
  id: AppId;
  name: string;
  iconClass: string;
  requiresConnection: boolean;
};

const APPS: AppDescriptor[] = [
  { id: 'files', name: 'File Explorer', iconClass: 'folder-icon', requiresConnection: true },
  { id: 'terminal', name: 'Terminal', iconClass: 'terminal-icon', requiresConnection: true },
  { id: 'settings', name: 'Settings', iconClass: 'settings-icon', requiresConnection: false },
];

const defaultWindows: Record<AppId, WindowState> = {
  files: { closed: false, minimized: false, maximized: false, x: 132, y: 34 },
  terminal: { closed: true, minimized: false, maximized: false, x: 176, y: 78 },
  settings: { closed: true, minimized: false, maximized: false, x: 210, y: 60 },
};

// Matches the 96px background-size of the .desktop-surface grid pattern so icons visually snap to it.
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

const useTerminal = (
  onCommand: (command: string) => Promise<string>,
  connected: boolean,
  error: string,
) => {
  const ref = useRef<HTMLDivElement | null>(null);
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
    if (!ref.current || terminalRef.current) {
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
    terminal.open(ref.current);
    fitAddon.fit();
    terminalRef.current = terminal;
    fitRef.current = fitAddon;

    let input = '';
    const prompt = () => terminal.write('\r\nubuntu@vm:~$ ');

    terminal.write('VM Desktop Terminal');
    prompt();

    terminal.onData(async (data) => {
      if (!connectedRef.current) {
        return;
      }
      if (data === '\r') {
        const command = input.trim();
        terminal.write('\r\n');
        input = '';
        if (!command) {
          prompt();
          return;
        }
        const output = await commandRef.current(command);
        terminal.write(output || '(no output)');
        prompt();
        return;
      }
      if (data === '') {
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
  }, []);

  useEffect(() => {
    if (!terminalRef.current || !error) {
      return;
    }
    terminalRef.current.writeln(`\r\n[error] ${error}`);
  }, [error]);

  return ref;
};

function App() {
  const [profile, setProfile] = useState<ConnectionProfile>(defaultProfile);
  const [target, setTarget] = useState(() => window.localStorage.getItem(LAST_TARGET_KEY) ?? 'ubuntu@');
  const [connected, setConnected] = useState(false);
  const [status, setStatus] = useState('Choose a key');
  const [error, setError] = useState('');
  const [active, setActive] = useState<AppId>('files');
  const [windows, setWindows] = useState(defaultWindows);
  const [path, setPath] = useState('/');
  const [addressInput, setAddressInput] = useState('/');
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [clock, setClock] = useState(formatTime);
  const [startOpen, setStartOpen] = useState(false);
  const [iconPositions, setIconPositions] = useState<Record<AppId, IconPosition>>(loadIconPositions);
  const [wallpaper, setWallpaper] = useState(() => window.localStorage.getItem(WALLPAPER_KEY) ?? '');
  const [wallpaperFolder, setWallpaperFolder] = useState('');
  const [wallpaperImages, setWallpaperImages] = useState<{ name: string; url: string }[]>([]);
  const [wallpaperStatus, setWallpaperStatus] = useState('');
  const [savedWallpaperFolderName, setSavedWallpaperFolderName] = useState('');
  const [savedKeyName, setSavedKeyName] = useState('');
  const [history, setHistory] = useState<string[]>(['/']);
  const [historyIndex, setHistoryIndex] = useState(0);
  const connection = useMemo(() => new ExtensionVMConnection(), []);
  const startMenuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const id = window.setInterval(() => setClock(formatTime()), 30_000);
    return () => window.clearInterval(id);
  }, []);

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
      }
    };
    window.addEventListener('pointerdown', onPointerDown);
    return () => window.removeEventListener('pointerdown', onPointerDown);
  }, [startOpen]);

  useEffect(() => {
    void (async () => {
      const handle = await getStoredHandle<FileHandleLike>('sshKeyHandle');
      if (!handle) {
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

  const execute = async (command: string): Promise<string> => {
    try {
      return await connection.executeCommand(command);
    } catch (e) {
      const err = e as VMConnectionError;
      setError(`${err.code}: ${err.message}`);
      return '';
    }
  };

  const terminalRef = useTerminal(execute, connected, error);

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
    const startWindow = windows[id];
    const pointerId = event.pointerId;
    const titlebar = event.currentTarget;
    titlebar.setPointerCapture(pointerId);
    setActive(id);

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
    };

    const stopDrag = () => {
      titlebar.releasePointerCapture(pointerId);
      window.removeEventListener('pointermove', moveWindow);
      window.removeEventListener('pointerup', stopDrag);
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
      setPath(nextPath);
      setAddressInput(nextPath);
      if (!opts?.fromHistory) {
        setHistory((current) => [...current.slice(0, historyIndex + 1), nextPath]);
        setHistoryIndex((current) => current + 1);
      }
    } catch (e) {
      const err = e as VMConnectionError;
      setError(`${err.code}: ${err.message}`);
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
    ]
      .filter(Boolean)
      .join(' ');

  return (
    <div
      className="os-shell"
      style={wallpaper ? { backgroundImage: `url(${wallpaper})`, backgroundSize: 'cover', backgroundPosition: 'center' } : undefined}
    >
      <main className="desktop-surface">
        {APPS.map((app) => (
          <button
            key={app.id}
            className="desktop-shortcut"
            style={{ left: iconPositions[app.id].x, top: iconPositions[app.id].y }}
            onPointerDown={(event) => beginIconDrag(app.id, event)}
            onClick={(event) => handleIconClick(app.id, event)}
            disabled={app.requiresConnection && !connected}
          >
            <span className={`shortcut-icon ${app.iconClass}`} />
            <span>{app.name}</span>
          </button>
        ))}

        {!connected && (
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
            className={windowClassName('files', 'explorer-window')}
            style={windows.files.maximized ? undefined : { left: windows.files.x, top: windows.files.y }}
            onPointerDown={() => setActive('files')}
          >
            <header className="window-titlebar" onPointerDown={(event) => beginDrag('files', event)}>
              <span>File Explorer</span>
              <div className="window-controls">
                <button aria-label="Minimize" onPointerDown={(event) => event.stopPropagation()} onClick={() => minimizeWindow('files')} />
                <button aria-label="Maximize" onPointerDown={(event) => event.stopPropagation()} onClick={() => maximizeWindow('files')} />
                <button aria-label="Close" onPointerDown={(event) => event.stopPropagation()} onClick={() => closeWindow('files')} />
              </div>
            </header>
            <div className="explorer-toolbar">
              <button
                className="nav-arrow"
                aria-label="Back"
                onClick={goBack}
                disabled={!connected || historyIndex === 0}
              >
                ‹
              </button>
              <button
                className="nav-arrow"
                aria-label="Forward"
                onClick={goForward}
                disabled={!connected || historyIndex >= history.length - 1}
              >
                ›
              </button>
              <button onClick={() => void navigateTo('/')} disabled={!connected}>
                Home
              </button>
              <input
                value={addressInput}
                onChange={(e) => setAddressInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    void navigateTo(addressInput);
                  }
                }}
              />
              <button aria-label="Refresh" onClick={refreshDirectory} disabled={!connected}>
                ↻
              </button>
            </div>
            <div className="explorer-body">
              <aside>
                <button onClick={() => void navigateTo('/')} disabled={!connected}>Root</button>
                <button onClick={() => void navigateTo('/home')} disabled={!connected}>Home</button>
                <button onClick={() => void navigateTo('/var/log')} disabled={!connected}>Logs</button>
              </aside>
              <ul className="file-list">
                {entries.map((entry) => (
                  <li
                    key={entry.path}
                    className={entry.isDirectory ? 'is-directory' : ''}
                    onClick={() => openFilePath(entry)}
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
                    <span>{connected ? 'No files' : 'Connect to browse files'}</span>
                  </li>
                )}
              </ul>
            </div>
          </section>
        )}

        {connected && !windows.terminal.closed && (
          <section
            className={windowClassName('terminal', 'terminal-window')}
            style={windows.terminal.maximized ? undefined : { left: windows.terminal.x, top: windows.terminal.y }}
            onPointerDown={() => setActive('terminal')}
          >
            <header className="window-titlebar" onPointerDown={(event) => beginDrag('terminal', event)}>
              <span>Terminal</span>
              <div className="window-controls">
                <button aria-label="Minimize" onPointerDown={(event) => event.stopPropagation()} onClick={() => minimizeWindow('terminal')} />
                <button aria-label="Maximize" onPointerDown={(event) => event.stopPropagation()} onClick={() => maximizeWindow('terminal')} />
                <button aria-label="Close" onPointerDown={(event) => event.stopPropagation()} onClick={() => closeWindow('terminal')} />
              </div>
            </header>
            <div ref={terminalRef} className="terminal" />
          </section>
        )}

        {!windows.settings.closed && (
          <section
            className={windowClassName('settings', 'settings-window')}
            style={windows.settings.maximized ? undefined : { left: windows.settings.x, top: windows.settings.y }}
            onPointerDown={() => setActive('settings')}
          >
            <header className="window-titlebar" onPointerDown={(event) => beginDrag('settings', event)}>
              <span>Settings</span>
              <div className="window-controls">
                <button aria-label="Minimize" onPointerDown={(event) => event.stopPropagation()} onClick={() => minimizeWindow('settings')} />
                <button aria-label="Maximize" onPointerDown={(event) => event.stopPropagation()} onClick={() => maximizeWindow('settings')} />
                <button aria-label="Close" onPointerDown={(event) => event.stopPropagation()} onClick={() => closeWindow('settings')} />
              </div>
            </header>
            <div className="settings-body">
              <h2>Personalization</h2>
              <p className="settings-hint">Choose a folder on your PC to browse its images and set one as your wallpaper.</p>
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
          </section>
        )}
      </main>

      <footer className="taskbar">
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
            className={active === app.id && !windows[app.id].minimized && !windows[app.id].closed ? 'taskbar-app is-active' : 'taskbar-app'}
            onClick={() => toggleApp(app.id)}
            disabled={app.requiresConnection && !connected}
          >
            <span className={`task-icon ${app.iconClass}`} />
            <span>{app.name}</span>
          </button>
        ))}
        <div className="taskbar-spacer" />
        <time>{clock}</time>

        {startOpen && (
          <div className="start-menu" ref={startMenuRef}>
            <div className="start-menu-status">
              <span className={connected ? 'network is-online' : 'network'} />
              <div>
                <strong>{connected ? profile.name : 'Not connected'}</strong>
                <span>{status}</span>
              </div>
              {connected && (
                <button onClick={() => void disconnect()}>Disconnect</button>
              )}
            </div>
            <div className="start-menu-apps">
              {APPS.map((app) => (
                <button
                  key={app.id}
                  onClick={() => {
                    toggleApp(app.id);
                    setStartOpen(false);
                  }}
                  disabled={app.requiresConnection && !connected}
                >
                  <span className={`shortcut-icon ${app.iconClass}`} />
                  <span>{app.name}</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </footer>
    </div>
  );
}

export default App;

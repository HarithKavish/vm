import { type PointerEvent as ReactPointerEvent, useEffect, useMemo, useRef, useState } from 'react';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import './App.css';
import {
  ExtensionVMConnection,
  type ConnectionProfile,
  type FileEntry,
  VMConnectionError,
} from './connection';

type WindowId = 'terminal' | 'files';
type WindowState = {
  closed: boolean;
  minimized: boolean;
  maximized: boolean;
  x: number;
  y: number;
};

const defaultWindows: Record<WindowId, WindowState> = {
  files: {
    closed: false,
    minimized: false,
    maximized: false,
    x: 132,
    y: 34,
  },
  terminal: {
    closed: true,
    minimized: false,
    maximized: false,
    x: 176,
    y: 78,
  },
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
      if (data === '\u007f') {
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
  const [active, setActive] = useState<WindowId>('files');
  const [windows, setWindows] = useState(defaultWindows);
  const [path, setPath] = useState('/');
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [clock, setClock] = useState(formatTime);
  const connection = useMemo(() => new ExtensionVMConnection(), []);

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

  const openWindow = (id: WindowId) => {
    setActive(id);
    setWindows((current) => ({
      ...current,
      [id]: {
        ...current[id],
        closed: false,
        minimized: false,
      },
    }));
  };

  const minimizeWindow = (id: WindowId) => {
    setWindows((current) => ({
      ...current,
      [id]: {
        ...current[id],
        minimized: true,
      },
    }));
  };

  const maximizeWindow = (id: WindowId) => {
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

  const closeWindow = (id: WindowId) => {
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

  const beginDrag = (id: WindowId, event: ReactPointerEvent<HTMLElement>) => {
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

  const loadDirectory = async (nextPath = path) => {
    if (!connected) {
      return;
    }
    try {
      const list = await connection.listDirectory(nextPath);
      setEntries(list);
      setPath(nextPath);
    } catch (e) {
      const err = e as VMConnectionError;
      setError(`${err.code}: ${err.message}`);
    }
  };

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
    void loadDirectory(entry.path);
  };

  const canConnect = Boolean(parseTarget(target) && profile.privateKeyContent);

  return (
    <div className="os-shell">
      <main className="desktop-surface">
        <button className="desktop-shortcut" onClick={() => openWindow('files')} disabled={!connected}>
          <span className="shortcut-icon folder-icon" />
          <span>File Explorer</span>
        </button>
        <button className="desktop-shortcut terminal-shortcut" onClick={() => openWindow('terminal')} disabled={!connected}>
          <span className="shortcut-icon terminal-icon" />
          <span>Terminal</span>
        </button>

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

            <label className="key-picker">
              <input
                type="file"
                accept=".key,.pem,.txt"
                onChange={(e) => void handleKeyFile(e.target.files?.[0])}
              />
              <span className="key-icon" />
              <strong>{profile.privateKeyName ?? 'Choose VM key'}</strong>
            </label>

            <button className="connect-button" onClick={connect} disabled={!canConnect}>
              Connect
            </button>
            {error && <p className="connect-error">{error}</p>}
          </section>
        )}

        {connected && (
          <section className="session-card">
            <strong>{profile.name}</strong>
            <span>{status}</span>
            <button onClick={disconnect}>Disconnect</button>
          </section>
        )}

        {connected && !windows.files.closed && !windows.files.minimized && (
          <section
            className={[
              'app-window explorer-window',
              active === 'files' ? 'is-focused' : '',
              windows.files.maximized ? 'is-maximized' : '',
            ].join(' ')}
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
              <button onClick={() => void loadDirectory('/')} disabled={!connected}>
                Home
              </button>
              <input value={path} onChange={(e) => setPath(e.target.value)} />
              <button onClick={() => void loadDirectory()} disabled={!connected}>
                Refresh
              </button>
            </div>
            <div className="explorer-body">
              <aside>
                <button onClick={() => void loadDirectory('/')} disabled={!connected}>Root</button>
                <button onClick={() => void loadDirectory('/home')} disabled={!connected}>Home</button>
                <button onClick={() => void loadDirectory('/var/log')} disabled={!connected}>Logs</button>
              </aside>
              <ul className="file-list">
                {entries.map((entry) => (
                  <li key={entry.path} onDoubleClick={() => openFilePath(entry)}>
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

        {connected && !windows.terminal.closed && !windows.terminal.minimized && (
          <section
            className={[
              'app-window terminal-window',
              active === 'terminal' ? 'is-focused' : '',
              windows.terminal.maximized ? 'is-maximized' : '',
            ].join(' ')}
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
      </main>

      <footer className="taskbar">
        <button className="start-button" aria-label="Start">
          <span />
        </button>
        <button
          className={active === 'files' && !windows.files.minimized ? 'taskbar-app is-active' : 'taskbar-app'}
          onClick={() => openWindow('files')}
          disabled={!connected}
        >
          <span className="task-icon folder-icon" />
          <span>File Explorer</span>
        </button>
        <button
          className={active === 'terminal' && !windows.terminal.minimized ? 'taskbar-app is-active' : 'taskbar-app'}
          onClick={() => openWindow('terminal')}
          disabled={!connected}
        >
          <span className="task-icon terminal-icon" />
          <span>Terminal</span>
        </button>
        <div className="taskbar-spacer" />
        <span className={connected ? 'network is-online' : 'network'} />
        <time>{clock}</time>
      </footer>
    </div>
  );
}

export default App;

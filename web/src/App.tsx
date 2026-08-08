import { useEffect, useMemo, useRef, useState } from 'react';
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

const defaultProfile: ConnectionProfile = {
  id: 'local',
  name: 'Ubuntu VM',
  host: '',
  port: 22,
  username: 'ubuntu',
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
  const [connected, setConnected] = useState(false);
  const [status, setStatus] = useState('Choose a key');
  const [error, setError] = useState('');
  const [active, setActive] = useState<WindowId>('files');
  const [path, setPath] = useState('/');
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [clock, setClock] = useState(formatTime);
  const connection = useMemo(() => new ExtensionVMConnection(), []);

  useEffect(() => {
    const id = window.setInterval(() => setClock(formatTime()), 30_000);
    return () => window.clearInterval(id);
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
    setError('');
    setStatus('Connecting...');
    try {
      await connection.connect(profile, { userConsent: true });
      const list = await connection.listDirectory('/');
      setEntries(list);
      setPath('/');
      setConnected(true);
      setActive('files');
      setStatus(`Connected to ${profile.host}`);
    } catch (e) {
      const err = e as VMConnectionError;
      if (err.code === 'HOST_UNTRUSTED') {
        const fingerprint = err.message.match(/SHA256:[A-Za-z0-9+/=]+/)?.[0];
        if (fingerprint && window.confirm(`Unknown host. Trust ${fingerprint}?`)) {
          await connection.trustHost(profile.host, fingerprint);
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

  const canConnect = Boolean(profile.host && profile.username && profile.privateKeyContent);

  return (
    <div className="os-shell">
      <main className="desktop-surface">
        <button className="desktop-shortcut" onClick={() => setActive('files')}>
          <span className="shortcut-icon folder-icon" />
          <span>File Explorer</span>
        </button>
        <button className="desktop-shortcut terminal-shortcut" onClick={() => setActive('terminal')}>
          <span className="shortcut-icon terminal-icon" />
          <span>Terminal</span>
        </button>

        {!connected && (
          <section className="connect-panel" aria-label="VM connection">
            <div className="connect-header">
              <div>
                <span className="eyebrow">VM Desktop</span>
                <h1>Connect to VM</h1>
              </div>
              <span className="pc-badge">10</span>
            </div>

            <div className="form-grid">
              <label>
                Host
                <input
                  value={profile.host}
                  onChange={(e) => setProfile({ ...profile, host: e.target.value })}
                  placeholder="w.x.y.z"
                />
              </label>
              <label>
                Port
                <input
                  type="number"
                  value={profile.port}
                  onChange={(e) => setProfile({ ...profile, port: Number(e.target.value) })}
                />
              </label>
              <label>
                Username
                <input
                  value={profile.username}
                  onChange={(e) => setProfile({ ...profile, username: e.target.value })}
                  placeholder="ubuntu"
                />
              </label>
              <label>
                Name
                <input
                  value={profile.name}
                  onChange={(e) => setProfile({ ...profile, name: e.target.value })}
                />
              </label>
            </div>

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

        {active === 'files' && (
          <section className="app-window explorer-window">
            <header className="window-titlebar">
              <span>File Explorer</span>
              <div className="window-controls">
                <button aria-label="Minimize" />
                <button aria-label="Maximize" />
                <button aria-label="Close" />
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

        {active === 'terminal' && (
          <section className="app-window terminal-window">
            <header className="window-titlebar">
              <span>Terminal</span>
              <div className="window-controls">
                <button aria-label="Minimize" />
                <button aria-label="Maximize" />
                <button aria-label="Close" />
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
        <button className={active === 'files' ? 'taskbar-app is-active' : 'taskbar-app'} onClick={() => setActive('files')}>
          <span className="task-icon folder-icon" />
          <span>File Explorer</span>
        </button>
        <button className={active === 'terminal' ? 'taskbar-app is-active' : 'taskbar-app'} onClick={() => setActive('terminal')}>
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

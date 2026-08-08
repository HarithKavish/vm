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
  name: 'My VM',
  host: '',
  port: 22,
  username: 'ubuntu',
};

const useTerminal = (
  onCommand: (command: string) => Promise<string>,
  connected: boolean,
  error: string,
) => {
  const ref = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);

  useEffect(() => {
    if (!ref.current || terminalRef.current) {
      return;
    }

    const terminal = new Terminal({
      convertEol: true,
      cursorBlink: true,
      theme: {
        background: '#0f172a',
      },
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(ref.current);
    fitAddon.fit();
    terminalRef.current = terminal;
    fitRef.current = fitAddon;

    let input = '';
    const prompt = () => terminal.write('\r\n$ ');

    terminal.write('VM Desktop Terminal');
    prompt();

    terminal.onData(async (data) => {
      if (!connected) {
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
        const output = await onCommand(command);
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
  }, [connected, onCommand]);

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
  const [status, setStatus] = useState('Disconnected');
  const [error, setError] = useState('');
  const [active, setActive] = useState<WindowId>('terminal');
  const [path, setPath] = useState('/');
  const [entries, setEntries] = useState<FileEntry[]>([]);

  const connection = useMemo(() => new ExtensionVMConnection(), []);

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

  const loadDirectory = async () => {
    if (!connected) {
      return;
    }
    try {
      const list = await connection.listDirectory(path);
      setEntries(list);
    } catch (e) {
      const err = e as VMConnectionError;
      setError(`${err.code}: ${err.message}`);
    }
  };

  const connect = async () => {
    setError('');
    setStatus('Connecting...');
    try {
      await connection.connect(profile, { userConsent: true });
      setConnected(true);
      setStatus(`Connected: ${profile.name}`);
      await loadDirectory();
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

  return (
    <div className="desktop">
      <aside className="launcher">
        <h1>VM Desktop</h1>
        <label>
          Name
          <input
            value={profile.name}
            onChange={(e) => setProfile({ ...profile, name: e.target.value })}
          />
        </label>
        <label>
          Host
          <input
            value={profile.host}
            onChange={(e) => setProfile({ ...profile, host: e.target.value })}
            placeholder="example.com"
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
          />
        </label>
        <label>
          Key Path (local companion)
          <input
            value={profile.privateKeyPath ?? ''}
            onChange={(e) => setProfile({ ...profile, privateKeyPath: e.target.value })}
            placeholder="~/.ssh/id_ed25519"
          />
        </label>

        <div className="actions">
          <button onClick={connect} disabled={connected || !profile.host}>
            Connect
          </button>
          <button onClick={disconnect} disabled={!connected}>
            Disconnect
          </button>
        </div>

        <nav className="apps">
          <button onClick={() => setActive('terminal')}>🖥 Terminal</button>
          <button onClick={() => setActive('files')}>📁 Files</button>
        </nav>
      </aside>

      <main className="workspace">
        {active === 'terminal' && (
          <section className="window">
            <header>Terminal</header>
            <div ref={terminalRef} className="terminal" />
          </section>
        )}

        {active === 'files' && (
          <section className="window">
            <header>
              Files
              <span>
                <input value={path} onChange={(e) => setPath(e.target.value)} />
                <button onClick={loadDirectory} disabled={!connected}>
                  Refresh
                </button>
              </span>
            </header>
            <ul className="files">
              {entries.map((entry) => (
                <li key={entry.path}>
                  <span>{entry.isDirectory ? '📂' : '📄'} {entry.name}</span>
                  <small>
                    {entry.permissions} · {entry.size}B · {entry.modifiedAt}
                  </small>
                </li>
              ))}
            </ul>
          </section>
        )}
      </main>

      <footer className="statusbar">
        {status}
        {error && <span className="error">{error}</span>}
      </footer>
    </div>
  );
}

export default App;

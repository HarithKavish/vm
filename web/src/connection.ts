export type ConnectionProfile = {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  privateKeyPath?: string;
  privateKeyContent?: string;
  privateKeyName?: string;
};

export type FileEntry = {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
  modifiedAt: string;
  permissions: string;
};

export type ConnectionErrorCode =
  | 'EXTENSION_UNAVAILABLE'
  | 'NATIVE_HOST_UNAVAILABLE'
  | 'AUTH_FAILED'
  | 'HOST_KEY_MISMATCH'
  | 'HOST_UNTRUSTED'
  | 'TIMEOUT'
  | 'REMOTE_COMMAND_FAILED'
  | 'UNKNOWN';

export class VMConnectionError extends Error {
  readonly code: ConnectionErrorCode;

  constructor(message: string, code: ConnectionErrorCode) {
    super(message);
    this.code = code;
  }
}

export interface VMConnection {
  connect(profile: ConnectionProfile, opts: { userConsent: boolean }): Promise<void>;
  trustHost(host: string, fingerprint: string): Promise<void>;
  disconnect(): Promise<void>;
  executeCommand(command: string): Promise<{ output: string; exitCode: number }>;
  listDirectory(path: string): Promise<FileEntry[]>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
}

type BridgeRequest<TPayload = unknown> = {
  requestId: string;
  type: string;
  payload: TPayload;
};

type BridgeResponse<TPayload = unknown> = {
  requestId: string;
  ok: boolean;
  payload?: TPayload;
  error?: {
    code: ConnectionErrorCode;
    message: string;
  };
};

const BRIDGE_REQ_EVENT = 'VM_DESKTOP_REQUEST';
const BRIDGE_RES_EVENT = 'VM_DESKTOP_RESPONSE';

const randomId = () => `${Date.now()}-${Math.random().toString(36).slice(2)}`;

const requestExtension = async <TReq, TRes>(
  type: string,
  payload: TReq,
): Promise<TRes> => {
  const request: BridgeRequest<TReq> = {
    requestId: randomId(),
    type,
    payload,
  };

  return new Promise<TRes>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      window.removeEventListener(BRIDGE_RES_EVENT, onMessage as EventListener);
      reject(new VMConnectionError('Extension did not respond.', 'EXTENSION_UNAVAILABLE'));
    }, 8000);

    const onMessage = (event: Event) => {
      const customEvent = event as CustomEvent<BridgeResponse<TRes>>;
      if (customEvent.detail.requestId !== request.requestId) {
        return;
      }

      window.clearTimeout(timeout);
      window.removeEventListener(BRIDGE_RES_EVENT, onMessage as EventListener);

      if (!customEvent.detail.ok || customEvent.detail.error) {
        const err = customEvent.detail.error;
        reject(new VMConnectionError(err?.message ?? 'Request failed.', err?.code ?? 'UNKNOWN'));
        return;
      }

      resolve(customEvent.detail.payload as TRes);
    };

    window.addEventListener(BRIDGE_RES_EVENT, onMessage as EventListener);
    window.dispatchEvent(new CustomEvent(BRIDGE_REQ_EVENT, { detail: request }));
  });
};

export class ExtensionVMConnection implements VMConnection {
  async connect(profile: ConnectionProfile, opts: { userConsent: boolean }): Promise<void> {
    await requestExtension('connect', {
      profile,
      userConsent: opts.userConsent,
    });
  }

  async trustHost(host: string, fingerprint: string): Promise<void> {
    await requestExtension('trust-host', { host, fingerprint });
  }

  async disconnect(): Promise<void> {
    await requestExtension('disconnect', {});
  }

  async executeCommand(command: string): Promise<{ output: string; exitCode: number }> {
    const res = await requestExtension<{ command: string }, { output: string; exitCode: number }>(
      'execute-command',
      { command },
    );
    return { output: res.output, exitCode: res.exitCode };
  }

  async listDirectory(path: string): Promise<FileEntry[]> {
    const res = await requestExtension<{ path: string }, { entries: FileEntry[] }>('list-directory', {
      path,
    });
    return res.entries;
  }

  async readFile(path: string): Promise<string> {
    const res = await requestExtension<{ path: string }, { content: string }>('read-file', { path });
    return res.content;
  }

  async writeFile(path: string, content: string): Promise<void> {
    await requestExtension<{ path: string; content: string }, { status: string }>('write-file', {
      path,
      content,
    });
  }
}

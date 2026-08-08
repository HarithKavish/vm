export type ConnectionProfile = {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  privateKeyPath?: string;
};

export type NativeRequest = {
  requestId: string;
  type: 'connect' | 'trust-host' | 'disconnect' | 'execute-command' | 'list-directory';
  payload: unknown;
};

export type NativeResponse = {
  requestId: string;
  ok: boolean;
  payload?: unknown;
  error?: {
    code: string;
    message: string;
  };
};

export const TRUSTED_ORIGINS = [
  'https://vm.harithkavish.com',
  'https://harithkavish.github.io',
  'http://localhost:5173',
];
export const HOST_NAME = 'com.harith.vm_desktop';

import { HOST_NAME, TRUSTED_ORIGINS, type NativeRequest, type NativeResponse } from './types';

// The native companion keeps SSH/SFTP state (sshClient, sftpClient) in memory across requests.
// chrome.runtime.sendNativeMessage spawns a fresh host process per call and kills it after the
// reply, which drops that state immediately after "connect" — every following request then hits
// a brand-new process with no session, surfacing as "TIMEOUT: not connected". connectNative keeps
// one host process (and its SSH session) alive across requests instead.
let port: chrome.runtime.Port | null = null;
const pending = new Map<string, (response: NativeResponse) => void>();

const failAllPending = (message: string) => {
  for (const [requestId, resolve] of pending) {
    resolve({ requestId, ok: false, error: { code: 'NATIVE_HOST_UNAVAILABLE', message } });
  }
  pending.clear();
};

const getPort = (): chrome.runtime.Port => {
  if (port) {
    return port;
  }

  const p = chrome.runtime.connectNative(HOST_NAME);
  p.onMessage.addListener((response: NativeResponse) => {
    const resolve = pending.get(response.requestId);
    if (resolve) {
      pending.delete(response.requestId);
      resolve(response);
    }
  });
  p.onDisconnect.addListener(() => {
    const detail = chrome.runtime.lastError?.message ?? 'Native companion disconnected.';
    console.error(`[vm-desktop] native port to ${HOST_NAME} disconnected: ${detail}`);
    port = null;
    failAllPending(detail);
  });

  port = p;
  return p;
};

const withNativeHost = async (request: NativeRequest): Promise<NativeResponse> => {
  try {
    const p = getPort();
    return await new Promise<NativeResponse>((resolve) => {
      pending.set(request.requestId, resolve);
      p.postMessage(request);
    });
  } catch (err) {
    const detail = chrome.runtime.lastError?.message ?? (err instanceof Error ? err.message : String(err));
    console.error(`[vm-desktop] connectNative(${HOST_NAME}) failed: ${detail}`);
    pending.delete(request.requestId);
    return {
      requestId: request.requestId,
      ok: false,
      error: {
        code: 'NATIVE_HOST_UNAVAILABLE',
        message: detail || 'Native companion is not installed or unreachable.',
      },
    };
  }
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  void (async () => {
    const tabUrl = sender.tab?.url;
    if (!tabUrl) {
      sendResponse({
        requestId: message.requestId,
        ok: false,
        error: {
          code: 'AUTH_FAILED',
          message: 'Missing sender tab context.',
        },
      } as NativeResponse);
      return;
    }

    const origin = new URL(tabUrl).origin;
    if (!TRUSTED_ORIGINS.includes(origin)) {
      sendResponse({
        requestId: message.requestId,
        ok: false,
        error: {
          code: 'AUTH_FAILED',
          message: `Untrusted origin: ${origin}`,
        },
      } as NativeResponse);
      return;
    }

    if (message.type === 'connect' && !message.payload?.userConsent) {
      sendResponse({
        requestId: message.requestId,
        ok: false,
        error: {
          code: 'AUTH_FAILED',
          message: 'Explicit user consent is required before connecting.',
        },
      } as NativeResponse);
      return;
    }

    const response = await withNativeHost({
      requestId: message.requestId,
      type: message.type,
      payload: message.payload,
    });
    sendResponse(response);
  })();

  return true;
});

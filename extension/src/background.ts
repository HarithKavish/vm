import { HOST_NAME, TRUSTED_ORIGINS, type NativeRequest, type NativeResponse } from './types';

const withNativeHost = async (request: NativeRequest): Promise<NativeResponse> => {
  try {
    const response = (await chrome.runtime.sendNativeMessage(HOST_NAME, request)) as NativeResponse;
    return response;
  } catch {
    return {
      requestId: request.requestId,
      ok: false,
      error: {
        code: 'NATIVE_HOST_UNAVAILABLE',
        message: 'Native companion is not installed or unreachable.',
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

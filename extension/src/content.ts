import type { NativeRequest, NativeResponse } from './types';

const REQUEST_EVENT = 'VM_DESKTOP_REQUEST';
const RESPONSE_EVENT = 'VM_DESKTOP_RESPONSE';

type PageRequest = {
  requestId: string;
  type: NativeRequest['type'];
  payload: unknown;
};

window.addEventListener(REQUEST_EVENT, async (event) => {
  const custom = event as CustomEvent<PageRequest>;
  const detail = custom.detail;
  if (!detail?.requestId || !detail.type) {
    return;
  }

  try {
    const response = (await chrome.runtime.sendMessage({
      requestId: detail.requestId,
      type: detail.type,
      payload: detail.payload,
    })) as NativeResponse;

    window.dispatchEvent(new CustomEvent(RESPONSE_EVENT, { detail: response }));
  } catch {
    window.dispatchEvent(
      new CustomEvent(RESPONSE_EVENT, {
        detail: {
          requestId: detail.requestId,
          ok: false,
          error: {
            code: 'EXTENSION_UNAVAILABLE',
            message: 'Extension bridge is unavailable.',
          },
        } as NativeResponse,
      }),
    );
  }
});

# VM Desktop

VM Desktop is a local-first graphical client for headless Linux servers.

## Architecture

- **Web app (`/web`)**: static React + TypeScript UI for desktop, terminal, and file explorer.
- **Browser extension (`/extension`)**: Manifest V3 bridge, restricted to trusted origin.
- **Native companion (`/native-companion`)**: local SSH/SFTP capability via Native Messaging.

There is **no project-owned backend**, **no cloud SSH proxy**, and **no VM-side custom agent**.

## Current implementation

- Connection profile form (host, port, username, key path).
- Extension messaging bridge with trusted-origin check.
- Native Messaging host request protocol.
- SSH connect/disconnect and command execution.
- SFTP directory listing in file explorer.
- Host fingerprint trust flow (first connect prompts trust, changes are blocked).

## Development

### Web app

```bash
cd /home/runner/work/vm/vm/web
npm install
npm run dev
```

### Extension

```bash
cd /home/runner/work/vm/vm/extension
npm install
npm run build
```

Load `/home/runner/work/vm/vm/extension/dist` as unpacked extension in Chromium.

### Native companion

```bash
cd /home/runner/work/vm/vm/native-companion
go build -o vm-desktop-companion .
```

Register a Native Messaging host manifest named `com.harith.vm_desktop` that points to the built binary and allows the extension ID.

## Notes

- Private keys stay on the local machine and are read by the native companion.
- The remote VM only needs normal SSH/SFTP access.

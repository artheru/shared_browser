# Development Guide

## Tech Stack

- **Server**: Node.js + Express + WebSocket + Puppeteer-core
- **Client**: Vue 3 + Vite + Vue Router + Pinia
- **Browser Control**: Chrome DevTools Protocol (CDP)

## Project Structure

```
├── server/             # Backend
│   ├── index.js        # Entry, routes, WebSocket
│   ├── browser-manager.js  # Puppeteer lifecycle & tabs
│   ├── stream-service.js   # MJPEG streaming
│   ├── input-handler.js    # Mouse/keyboard forwarding
│   ├── file-service.js     # Upload/download handling
│   ├── network-monitor.js  # CDP network tracking
│   ├── usage-tracker.js    # User usage statistics
│   ├── auth.js             # JWT auth & user/browser CRUD
│   ├── config.js           # All configuration
│   └── logger.js           # Structured logging
├── client/src/         # Frontend (Vue 3)
│   ├── views/          # Pages
│   ├── i18n/           # zh-CN / en
│   ├── router/         # Vue Router
│   ├── stores/         # Pinia stores
│   └── utils/          # Axios wrapper
├── build.ps1 / build.sh    # Package for deployment
├── install.bat / install.sh # Interactive installer
└── deploy.ps1              # Remote deploy via VehicleHelper
```

## Dev Setup

```bash
# Install server deps
npm install

# Install client deps
cd client && npm install && cd ..

# Run server (auto-serves built frontend)
npm run dev

# Run client dev server (HMR, proxies API to :3000)
npm run client:dev
```

Server runs on `http://localhost:3000`. Client dev server on `http://localhost:5173`.

## Build & Deploy

```bash
# Build frontend
npm run client:build

# Package for deployment
.\build.ps1        # Windows
bash build.sh      # Linux/macOS
```

Output: `shared-browser.zip` — copy to target, unzip, run `install.bat` / `install.sh`.

## Key Concepts

- **Stream**: Server captures screenshots via Puppeteer, sends JPEG frames over WebSocket
- **Input**: Client captures mouse/keyboard, sends to server via WebSocket, server replays via CDP
- **Tabs**: Each user gets an independent session with multiple tabs on the same browser profile
- **Anti-Detection**: Puppeteer stealth scripts injected on every page load
- **Auto-Restart**: Browser crash → exponential backoff restart → client auto-reconnect

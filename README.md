# owmo-shot-manager

MacOS electron desktop application for reviewing source footage (SD Cards, folders, etc.), adding shot metadata, and ingesting them into my NAS source library.

## Development

Requires Node.js 22.12+ (a supported LTS release is recommended) and npm.

```sh
npm install
npm run dev
```

Opens an Electron window with a React/Tailwind interface and a separate local Fastify backend. The footer checks the backend connection. This starter does not access media, cards, or NAS storage.

`npm run build` checks TypeScript and builds into `out/`. `npm start` opens that build; it does not create an installable application.

## Structure

- `desktop/`: Electron lifecycle and restricted preload bridge.
- `client/`: React interface, styled with Tailwind via Vite.
- `server/`: Fastify service in a supervised Electron utility process.
- `shared/`: Frontend/backend types.

The backend listens on a random loopback port with a per-launch token. The frontend requests status through the preload bridge; it has no direct Node.js or filesystem access. Closing the last window or using Cmd+Q quits the app and stops the backend. Frontend edits reload automatically; restart development after changing backend code.

Import and recovery features are future work. Develop against isolated dummy folders only; real NAS access requires explicit configuration and authorization.

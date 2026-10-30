# owmo-shot-manager

MacOS electron desktop application for reviewing source footage (SD Cards, folders, etc.), adding shot metadata, and ingesting them into my NAS source library.

## Development

Requires Node.js 22.12+ (a supported LTS release is recommended) and npm.

```sh
npm install
npm run dev
```

Opens an Electron window with a React/Tailwind interface and a separate local Fastify backend. The footer checks the backend connection. Use **+ Add Source** to choose the root of a mounted card or an ordinary video folder. The backend recognizes Sony's `PRIVATE/M4ROOT` structure and samples up to eight XML sidecars (at most 1 MiB each) for camera models, independently of video filenames. Unrecognized structures use the generic video-folder type. Shot discovery and playback are not implemented yet.

Sources last only for the current backend session. Previous `sources.json` files are no longer read or written. Selected paths are rechecked about every five seconds: missing or inaccessible roots remain in the list as unavailable, with a popup once per outage. Restoring the path clears the unavailable state; a later outage can notify again. Renamed or moved folders can be removed and added at their new location. Changed root identity or sampled metadata creates a fresh source ID. This is live detection, not a guarantee of physical card identity; ingestion will need stronger source validation. Camera models reflect the metadata sample, not an assertion that every shot uses the same camera. No shot-specific configuration is reused between cards.

Use **×** beside a source to remove it from the list without deleting or changing any files. Reinserted cards can be added again. The central **+** opens the same picker as **+ Add Source**. Folders or mounted cards can also be dragged from Finder onto the main workspace, including after sources have been added. Individual files are rejected. Once a source is added, the workspace shows an empty shot placeholder. Detection is read-only; generic video files are not probed yet. The native picker belongs to the desktop shell; source registration and detection belong to the backend.

`npm run build` checks TypeScript and builds into `out/`. `npm start` opens that build; it does not create an installable application.

## Structure

- `desktop/`: Electron lifecycle and restricted preload bridge.
- `client/`: React interface, styled with Tailwind via Vite.
- `server/`: Fastify service in a supervised Electron utility process.
- `shared/`: Frontend/backend types.

The backend listens on a random loopback port with a per-launch token. The frontend requests status through the preload bridge; it has no direct Node.js or filesystem access. Closing the last window or using Cmd+Q quits the app and stops the backend. Frontend edits reload automatically; restart development after changing backend code.

Import and recovery features are future work. Develop against isolated dummy folders only; real NAS access requires explicit configuration and authorization.

# viabl

A CLI tool for running, building, and deploying Viabl documentation projects.

---

## Requirements

- **Node.js** 18 or later
- **npm** (for content server dependency installation)
- **git** (optional — used during `init` for initial commit)

---

## Installation

```bash
npm install -g viabl
```

---

## Commands

### `viabl init [project-name]`

Scaffolds a new Viabl documentation project from the starter template.

```bash
viabl init my-docs
```

If `project-name` is omitted you will be prompted for one. The name is sanitised to lowercase with hyphens only.

**What it does:**

- Downloads the starter template from GitHub
- Creates a `docs.json` configuration file and example `.mdx` pages
- Runs `git init` and makes an initial commit (skipped silently if git is not found)

**Next steps after init:**

```bash
cd my-docs
viabl dev
```

---

### `viabl dev`

Starts the local development server. Downloads and caches the renderer and content server automatically on first run.

```bash
viabl dev
viabl dev --port 3000
```

| Option              | Default | Description                                                             |
| ------------------- | ------- | ----------------------------------------------------------------------- |
| `-p, --port <port>` | `7777`  | Port for the renderer. The content server uses the next available port. |

**Behaviour:**

- If the requested port is in use, the next available port is used automatically
- The renderer and content server are downloaded and cached in `~/.viabl/` on first run
- Subsequent runs reuse the cache unless a new version is available
- Press `Ctrl+C` to stop both servers — downloads in progress are cancelled cleanly

---

### `viabl build`

Assembles a self-contained production bundle in `.viabl/` inside your project directory.

```bash
viabl build
```

The output includes the renderer, content server, your docs, and a `start.js` entry point. It can be deployed to any environment with Node.js installed.

**Output structure:**

```
.viabl/
  renderer/         # Standalone Next.js renderer
  content-server/   # Content serving API
  docs/             # Your documentation source files
  start.js          # Production entry point
```

---

### `viabl start`

Runs the production bundle created by `viabl build`.

```bash
viabl start
viabl start --port 3000
```

| Option              | Default | Description      |
| ------------------- | ------- | ---------------- |
| `-p, --port <port>` | `7777`  | Port to serve on |

You can also set the port via environment variable:

```bash
PORT=8080 node .viabl/start.js
```

---

### `viabl update`

Checks for and downloads updates to the renderer and content server.

```bash
viabl update
```

If already on the latest version, nothing is downloaded. Safe to run at any time — press `Ctrl+C` to cancel a download in progress.

---

### `viabl clear-cache`

Removes the cached renderer and content server from `~/.viabl/`. They will be re-downloaded on the next `viabl dev` or `viabl build`.

```bash
viabl clear-cache          # prompts for confirmation
viabl clear-cache --force  # skips confirmation
```

| Option        | Description                  |
| ------------- | ---------------------------- |
| `-f, --force` | Skip the confirmation prompt |

---

### `viabl version-info`

Shows the currently installed versions of the renderer and content server.

```bash
viabl version-info
```

---

## Project Structure

A Viabl project expects the following layout:

```
my-docs/
  docs.json       # Required — project configuration and navigation
  *.mdx           # Documentation pages
```

`docs.json` must be present in the working directory when running `viabl dev`, `viabl build`, or `viabl start`.

---

## Cache Location

The renderer and content server are cached globally at `~/.viabl/`:

```
~/.viabl/
  renderer/           # Standalone renderer
  content-server/     # Content server + node_modules
  version.json        # Installed version metadata
```

Use `viabl clear-cache` to remove this directory and force a clean re-download.

---

## Signals & Cancellation

All commands that perform downloads (`dev`, `build`, `update`, `init`) handle `Ctrl+C` gracefully:

- In-progress downloads are cancelled immediately
- Partial temporary directories are cleaned up
- No corrupted state is left behind

---

## Troubleshooting

**`No docs.json found in current directory`**
Make sure you are running the command from inside your documentation project folder.

**`server.js not found — try: viabl update`**
The renderer cache may be missing or corrupted. Run `viabl update` or `viabl clear-cache` followed by `viabl dev`.

**`Could not spawn npm`**
`npm` is required to install content server dependencies. Make sure npm is installed and available in your `PATH`.

**`Could not start content server — is node installed and in your PATH?`**
Node.js 18 or later must be installed and in your `PATH`.

**`GitHub API rate limit exceeded`**
The CLI queries the GitHub API to check for updates. If you are rate-limited, wait a few minutes and try again. The CLI retries automatically up to 3 times on transient failures.

**Port already in use**
The CLI automatically finds the next available port if your requested port is taken. The new URL is printed at startup.

---

## License

MIT

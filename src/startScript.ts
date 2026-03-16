export const startScript = `#!/usr/bin/env node
const { spawn } = require("child_process");
const { join } = require("path");

const ROOT          = __dirname;
const RENDERER_DIR  = join(ROOT, "renderer");
const SERVER_DIR    = join(ROOT, "content-server");
const DOCS_DIR      = join(ROOT, "docs");
const RENDERER_PORT = parseInt(process.env.PORT ?? "7777", 10);
const CONTENT_PORT  = parseInt(process.env.CONTENT_PORT ?? String(RENDERER_PORT + 1), 10);

console.log("\\nViabl");
console.log("🌐 http://localhost:" + RENDERER_PORT + "\\n");

const contentChild = spawn("node", [join(SERVER_DIR, "dist", "index.js")], {
  env: {
    ...process.env,
    DOCS_ROOT:    DOCS_DIR,
    CONTENT_PORT: String(CONTENT_PORT),
  },
  stdio: "inherit",
});

const rendererChild = spawn("node", [join(RENDERER_DIR, "server.js")], {
  env: {
    ...process.env,
    DOCS_ROOT:          DOCS_DIR,
    PORT:               String(RENDERER_PORT),
    HOSTNAME:           "0.0.0.0",
    CONTENT_SERVER_URL: "http://localhost:" + CONTENT_PORT,
  },
  stdio: ["inherit", "pipe", "pipe"],
});

let isShuttingDown = false;

rendererChild.stderr?.on("data", (data) => {
  if (isShuttingDown) return;
  process.stderr.write(data);
});

rendererChild.stdout?.on("data", (data) => {
  if (isShuttingDown) return;
  process.stdout.write(data);
});

rendererChild.on("exit", (code) => {
  if (isShuttingDown) return;
  contentChild.kill();
  process.exit(code ?? 0);
});

const shutdown = () => {
  isShuttingDown = true;

  rendererChild.kill("SIGTERM");

  rendererChild.once("exit", () => {
    contentChild.kill("SIGTERM");

    contentChild.once("exit", () => {
      process.exit(0);
    });

    setTimeout(() => {
      contentChild.kill("SIGKILL");
      process.exit(0);
    }, 3000).unref();
  });

  setTimeout(() => {
    rendererChild.kill("SIGKILL");
    contentChild.kill("SIGKILL");
    process.exit(0);
  }, 5000).unref();
};

process.on("SIGINT",  shutdown);
process.on("SIGTERM", shutdown);
`;

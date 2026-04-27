import chalk from "chalk";
import { createServer } from "net";

export function isPortInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(true));
    server.once("listening", () => {
      server.close();
      resolve(false);
    });
    server.listen(port, "127.0.0.1");
  });
}

export async function findAvailablePort(startPort: number): Promise<number> {
  let port = startPort;
  while (await isPortInUse(port)) {
    console.log(chalk.dim(`  Port ${port} in use, trying ${port + 1}...`));
    port++;
  }
  return port;
}

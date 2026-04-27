import spawn from "cross-spawn";

export async function gitInit(projectDir: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("git", ["init"], { cwd: projectDir, stdio: "ignore" });
    child.on("error", () => reject(new Error("git not found")));
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error("git init failed")),
    );
  });
}

export async function gitCommit(
  projectDir: string,
  message: string,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const add = spawn("git", ["add", "."], {
      cwd: projectDir,
      stdio: "ignore",
    });
    add.on("error", () => reject(new Error("git not found")));
    add.on("exit", (code) => {
      if (code !== 0) return reject(new Error("git add failed"));
      const commit = spawn("git", ["commit", "-m", message], {
        cwd: projectDir,
        stdio: "ignore",
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "Viabl",
          GIT_AUTHOR_EMAIL: "init@viabl.dev",
          GIT_COMMITTER_NAME: "Viabl",
          GIT_COMMITTER_EMAIL: "init@viabl.dev",
        },
      });
      commit.on("exit", (c) =>
        c === 0 ? resolve() : reject(new Error("git commit failed")),
      );
    });
  });
}

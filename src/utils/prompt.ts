import { createInterface } from "readline";

export function prompt(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    let answered = false;

    rl.question(question, (answer) => {
      answered = true;
      rl.close();
      resolve(answer.trim());
    });

    rl.on("close", () => {
      if (!answered) resolve("");
    });
  });
}

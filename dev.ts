import type { Subprocess } from "bun";
import { spawn } from "bun";

console.log("Starting all processes...\n");

const processes = [
  { name: "Alice", file: "src/alice.ts" },
  { name: "Gateway", file: "src/gateway.ts" },
  { name: "Dealer", file: "src/dealer.ts" },
];

const procs: Subprocess[] = [];

for (const proc of processes) {
  const bunProc = spawn({
    cmd: ["bun", "run", proc.file],
    stdout: "pipe",
    stderr: "pipe",
  });

  procs.push(bunProc);

  (async () => {
    const reader = bunProc.stdout.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value);
      process.stdout.write(text);
    }
  })();

  (async () => {
    const reader = bunProc.stderr.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value);
      process.stderr.write(text);
    }
  })();
}

process.on("SIGINT", () => {
  console.log("\n\nShutting down all processes...");
  for (const p of procs) {
    p.kill();
  }
  process.exit(0);
});

await Promise.all(procs.map((p) => p.exited));

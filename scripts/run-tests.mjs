import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";

const files = readdirSync("tests")
  .filter((file) => file.endsWith(".test.mjs"))
  .sort()
  .map((file) => `tests/${file}`);

if (!files.length) {
  console.error("No test files found in tests/*.test.mjs");
  process.exit(1);
}

const result = spawnSync(process.execPath, ["--test", ...files], {
  stdio: "inherit"
});

process.exit(result.status ?? 1);

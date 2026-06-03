import { readFileSync } from "node:fs";

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const stripVersionPrefix = (value) => String(value || "").trim().replace(/^v/i, "");
const fail = (message) => {
  console.error(message);
  process.exitCode = 1;
};

const packageJson = readJson("package.json");
const packageLock = readJson("package-lock.json");
const cargoToml = readFileSync("src-tauri/Cargo.toml", "utf8");
const tauriConfig = readJson("src-tauri/tauri.conf.json");
const expected = packageJson.version;
const requestedVersion = stripVersionPrefix(process.env.RELEASE_VERSION || process.env.GITHUB_REF_NAME || "");

const cargoVersion = cargoToml.match(/^version\s*=\s*"([^"]+)"/m)?.[1];

const checks = [
  ["package-lock.json version", packageLock.version],
  ["package-lock root package version", packageLock.packages?.[""]?.version],
  ["src-tauri/Cargo.toml version", cargoVersion],
  ["src-tauri/tauri.conf.json version", tauriConfig.version]
];

for (const [label, actual] of checks) {
  if (actual !== expected) {
    fail(`${label} is ${actual || "<missing>"} but package.json version is ${expected}`);
  }
}

if (requestedVersion && requestedVersion !== expected) {
  fail(`release version ${requestedVersion} does not match package.json version ${expected}`);
}

if (process.exitCode) {
  process.exit();
}

console.log(`Version check passed: ${expected}`);

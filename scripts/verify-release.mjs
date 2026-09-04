import { readFile } from "node:fs/promises";

const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const version = process.env["RELEASE_VERSION"];
const confirmation = process.env["RELEASE_CONFIRMATION"];

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

requireCondition(manifest.name === "noesisai", "Release package must be named noesisai");
requireCondition(
  typeof manifest.version === "string" && /^0\.0\.[1-9][0-9]*$/u.test(manifest.version),
  "Release version must be a non-zero 0.0.x version",
);
requireCondition(version === manifest.version, `Requested version must equal ${manifest.version}`);
requireCondition(
  confirmation === `stage ${manifest.name}@${manifest.version}`,
  `Confirmation must be exactly: stage ${manifest.name}@${manifest.version}`,
);

console.log(`Release inputs verified for ${manifest.name}@${manifest.version}`);

#! /usr/bin/env node

import fs from "fs";
import { execSync } from "child_process";

// Bundles the compiled wasm directly in the js file so that `install()` can finish synchronously
// and symbolicate callstacks that happen on launch
// Usage: node build.js

const OUT = "dist/index.js";
const WASM = "target/wasm32-unknown-unknown/release/backtrace_wasm.wasm";

try {
  // Build wasm
  console.log("Building WASM...");
  execSync("cargo build --release", { stdio: "inherit" });
  execSync(
    "wasm-opt -O3 --strip-debug --strip-dwarf --strip target/wasm32-unknown-unknown/release/backtrace_wasm.wasm -o target/wasm32-unknown-unknown/release/backtrace_wasm.wasm",
    { stdio: "inherit" }
  );

  if (!fs.existsSync(WASM)) {
    console.error(`WASM file not found: ${WASM}`);
    process.exit(1);
  }

  // Copy to dist/
  if (!fs.existsSync("dist")) {
    fs.mkdirSync("dist", { recursive: true });
  }
  fs.copyFileSync("index.js", OUT);

  // Embed the wasm at the end of the file
  const wasmBuffer = fs.readFileSync(WASM);
  const base64 = wasmBuffer.toString("base64");
  const length = wasmBuffer.length;

  const wasmFunction = `

function getBacktraceWasm() {
  const BACKTRACE_WASM_BASE64 = '${base64}';
  const str = atob(BACKTRACE_WASM_BASE64);
  const buffer = new Uint8Array(${length});
  for (let i = 0; i < str.length; i++)
    buffer[i] = str.charCodeAt(i);
  return buffer;
}

`;

  fs.appendFileSync(OUT, wasmFunction);

  console.log("Build completed successfully!");
} catch (error) {
  console.error("Build failed:", error);
  process.exit(1);
}

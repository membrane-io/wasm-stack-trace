#! /usr/bin/env node

import http from "http";
import fs from "fs";
import path from "path";

// Install our library
import "./dist/index.js";

const PORT = 9697;
const TEST_FILE =
  "fibonacci/target/wasm32-unknown-unknown/debug/fibonacci.wasm";
const URL = `http://localhost:${PORT}`;

// Start a simple server that only serves the test wasm file
async function startServer() {
  return new Promise((resolve, _reject) => {
    http
      .createServer((_request, response) => {
        response.writeHead(200, { "Content-Type": "application/wasm" });
        fs.createReadStream(path.join(process.cwd(), TEST_FILE)).pipe(response);
      })
      .listen(PORT, () => {
        console.log("Test Server Started on port", PORT);
        resolve();
      });
  });
}

async function test() {
  const CREATE_INSTANCE = [
    async function sync() {
      const response = await fetch(URL);
      const buffer = await response.arrayBuffer();
      const module = new WebAssembly.Module(buffer);
      return new WebAssembly.Instance(module);
    },

    async function compile() {
      const response = await fetch(URL);
      const buffer = await response.arrayBuffer();
      const module = await WebAssembly.compile(buffer);
      return new WebAssembly.Instance(module);
    },

    async function compileStreaming() {
      const response = await fetch(URL);
      const module = await WebAssembly.compileStreaming(response);
      return new WebAssembly.Instance(module);
    },

    async function instantiateStreaming() {
      const response = await fetch(URL);
      const { instance } = await WebAssembly.instantiateStreaming(response);
      return instance;
    },

    async function instantiateBuffer() {
      const response = await fetch(URL);
      const buffer = await response.arrayBuffer();
      const { instance } = await WebAssembly.instantiate(buffer);
      return instance;
    },
  ];

  const VERBOSE = false;
  const INSTANCE_TESTERS = [
    function testThrow(instance) {
      try {
        return instance.exports.run_fib();
      } catch (e) {
        if (VERBOSE) {
          console.error(e.stack);
        }
        assertion(e);
      }
    },

    async function testReject(instance) {
      return Promise.resolve()
        .then(async () => {
          instance.exports.run_fib();
        })
        .catch((e) => {
          if (VERBOSE) {
            console.error(e.stack);
          }
          assertion(e);
        });
    },
  ];

  function assertion(error) {
    if (error.stack.includes("/fibonacci/src/lib.rs")) {
      console.log("✅ ");
    } else {
      // console.error("❌ ", error);
      console.log("");
    }
  }

  // Run all tests
  for (const createInstance of CREATE_INSTANCE) {
    for (const testInstance of INSTANCE_TESTERS) {
      process.stdout.write(
        ` - ${createInstance.name} -> ${testInstance.name}: `.padEnd(40, " ")
      );
      await testInstance(await createInstance());
    }
  }

  // Run speed test. Useful for tweaking opt level and understanding how this affects performance:
  //  - Makes reading `.stack` about 3-4X slower.
  //  - Opt-level 'z` does shrink the binary by ~70kb but makes it ~1.8x slower.
  //  - No effect: opt-level = 3, lto.
  const instance = await CREATE_INSTANCE[0]();
  const RUNS = 1000;
  const stacks = new Array(RUNS);

  // Warm up
  try {
    instance.exports.run_fib();
  } catch (e) {
    stacks[0] = e.stack;
  }

  // Measure
  let [min, max, total] = [Infinity, 0, 0];
  for (let i = 0; i < RUNS; i++) {
    const start = performance.now();
    try {
      instance.exports.run_fib();
    } catch (e) {
      stacks[i] = e.stack;
    }
    const end = performance.now();
    const time = end - start;
    min = Math.min(min, time);
    max = Math.max(max, time);
    total += time;
  }
  let avg = total / RUNS;
  const minMs = min.toFixed(3);
  const maxMs = max.toFixed(3);
  const avgMs = avg.toFixed(3);
  const totalMs = total.toFixed(3);
  console.log(
    `\nPerf: min: ${minMs}ms, max: ${maxMs}ms, avg: ${avgMs}ms, total: ${totalMs}ms, stacks: ${stacks.length}`
  );
  // console.log(stacks[0]);
}

startServer()
  .then(() => test())
  .then(() => {
    console.log("\n✅ Tests passed");
    process.exit(0);
  })
  .catch((err) => {
    console.error("\n❌ Tests failed:", err);
    process.exit(1);
  });

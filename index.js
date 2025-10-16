#! /usr/bin/env node

// Increase callstack. The default of 10 is mostly useless
Error.stackTraceLimit = 100;

/**
 * Sets up all the machinery so that callstacks in errors have demangled symbols and actual
 * file/line/column information.
 *  - Patches WebAssembly functions so that we can track the original .wasm file and map modules
 *    and instances to it.
 *  - For every wasm module created, we instantiate another "symbolicator" wasm module that knows
 *    have to turn addresses into symbols from embedded DWARF data. The latter loads the former
 *    into its memory in order to parse the DWARF data.
 *  - The "symbolicator" module is embedded as a base64 literal at the end of this file so that we
 *    can distribute this as a single file and avoid any configuration. It also allows `install` to
 *    be sync to avoid race conditions with other modules loading.
 *  - Sets an Error.prepareStackTrace that formats the callstack for every Error.
 */
function install() {
  // We're going to monkey patch these. Save the originals so we can use them below.
  const Original = {
    Module: WebAssembly.Module,
    Instance: WebAssembly.Instance,
  };

  // The auxiliary wasm module that knows how to parse DWARF data
  const symbolicatorModule = new Original.Module(getBacktraceWasm());

  class Symbolicator {
    /** Map from Module to the raw .wasm file captured during module compilation */
    static moduleToFile = new WeakMap();

    /** Map from Instance to the Module that created it */
    static instanceToModule = new WeakMap();

    /** Map from Module to Symbolicator instances */
    static symbolicators = new WeakMap();

    // Retain the original .wasm file so that we can symbolicate errors.
    static retainFile(module, file) {
      Symbolicator.moduleToFile.set(module, file);
    }

    static retainInstance(instance, module) {
      Symbolicator.instanceToModule.set(instance, module);
    }

    static get(instance) {
      const module = Symbolicator.instanceToModule.get(instance);

      let symbolicator = Symbolicator.symbolicators.get(module);
      if (symbolicator === null) {
        // We've already tried and failed to instantiate a symbolicator for this module
        return null;
      } else if (!symbolicator) {
        try {
          const file = Symbolicator.moduleToFile.get(module);
          if (!file) {
            throw new Error(
              "No .wasm file found for module. Was it created before calling install()?"
            );
          }
          symbolicator = new Symbolicator(file);
        } catch (e) {
          console.error(`Failed to instantiate wasm symbolicator:`, e);
          // Store null so we don't keep trying
          symbolicator = null;
        }
        Symbolicator.symbolicators.set(module, symbolicator);
      }
      return symbolicator;
    }

    /**
     * Creates a new Symbolicator instance for the given .wasm file. Don't call this directly, instead use Symbolicator.get() which caches instances for faster reuse.
     * @param {ArrayBuffer} file Raw .wasm file
     */
    constructor(file) {
      this.file = file;

      // Instantiate a new backtrace-wasm Instance. This must be done synchronously because the
      // caller is probably in the middle of formatting an Error callstack.
      this.bt = new Original.Instance(symbolicatorModule, {
        env: {
          // Allows backtrace-wasm to read chunks of the target module file
          read_chunk: (destAddr, srcAddr, len) => {
            const dest = new Uint8Array(
              this.bt.exports.memory.buffer,
              destAddr,
              len
            );
            const src = new Uint8Array(this.file, srcAddr, len);
            dest.set(src);
            return len;
          },

          // For debugging
          print: (message, len) => {
            console.log("> ", this.readString(message, len));
          },

          // Called during address_to_frame. Usually once but potentially multiple times if inlined code is found
          on_frame: (
            symbol,
            symbolLen,
            location,
            locationLen,
            line,
            column
          ) => {
            if (symbol) {
              this.lastFrame = {
                symbol: this.readString(symbol, symbolLen),
                location: this.readString(location, locationLen),
                line: line,
                column: column,
              };
            }
          },

          // Called whenever backtrace-wasm encounters an error
          on_error: (message, len) => {
            this.lastError = this.readString(message, len);
          },
        },
      });

      // Prepare the backtrace-wasm instance so that it's ready to turn addresses into frames
      this.baseOffset = this.bt.exports.init(this.file.byteLength);
      this.throwIfError();
    }

    readString(offset, length) {
      const bytes = new Uint8Array(
        this.bt.exports.memory.buffer,
        offset,
        length
      );
      return new TextDecoder().decode(bytes);
    }

    throwIfError() {
      const error = this.lastError;
      this.lastError = null;
      if (error) {
        console.error(`Failure in backtrace-wasm: ${error}`);
        throw new Error("Failure in backtrace-wasm: " + error);
      }
    }

    /**
     * Converts the given address (file-relative) to the corresponding Frame object.
     * @param {number} address
     * @returns
     */
    addressToFrame(address) {
      try {
        this.bt.exports.address_to_frame(address - this.baseOffset);
        this.throwIfError();
        return this.lastFrame;
      } catch (e) {
        return null;
      }
    }

    /**
     * Converts the given call stack line to the corresponding Frame object.
     * @param {string} line - A call stack line from Error.stack
     * @returns
     */
    lineToFrame(line) {
      // Extract the address from this call stack line.
      const match = line.match(/(0x[0-9a-fA-F]+)/);
      if (!match) {
        return null;
      }
      const address = parseInt(match[1], 16);
      if (!address) {
        return null;
      }
      return this.addressToFrame(address);
    }

    /**
     * Symbolicates the given error in place by resolving wasm stack frames. You normally don't need to use
     * this since prepareStackTrace is automatically called on Error objects, but I'm leaving it
     * here for completeness.
     * @param {Error} error - The error to symbolicate
     * @returns {Error} The passed error (symbolicated)
     */
    symbolicate(error) {
      error.stack = error.stack
        .split("\n")
        .map((line) => {
          const frame = this.lineToFrame(line);
          if (frame) {
            return `    at ${frame.symbol} (${frame.location}:${frame.line}:${frame.column})`;
          }
          return line;
        })
        .join("\n");
      return error;
    }
  }

  /** Custom prepareStackTrace function that resolves wasm stack frames. */
  Error.prepareStackTrace = (error, trace) => {
    let prepared = error.toString();
    for (const callsite of trace) {
      // Only wasm callsites have an instance
      const instance = callsite.getThis();
      const bt =
        instance instanceof WebAssembly.Instance && Symbolicator.get(instance);
      if (bt) {
        try {
          const frame = bt.addressToFrame(callsite.getPosition());
          prepared += `\n    at ${frame.symbol} (${frame.location}:${frame.line}:${frame.column})`;
        } catch (e) {
          prepared += `\n    at ${callsite.toString()} (Failed to symbolicate wasm)`;
        }
      } else {
        // Normal JS callsites
        prepared += `\n    at ${callsite.toString()}`;
      }
    }
    return prepared;
  };

  // Monkey patch WebAssembly functions so that we can keep track of:
  //  - The raw .wasm file used to create each module
  //  - The Module used to create each Instance

  const originalCompileStreaming = WebAssembly.compileStreaming;
  WebAssembly.compileStreaming = async (source, ...args) => {
    // Here we await `source` because it might be a `Promise<Response>`
    let response = await source;

    // Split the response into two ReadableStream objects so that we can save the original buffer
    // for later symbolication
    const [source1, source2] = response.body
      .tee()
      .map((stream) => new Response(stream, { headers: response.headers }));
    const [buffer, module] = await Promise.all([
      source1.arrayBuffer(),
      originalCompileStreaming(source2, ...args),
    ]);
    Symbolicator.retainFile(module, buffer);
    return module;
  };

  const originalCompile = WebAssembly.compile;
  WebAssembly.compile = async (source, ...args) => {
    // Source must be a TypedArray or ArrayBuffer
    let buffer = source?.buffer || source;
    const module = await originalCompile(buffer, ...args);
    Symbolicator.retainFile(module, buffer);
    return module;
  };

  const originalInstantiateStreaming = WebAssembly.instantiateStreaming;
  WebAssembly.instantiateStreaming = async (source, ...args) => {
    let response = await source;
    const [source1, source2] = response.body
      .tee()
      .map((stream) => new Response(stream, { headers: response.headers }));
    const [buffer, { instance, module }] = await Promise.all([
      source1.arrayBuffer(),
      originalInstantiateStreaming(source2, ...args),
    ]);
    Symbolicator.retainFile(module, buffer);
    Symbolicator.retainInstance(instance, module);
    return { instance, module };
  };

  const originalInstantiate = WebAssembly.instantiate;
  WebAssembly.instantiate = async (source, ...args) => {
    // Source must be a Module, TypedArray or ArrayBuffer
    let module;
    let instance;
    if (source instanceof Original.Module) {
      module = source;
      instance = await originalInstantiate(module, ...args);
    } else {
      let buffer = source?.buffer || source;
      const result = await originalInstantiate(buffer, ...args);
      ({ instance, module } = result);
      Symbolicator.retainFile(module, buffer);
    }
    Symbolicator.retainInstance(instance, module);
    return { instance, module };
  };

  WebAssembly.Instance = function Instance(module, ...args) {
    const instance = new Original.Instance(module, ...args);
    Symbolicator.retainInstance(instance, module);
    return instance;
  };
  // Make instanceof return true for WebAssembly.Instance
  WebAssembly.Instance.prototype = Original.Instance.prototype;

  WebAssembly.Module = function Module(source, ...args) {
    const buffer = source?.buffer || source;
    const module = new Original.Module(buffer, ...args);
    Symbolicator.retainFile(module, buffer);
    return module;
  };
  // Make instanceof return true for WebAssembly.Module
  WebAssembly.Module.prototype = Original.Module.prototype;
}
install();

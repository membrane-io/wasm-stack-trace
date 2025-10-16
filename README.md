# wasm-symbolicator

Wasm stack trace symbolication using embedded DWARF data. Works in the browser and node.js

## How to use

```
 // TODO
```

Make sure you include _some_ debug data in your wasm. In rust, you can use one of these options:

```toml
[profile.dev]
debug = "line-tables-only"     # Recommended. Everything you need for proper stack traces.

debug = 1                      # Not sure if this helps with stack traces. but it "Generates more
                               # detailed module level info"

debug = 2                      # Default for "dev". Includes info on variables and types that are
                               # only used by debuggers. Greatly increases binary size so it's not
                               # recommended unless you plan to attach a debugger.
```

You can use these in `[profile.release]` if you prefer.

## How does it work?

- Patches WebAssembly functions so that it can map instances and modules to their corresponding
  .wasm file, where the DWARF data lives.
- Then, when a wasm module is compiled, we instantiate an tiny-ish (272kb) auxiliary wasm module that uses DWARF
  to convert the addresses reported in browser callstacks into proper demangled symbols and their
  corresponding location on disk (file/line/column). The latter loads the former into its memory in
  order to parse the DWARF data.
- The auxiliary module is lazily instantiated whenever an `Error.stack` property is accessed
  containing at least one wasm frame.
- The auxiliary wasm module is embedded as a base64 literal at the end of index.js file so the whole
  thing can be distributed as one .js file and avoid manual setup. It also allows `install` to
  run synchronously so that you can be sure that stacks will be symbolicated immedaitely.
- Finally, it sets an Error.prepareStackTrace that formats the callstack for every Error.
- Zero JavaScript dependencies. Only three (direct) rust dependencies for parsing wasm, parsing
  dwarf, and addr2line.

## Limitations

- The auxiliary module copies the entire main module's file into linear memory. This
  can be improved if it becomes problematic, we should be able to at least skip the code section.
  Usually the DWARF data is the heaviest so I'm not too concerned about this.
- Won't properly expand inlined functions. Should be easy to fix though.
- Not yet tested with languages other than Rust (should work for C++ by enabling the right cargo feature)
- Not yet tested on Firefox
- Not yet tested on Safari

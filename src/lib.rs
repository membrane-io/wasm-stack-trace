#![allow(static_mut_refs)]
use object::{Object as _, ObjectSection};
use std::io::{Read, Seek, SeekFrom};
use std::sync::RwLock;
use std::{
    borrow::Cow,
    sync::{Arc, LazyLock},
};

unsafe extern "C" {
    /// Read a chunk of bytes from the wasm module with the given id into the specified dest of this module's memory.
    fn read_chunk(dest: *mut u8, src: usize, len: usize) -> usize;

    /// Called during address_to_frame so that JS can copy the frame data out of the wasm memory. If
    /// `symbol` is null, the original line should be used.
    /// Ideally address_to_frame would just return the frame data but since Rust doesn't support multiple return values we
    /// use this callback instead.
    fn on_frame(
        symbol: *const u8,
        symbol_len: usize,
        location: *const u8,
        location_len: usize,
        line: u32,
        column: u32,
    );

    /// This can be called during init or address_to_frame to report an error. If this gets called, call did not succeed.
    fn on_error(message: *const u8, len: usize);

    /// Print a message to the console.
    #[allow(unused)]
    fn print(message: *const u8, len: usize);
}

struct ModuleReader {
    len: usize,
    pos: usize,
}
impl ModuleReader {
    fn new(len: usize) -> Self {
        Self { len, pos: 0 }
    }
}

impl Read for ModuleReader {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let len = buf.len();
        let ret = unsafe { read_chunk(buf.as_mut_ptr(), self.pos, len) };
        self.pos += ret as usize;
        Ok(ret as usize)
    }
}
impl Seek for ModuleReader {
    fn seek(&mut self, pos: SeekFrom) -> std::io::Result<u64> {
        self.pos = match pos {
            SeekFrom::Start(pos) => pos as usize,
            SeekFrom::End(pos) => self.len + pos as usize,
            SeekFrom::Current(pos) => self.pos + pos as usize,
        };
        Ok(self.pos as u64)
    }
}

type Context = addr2line::Context<gimli::EndianSlice<'static, gimli::LittleEndian>>;

static mut CONTEXT: LazyLock<RwLock<Option<Arc<Context>>>> = LazyLock::new(|| RwLock::new(None));

fn get_context() -> Option<Arc<Context>> {
    unsafe {
        let lock = CONTEXT.read().unwrap();
        lock.as_ref().cloned()
    }
}

fn set_context(context: Arc<Context>) {
    unsafe {
        let mut lock = CONTEXT.write().unwrap();
        *lock = Some(context);
    }
}

#[allow(unused)]
fn log(message: impl AsRef<str>) {
    let message = message.as_ref();
    unsafe { print(message.as_ptr(), message.len()) };
}

#[unsafe(no_mangle)]
extern "C" fn init(len: usize) -> i32 {
    match init_impl(len) {
        Ok(base_offset) => base_offset as i32,
        Err(e) => {
            e.report();
            -2
        }
    }
}

fn init_impl(len: usize) -> Result<usize, Error> {
    // Create a `ModuleReader` that can read chunks of the wasm module as needed.
    // This reader must outlive this function, however, afaict the `object` crate only works with
    // borrowed data, so we must leak it to give it a 'static lifetime.
    // TODO: use `wasmparser` instead of `object` since the object create loads the entire module into memory.
    let reader = ModuleReader::new(len);
    let cached_reader = Box::leak(Box::new(object::ReadCache::new(reader)));

    // The object crate parses the wasm module and determines the location of each section.
    let object = object::wasm::WasmFile::parse(cached_reader as &_).map_err(|e| e.to_string())?;

    // Determine the offset of the <code> section within the wasm module. Addresses reported in the
    // browser's callstack are relative to the wasm module, but DWARF addresses are relative to the
    // code section. We use `code_section_offset` to convert callstack addresses into DWARF
    // addresses.
    let code_section_offset = object
        .section_by_name("<code>")
        .and_then(|section| section.file_range())
        .map(|range| range.0 as usize)
        .ok_or("Code section not found")?;

    // Create the `Dwarf` structure.
    let dwarf = gimli::Dwarf::load(|id| {
        let section = object.section_by_name(id.name());
        let Some(section) = section else {
            // Return an empty section if the section does not exist.
            return Ok(gimli::EndianSlice::new(&[], gimli::LittleEndian));
        };
        let data = match section.uncompressed_data().map_err(|e| e.to_string())? {
            Cow::Borrowed(b) => Ok(b),
            Cow::Owned(_b) => Err("Compressed section not supported yet"),
        }?;
        Ok::<_, String>(gimli::EndianSlice::new(&data, gimli::LittleEndian))
    })
    .map_err(|e| e.to_string())?;

    // Create the `addr2line::Context` that knows how to map each address into its symbol and location.
    let ctx = Arc::new(Context::from_dwarf(dwarf).unwrap());
    set_context(ctx);

    Ok(code_section_offset)
}

#[unsafe(no_mangle)]
extern "C" fn address_to_frame(address: usize) {
    match address_to_line_impl(address) {
        Ok(_) => {}
        Err(e) => {
            e.report();
        }
    }
}

struct Error(Cow<'static, str>);

impl From<&'static str> for Error {
    fn from(value: &'static str) -> Self {
        Self(value.into())
    }
}
impl From<String> for Error {
    fn from(value: String) -> Self {
        Self(value.into())
    }
}
impl Error {
    fn report(&self) {
        unsafe { on_error(self.0.as_ptr(), self.0.len()) };
    }
}

fn address_to_line_impl(address: usize) -> Result<(), Error> {
    let ctx = get_context().ok_or("Context not found")?;
    let mut frames = match ctx.find_frames(address as u64) {
        addr2line::LookupResult::Output(output) => output.map_err(|e| e.to_string())?,
        addr2line::LookupResult::Load { .. } => {
            return Err("Split DWARF not supported yet".into());
        }
    };
    // TODO: addr2line can return multiple frames per address because of inlined functions. For now
    // we return the first frame.
    while let Some(frame) = frames.next().map_err(|e| e.to_string())? {
        let symbol = frame
            .function
            .as_ref()
            .map(|f| f.demangle().unwrap_or_else(|_| f.name.to_string_lossy()));
        let location = frame.location.as_ref().and_then(|l| l.file);
        unsafe {
            let (symbol, symbol_len) = symbol
                .as_ref()
                .map(|s| (s.as_bytes(), s.len()))
                .unwrap_or((&[], 0));
            let (location, location_len) = location
                .map(|l| (l.as_bytes(), l.len()))
                .unwrap_or((&[], 0));
            let line = frame.location.as_ref().and_then(|l| l.line);
            let column = frame.location.as_ref().and_then(|l| l.column);
            on_frame(
                symbol.as_ptr(),
                symbol_len,
                location.as_ptr(),
                location_len,
                line.unwrap_or(0),
                column.unwrap_or(0),
            );
            return Ok(());
        }
    }
    Err("No frame found".into())
}

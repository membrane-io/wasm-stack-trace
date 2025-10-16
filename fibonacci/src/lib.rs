#[unsafe(no_mangle)]
pub extern "C" fn run_fib() {
    fib(20);
}

fn fib(n: i32) -> i32 {
    if n == 7 {
        panic!("Crashed at fib(7)!");
    }
    if n % 3 == 0 {
        detour(|| fib(n - 1) + fib(n - 2));
    }
    if n <= 1 {
        return n;
    }
    fib(n - 1) + fib(n - 2)
}

fn detour(f: impl Fn() -> i32) -> i32 {
    f()
}

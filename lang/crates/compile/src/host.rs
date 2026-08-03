// =====================================================================
// compile/host.rs — WHERE THE CODE IS GOING TO RUN.
//
// A host is a target triple plus the conventions that come with it: how
// arguments are passed, how a program says it succeeded, what the object
// files are called, how they are linked.
//
// Named and listed rather than left implicit, because "it works on my
// machine" is exactly what an implicit host means. Adding a second host
// is adding a value here — and the compiler will not build until every
// `match` on Host has an arm for it, which is the point of making this an
// enum instead of a string.
//
// One host today: Linux x86-64. Everything else is a stub with a message
// saying so, rather than a silent fallback to the wrong ABI.
// =====================================================================

/// A place a compiled program can run.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Host {
    /// x86-64 Linux, System V ABI. The one that works.
    LinuxX64,
}

impl Host {
    /// The host this compiler is running on — the default target, the
    /// way `zig build` targets the machine you are sitting at.
    ///
    /// Resolved at COMPILE time from the cfg of the compiler itself, not
    /// at runtime from `uname`. A compiler cross-built for one machine
    /// and run on another would otherwise claim the wrong default.
    pub fn native() -> Result<Host, String> {
        #[cfg(all(target_arch = "x86_64", target_os = "linux"))]
        {
            Ok(Host::LinuxX64)
        }
        #[cfg(not(all(target_arch = "x86_64", target_os = "linux")))]
        {
            Err(format!(
                "no ABI yet for {}-{}; the only host implemented is {}",
                std::env::consts::ARCH,
                std::env::consts::OS,
                Host::LinuxX64.triple(),
            ))
        }
    }

    /// Parses the `--target` a user typed.
    ///
    /// Accepts the full LLVM triple and the short name, because the
    /// short one is what anybody actually types and rejecting it would
    /// be pedantry.
    pub fn parse(text: &str) -> Result<Host, String> {
        match text {
            "x86_64-unknown-linux-gnu" | "x86_64-linux" | "linux-x64" => Ok(Host::LinuxX64),
            other => Err(format!(
                "unknown target `{other}`; the hosts this compiler knows are: {}",
                Host::ALL.iter().map(|h| h.triple()).collect::<Vec<_>>().join(", "),
            )),
        }
    }

    /// Every host, so `--target` can list them and a future `linen
    /// targets` has something to print.
    pub const ALL: &'static [Host] = &[Host::LinuxX64];

    /// The LLVM target triple. This is what the backend sets on the
    /// module, and getting it wrong yields code that is subtly for
    /// another machine.
    pub fn triple(self) -> &'static str {
        match self {
            Host::LinuxX64 => "x86_64-unknown-linux-gnu",
        }
    }

    /// The calling convention. Not used until there is codegen, but
    /// stated here so the ABI lives in one place rather than being
    /// rediscovered at each call site.
    pub fn calling_convention(self) -> CallingConvention {
        match self {
            Host::LinuxX64 => CallingConvention::SystemV,
        }
    }

    /// What an object file is called here.
    pub fn object_extension(self) -> &'static str {
        match self {
            Host::LinuxX64 => "o",
        }
    }

    /// What an executable is called here — empty on Unix, `exe`
    /// elsewhere.
    pub fn executable_extension(self) -> &'static str {
        match self {
            Host::LinuxX64 => "",
        }
    }
}

/// How arguments reach a function and how results come back.
///
/// An enum with one member today. It exists so that adding a host with a
/// different convention is a new variant the compiler forces every match
/// to handle, rather than an `if triple.contains("windows")` grown
/// somewhere in the backend.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum CallingConvention {
    /// System V AMD64: integer arguments in rdi, rsi, rdx, rcx, r8, r9;
    /// result in rax. What Linux, macOS and the BSDs use on x86-64.
    SystemV,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_the_machine_it_is_built_for() {
        // On any machine this compiler currently supports, there is a
        // native host. The error path is for the machines it does not.
        assert!(Host::native().is_ok() || cfg!(not(all(target_arch = "x86_64", target_os = "linux"))));
    }

    #[test]
    fn accepts_the_full_triple_and_the_short_name() {
        assert_eq!(Host::parse("x86_64-unknown-linux-gnu"), Ok(Host::LinuxX64));
        assert_eq!(Host::parse("linux-x64"), Ok(Host::LinuxX64));
    }

    #[test]
    fn an_unknown_target_says_which_ones_exist() {
        // "unknown target" alone leaves the user guessing at the
        // spelling; listing them answers the next question too.
        let message = Host::parse("sparc-sun-solaris").expect_err("should reject");
        assert!(message.contains("x86_64-unknown-linux-gnu"), "got: {message}");
    }

    #[test]
    fn every_host_round_trips_through_its_own_triple() {
        // A triple that does not parse back is a host nobody can select.
        for host in Host::ALL {
            assert_eq!(Host::parse(host.triple()), Ok(*host));
        }
    }
}

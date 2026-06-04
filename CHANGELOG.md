# Changelog

All notable changes to the CGen VS Code extension are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Unreleased]

### Added

- Webview file actions menu with Open, Save, and Save As
- Webview run actions menu with Generate, Build, and Generate & Build
- `project.type` support for executable, static, shared, interface, and auto CMake targets
- Explicit `Ctrl+Shift+I` formatting shortcut for `.cgen` documents

### Changed

- Unbound webview sessions save to `.cgen/session.cgen` without opening Save As
- Generation and build are independent operations
- Function visibility now uses `@public`, `@private`, and `@inline`; argument-based `@public(header|source|all)` is removed
- `@extern` enum cases emit external declarations without generated source definitions
- `@public` enum cases emit declarations in headers and definitions in sources
- `@intrinsic` marks aliases and templates that resolve without direct C emission
- `none` return type maps to C `void`; struct method `any` resolves to `none` when no value is returned
- Function bodies support checked `self.field = value` assignment, restricted to mutable methods
- Assignment requires both a `mutable fn` receiver and a `mutable field` or `mutable template`
- Function parameters can be declared inline in the signature or as leading `param` lines in the body

## [0.0.78] - 2026-06-04

### Added

- `let name -> T = expr` statement in function bodies (`let name = expr` with inferred type also supported)
- `scope` keyword — virtual namespace that contributes to guard/path but not to C symbol names
- `mutable fn` — struct method with non-const `self` pointer
- `mutable` parameter modifier on `fn` parameters
- `struct` keyword for declaring struct types with methods
- Struct methods with implicit `self` parameter (const pointer by default)
- Auto-return type inference for `-> any` when the body is a single `return self.field`
- `return expr` statement in function bodies (replaces `c.ret`)
- `c.expr(...)` — literal C expression (replaces `c.raw`)
- `@pub(header|source|all)` attribute for controlling function visibility/emission
- `@static`, `@define`, and `@extern` modes for enum case emission
- `@template(inline)` — marks a template as a compile-time helper; emitted at call sites but never as a standalone `#define`
- `@use(inline)` in structs — copies a field-template's fields directly into the containing struct (flat embedding)
- `@header("file.h")` syntax (double-quoted; replaces the old `@header(<file.h>)` angle-bracket form)
- `param ... as name` — variadic template parameter; `name` becomes `__VA_ARGS__`
- `c.cast(type, expr)`, `c.call(fn, ...)`, `c.sel(cond, a, b)` built-in template operations
- `c.eq`, `c.ne`, `c.lt`, `c.le`, `c.gt`, `c.ge` comparison built-ins
- `c.math.add/sub/mul/div/mod/neg` arithmetic built-ins
- `c.math.bit.and/or/xor/not/shl/shr/set` bitwise built-ins
- `c.ptr.of(T)` — define-only pointer alias (generates `#define` instead of `typedef`)
- Callable template parameters (`param name as template`)
- Line numbers in the WebView DSL editor
- Selection highlighting in the WebView DSL editor
- Active-line highlighting in the WebView DSL editor
- Progress bar in the WebView editor during indexing/generation
- Diagnostic bubble in the WebView editor with error icon and inline error display
- Syntax formatting support in the WebView editor (`Ctrl+Enter` normalises before generate)
- Document formatting in the standard text editor (`Ctrl+Shift+I`)
- Context-aware completions in the standard text editor (triggered on `.`, `@`, `(`, `Ctrl+Space`)
- Diagnostics (parse errors) shown as red underlines in the standard text editor
- Per-file JSON index cache in `.cgen/cache/` — faster startup, hash-based invalidation
- MIT license and GitHub Actions release workflow

### Changed

- `->` is now the only valid syntax for function return types (`as` for return type is removed)
- `self` is implicit in struct methods and no longer needs to be declared as a parameter
- `@pub` replaces the old `@emit`/`@static`/`@fn`/`@inline` function specifiers
- `c.expr(...)` replaces `c.raw(...)` for literal C expressions
- `return` replaces `c.ret` for function return statements
- `@header("file.h")` replaces `@header(<file.h>)`
- Session state now saves and restores the last opened file path (`session.json`)
- Suggestions prioritise symbols from the current package; `c.*` builtins are ranked last
- Extension bundle reduced from ~4 MB to ~150 KB (sql.js dependency removed)

### Fixed

- `@scope(guard)` type path generation
- Function parameter type completions
- Enum type suggestion after the colon
- HTML escaping in the webview highlighter
- Regex patterns for keyword matching in grammar files
- Suggestion popup no longer opens on every keystroke — only on explicit trigger or `Ctrl+Space`
- Template context no longer leaks between different completion requests
- Completion list scrolling (active item stays visible; no overscroll)
- Double `makePublicPath` collapse in snapshot and suggestion resolution

### Removed

- `c.ret` — use `return` instead
- `c.raw` — use `c.expr(...)` instead
- `@header(<file.h>)` angle-bracket form — use `@header("file.h")` instead
- `as` for function return type — use `->` instead
- `extern c` namespace — replaced by `scope c`
- sql.js runtime dependency

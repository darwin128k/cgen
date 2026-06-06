# CGen VS Code Extension

VS Code extension for a compact C generation DSL.

## Usage

1. Run `npm install`.
2. Run `npm run compile`.
3. Install the package with `code --install-extension releases/cgen-vscode-<version>.vsix --force`, or press `F5` in VS Code for extension development.
4. Open a workspace that contains `cgen.json`.
5. Run `CGen: Open Editor` (`Ctrl+Alt+G`) or `CGen: Open DSL File` to start editing.

### Commands

| Command | Keybinding | Description |
|---------|------------|-------------|
| `CGen: Open Editor` | `Ctrl+Alt+G` | Opens the built-in DSL webview editor |
| `CGen: Open DSL File` | — | Creates `.cgen/main.cgen` if it does not exist, then opens it in the standard text editor |
| `CGen: Generate From Current DSL File` | `Ctrl+Enter` | Generates C files from the active `.cgen` file |
| `Format Document` | `Ctrl+Shift+I` | Formats the active `.cgen` file |

`CGen: Generate From Current DSL File` is available only when a `.cgen` file is active in the standard text editor. The CGen webview editor also supports `Ctrl+Enter` to generate.

### Standard editor support

`.cgen` files opened in the standard VS Code text editor have full language support:

- **Completions** — context-aware suggestions for keywords, types, templates, and symbols (triggered on `.`, `@`, `(`, or `Ctrl+Space`)
- **Diagnostics** — parse errors are shown as red underlines with hover messages; markers update automatically as the project index rebuilds
- **Formatting** — document formatting (`Ctrl+Shift+I`) normalises indentation and spacing

### DSL editor

The editor toolbar shows the current file name and a breadcrumb of the cursor's position in the DSL. The expand button in the toolbar toggles fullscreen mode.

The footer contains two menus:

| File action | Shortcut | Behaviour |
|-------------|----------|-----------|
| Open | — | Opens a `.cgen` file and binds the session to it |
| Save | `Ctrl+S` | Saves to the bound file, or to `.cgen/session.cgen` while the session is unbound |
| Save As | `Ctrl+Shift+S` | Saves to a selected `.cgen` file and binds the session to it |

| Run action | Shortcut | Behaviour |
|------------|----------|-----------|
| Generate | `Ctrl+Enter` | Generates headers and sources without running the build system |
| Build | — | Runs the configured build system without regenerating files |
| Generate & Build | — | Generates files, prepares generated CMake when applicable, then runs the configured build system |

Edits are automatically written to `.cgen/session.cgen`. Cursor position, scroll offset, and the bound file path are stored in `.cgen/session.json` and restored on next open.

### Keyboard shortcuts

| Shortcut | Context | Action |
|----------|---------|--------|
| `Ctrl+Alt+G` | Standard editor | Open the CGen webview editor |
| `Ctrl+Space` | Any CGen editor | Show completions |
| `Ctrl+Shift+I` | Standard `.cgen` editor | Format document |
| `Ctrl+Enter` | Any CGen editor | Generate files |
| `Ctrl+S` | CGen webview | Save current session or bound file |
| `Ctrl+Shift+S` | CGen webview | Save as and bind a file |

## Config

`cgen.json` must live in the workspace root:

```json
{
  "project": {
    "name": "myproject",
    "version": "0.1.0",
    "description": "My project description",
    "type": "executable"
  },
  "generate": {
    "include": "./include",
    "source": "./src",
    "clean": true
  },
  "build": {
    "system": "cmake",
    "action": "configure+build",
    "dir": "./build"
  }
}
```

### `project`

| Field         | Description              |
|---------------|--------------------------|
| `name`        | Project name             |
| `version`     | Version string           |
| `description` | Short project description |
| `type`        | `"auto"`, `"executable"`, `"static"`, `"shared"`, or `"interface"` (default: `"auto"`) |

The target type controls generated CMake:

- `"executable"` creates `add_executable`
- `"static"` and `"shared"` create the corresponding library type
- `"interface"` creates a header-only interface library
- `"auto"` creates a static library when `.c` files exist, otherwise an interface library

`"interface"` rejects generated `.c` files. The other explicit target types require at least one generated `.c` file.

Generated CMake targets:

| `project.type` | Generated target |
|----------------|------------------|
| `"executable"` | `add_executable(name ...)` with private include directories |
| `"static"` | `add_library(name STATIC ...)` with public include directories |
| `"shared"` | `add_library(name SHARED ...)` with public include directories |
| `"interface"` | `add_library(name INTERFACE)` with interface include directories |
| `"auto"` | Static when `.c` files exist, otherwise interface |

### `generate`

| Field     | Description                                                                 |
|-----------|-----------------------------------------------------------------------------|
| `include` | Directory where generated `.h` headers are written                          |
| `source`  | Directory where generated `.c` source files are written                     |
| `clean`   | When `true` (default), wipes `include` and `source` before each generation |

### `build` (optional)

Configures the external build system used by the **Build** and **Generate & Build** actions. Omit the section entirely if you only need code generation.

| Field    | Values                                       | Description                              |
|----------|----------------------------------------------|------------------------------------------|
| `system` | `"cmake"`, `"meson"`                         | Build system to use                      |
| `action` | `"configure"`, `"build"`, `"configure+build"` | Steps to execute                        |
| `dir`    | path string                                  | Build directory (default: `"./build"`)   |

CMake actions:
- `"configure"` — runs `cmake -B <dir> -S .` to generate build files
- `"build"` — runs `cmake --build <dir>` to compile
- `"configure+build"` — runs both in sequence

Meson actions:
- `"configure"` — runs `meson setup <dir>`
- `"build"` — runs `meson compile -C <dir>`
- `"configure+build"` — runs both in sequence

Build failures are written to the **CGen Build** output channel. **Build** requires existing build-system files; **Generate & Build** creates the generated CMake target first when CMake is configured.

If `.clang-format` is present in the workspace root, all generated files are automatically formatted with `clang-format` after generation.

## DSL

CGen uses indentation-based syntax. Four spaces per indent level, no tabs.

```cgen
package lh:
    module void:
        alias void as c.void

    @scope(guard)
    module char:
        alias char  as c.char
        alias schar as c.schar
        alias uchar as c.uchar

    module byte:
        alias byte as lh.uchar

    module bool:
        enum bool as lh.byte:
            case false
            case true

    package math:
        fn add:
            param a
            param b
            return c.math.add(a, b)
```

Inline nesting is supported for `package`, `module`, and `scope`:

```cgen
package lh: module char:
    alias char as c.char
```

### Multi-file projects

Before generating, CGen merges the current DSL with all `.cgen` files found in the workspace (excluding `node_modules`, `out`, `build`, `dist`, `releases`, and `.cgen` directories) and with the bundled built-in packages. Declarations from different files can freely reference each other.

## Sections

| Keyword   | Effect |
|-----------|--------|
| `package` | Creates a directory level and a path/guard/symbol prefix |
| `module`  | Creates a `.h` file (and optionally a `.c` file) |
| `scope`   | Virtual namespace — adds to guard and path, not to symbol names |

## Attributes

Attributes start with `@` and attach to the declaration that follows them.

### Inheritance

Attributes placed on a `package`, `module`, or `scope` are inherited by every declaration nested inside — directly or through further nesting. A child that specifies the same attribute name uses its own value; attributes with different names accumulate.

```cgen
@alias(inline)
scope c:
    alias char as c.type(char)     # inherits @alias(inline)
    alias schar as c.type(signed char) # inherits @alias(inline)

    @alias(define)                 # adds @alias(define); still inherits @alias(inline)
    alias void as c.type(void)

    @include("stddef.h")           # adds @include; still inherits @alias(inline)
    alias size as c.type(size_t)

    scope fixed:                   # nested scope also inherits @alias(inline)
        @include("stdint.h")
        alias i8 as c.type(int8_t)
```

### `@scope(guard)`

Keeps following names in header guards and file paths, but strips them from C symbol prefixes:

```cgen
@scope(guard)
module char:
    alias uchar as c.uchar
```

Guard: `LH_CHAR_H`. Type name: `lh_uchar_t` (not `lh_char_uchar_t`).

### `@include("header.h")`

Attaches to aliases and compile-time functions that depend on external C declarations. Specifies which C header to `#include` in any generated file that uses the declared name.

```cgen
scope c:
    @include("stddef.h")
    alias size as c.type(size_t)
```

## External C Symbols

External C types, macros, and functions are represented with ordinary `alias` and compile-time `fn` declarations, usually under a `scope c:` namespace. Use `c.type(...)` for C type spelling, `c.expr(...)` for literal C expressions, and `@include("...")` when generated files must include a C header.

```cgen
scope c:
    alias char as c.type(char)
    alias uint as c.type(unsigned int)

    @include("stddef.h")
    alias size as c.type(size_t)

    @include("stdlib.h")
    fn malloc:
        param size
        return c.expr("malloc(${size})")
```

Alias declarations map a DSL name to a C type spelling. Untyped compile-time functions map a DSL name to a C macro or expression — they can be called from function bodies, `let` initializers, returns, or other compile-time functions.

A bundled `packages/c.cgen` file declares the standard C types and common stdlib/string.h functions (see [Built-in C Types](#built-in-c-types)), so they are always available without any extra setup.

## Aliases

Aliases generate `typedef` declarations:

```cgen
alias byte as lh.uchar
```

```c
typedef lh_uchar_t lh_byte_t;
```

If the target type lives in another generated module, CGen adds the needed `#include` automatically.

**Special cases — `c.void` and define-only type helpers:** because `typedef void foo_t` is an incomplete type, and pointer aliases are intended to behave as pure C spelling aliases, these targets generate `#define` declarations instead. The bundled `c.ptr.of(...)` helper is declared in `packages/c.cgen` as a define-only compile-time function.

```cgen
alias void as c.void

scope void:
    alias ptr as c.ptr.of(lh.void)
```

```c
#define lh_void_t void
#define lh_void_ptr_t lh_void_t *
```

## Enums

Enums are typed constants over an existing type:

```cgen
enum bool as lh.byte:
    case false
    case true
```

By default, cases are emitted as `static const` values in the header:

```c
typedef lh_byte_t lh_bool_t;

static const lh_bool_t lh_bool_false = 0;
static const lh_bool_t lh_bool_true  = 1;
```

Cases can have explicit values:

```cgen
case false = 0
case true  = 1
```

### Enum modes

| Attribute | Header output                  | Source output |
|-----------|--------------------------------|---------------|
| `@static` | `static const T name = value;` | —             |
| `@define` | `#define name ((T)value)`      | —             |
| `@extern` | `extern const T name;`         | —             |
| `@public` | `extern const T name;`         | definition    |

Use `@public` when CGen owns and emits the public enum constants:

```cgen
@public
enum bool as lh.byte:
    case false
    case true
```

Header:

```c
extern const lh_bool_t lh_bool_false;
extern const lh_bool_t lh_bool_true;
```

Source:

```c
#include <lh/bool.h>

const lh_bool_t lh_bool_false = 0;
const lh_bool_t lh_bool_true  = 1;
```

Use `@extern` when external C code provides the definitions and CGen should emit declarations only:

```cgen
@extern
enum status as c.int:
    case ok
    case error
```

`@intrinsic` is unrelated to linkage. It marks aliases and compile-time functions as DSL-level primitives that are resolved and expanded but not emitted directly.

For an intrinsic alias, CGen substitutes the target C type instead of generating an intermediate typedef. For an intrinsic compile-time function, CGen expands its body at use sites instead of generating a standalone macro.

```cgen
@intrinsic
scope c:
    fn type:
        param name
        return c.expr(name)

    alias int as c.type(int)
```

The bundled `packages/c.cgen` uses `@intrinsic` on `scope c`, so its C types and helper functions do not create unnecessary `c_*` typedefs or macros.

### `@brief("text")` and `@doc("text")`

Attach documentation to the next declaration and emit it as a Doxygen comment in generated C headers. Use `@brief` for the Doxygen brief description and `@doc` for detailed documentation:

```cgen
@brief("Current application version.")
@doc("Stores the application's semantic version components.")
struct version:
    @doc("Major version component.")
    field major as c.uint

    @doc("Updates the major version.")
    @mutable
    fn set_major:
        @doc("New major version.")
        param value as c.uint
        self.major = value
```

`@brief` and `@doc` apply only to the declaration immediately following them and are not inherited by nested declarations. Commas, parentheses, escaped quotes, and `\n` line breaks are supported inside the quoted text.

For functions, CGen automatically adds missing Doxygen tags for every parameter and for non-`none` return values. Struct methods also receive a `@param self` tag. Missing tags are emitted without invented descriptions, while tags already written explicitly inside `@doc` are not duplicated. The `@doc("...")` completion selects `...` so its text can be entered immediately.

```cgen
@doc("Finds an item.")
fn find:
    @doc("Item identifier.")
    param id as c.uint
    @doc("Found item.")
    return c.null as c.ptr.of(c.void)
```

Documentation attached to a parameter becomes its Doxygen `@param` description. Documentation attached to a `return` statement becomes the function's `@return` description.

For parameterized structs, documentation attached to struct parameters becomes Doxygen `@tparam` descriptions on the generated macro.

## Functions

`fn` declarations generate C functions. They are placed inside a `struct` to act as methods, or at module level as standalone functions.

```cgen
struct point:
    field x as c.int
    @mutable
    field y as c.int

    fn get_x:
        return self.x

    @mutable
    fn set_x:
        param value as c.int
        self.x = value
```

Inside a struct, `self` is the implicit first parameter — a const pointer to the struct type by default. Put `@mutable` before a method to get a non-const `self` pointer.

Functions do not declare a return type on the `fn` line. CGen infers `none`/C `void` when there is no `return`. A struct method can return a known field directly with `return self.field`. Other returned expressions declare their type on the return statement with `return expr as T`.

Function parameters are const by default. Put `@mutable` before the parameter when the generated C parameter should not be const:

```cgen
fn get:
    param value as c.int
    return value as c.int

fn set:
    @mutable
    param value as c.int
    use c.expr((void)value)
```

Function parameters are declared as leading `param` lines before the executable body. Functions intentionally have one block-oriented form:

```cgen
fn consume:
    @doc("Value to consume.")
    param value as c.int
    use c.expr((void)value)
```

Function bodies support these statement forms:

| DSL                    | C output         |
|------------------------|------------------|
| `param name as T`      | Function parameter |
| `let name as T = expr` | `T name = expr;` |
| `self.field = expr`    | `self->field = expr;` |
| `return expr`          | `return expr;`   |
| `return expr as T`     | `return expr;` with return type `T` |
| `use c.expr(...)`      | literal C line   |

`expr` in a `let` or `return` statement may be a plain identifier, a field access (`self.field`), or a built-in compile-time call such as `c.cast(type, val)` — it is expanded before C output.

CGen performs best-effort semantic type checks when both sides have known DSL types. It validates assignments to local values and `self.field`, typed returns, inferred `return self.field`, and built-in expressions such as `c.cast`, `c.sel`, comparisons, and `c.math.*`. Raw C expressions and literals remain unchecked and are left to the C compiler.

Module bodies also support `let` declarations for generated globals:

```cgen
module limits:
    let max_items as c.int = 64

    @mutable
    let current_items as c.int = 0

    @private
    let scale as c.float = 1.0f
```

Public module `let`s emit an `extern` declaration in the header and one definition in the source file. They are `const` by default; put `@mutable` before the declaration for a mutable global. Put `@private` before the declaration to emit a `static` source-only definition.

`none` is the DSL spelling for no return value and generates C `void`.

CGen infers a struct method return type from a single `return self.field`. Standalone functions and non-field method returns use `return expr as T`.

Struct methods receive a const `self` pointer by default, so assigning to `self.field` is rejected. Put `@mutable` before the method to allow field assignment:

```cgen
struct version:
    @mutable
    field major as c.int

    @mutable
    fn set_major:
        param value as c.int
        self.major = value
```

This generates a `void` method with a mutable `version_t *self` parameter and a mutable field. The same body in a non-mutable `fn` is an error. Assigning to an ordinary const `field` is also an error, even from a mutable method.

Use `@mutable` on a parameterized field struct when every field it produces should be mutable.

### Visibility

| Attribute | Requirement | Header (.h) | Source (.c) |
|-----------|-------------|-------------|-------------|
| `@public` | any function | declaration when needed | definition when a body exists |
| `@private` | body required | — | `static` definition |
| `@inline` | body required | `static inline` definition | — |

When no visibility attribute is present, CGen uses the same automatic behaviour as `@public`: a function with a body gets a header declaration and source definition; a function without a body gets only a header declaration.

Visibility attributes do not accept arguments. `@public(header|source|all)` is not supported.

```cgen
@public
fn api:
    return 1 as c.int

@private
fn helper:
    return 2 as c.int

@inline
fn fast:
    return 3 as c.int
```

This generates a public `api` declaration and source definition, a source-only `static helper`, and a header-only `static inline fast`.

## Templates

Templates generate function-like macros (`#define`). The body must be a single
`use X(...)` expression. `X` can be a built-in operation such as `c.math.add` or
another generated compile-time function such as `lh.math.add`.

Functions with untyped (`any`) parameters or an inferred `any` return are compile-time callables. They generate macros instead of C functions. Parameters are declared as leading `param` lines; parentheses are reserved for calls.

```cgen
fn add:
    param a
    param b
    return c.math.add(a, b)

fn add_one:
    param a
    return lh.math.add(a, 1)
```

```c
#define lh_math_add(a, b) ((a) + (b))
#define lh_math_add_one(a) lh_math_add(a, 1)
```

### Face callables

When a callable has the same name as its containing module, it is addressed without repeating the name:

```cgen
module initializer:
    fn initializer:        # addressed as lh.initializer(...)
        param ... as values
        return c.initializer(values)
```

```c
#define lh_initializer(...) { __VA_ARGS__ }
```

### Parameterized structs

Structs without params generate `typedef struct` declarations:

```cgen
module version:
    struct version:
        field major as c.uint
        field minor as c.uint
```

```c
typedef struct lh_version_t {
  unsigned int major;
  unsigned int minor;
} lh_version_t;
```

When a struct declares params, it generates a macro that expands to a semicolon-separated list of typed fields:

```cgen
struct pair:
    param T
    field first as T
    field second as T
```

```c
#define lh_pair(T) T first; T second
```

### `@intrinsic`

Marks a compile-time function or alias as a DSL helper — it is expanded at every call site but **never emitted** as a `#define` in any header. Use this for helpers that only exist to build other declarations.

```cgen
@intrinsic
fn type:
    param name
    return c.expr(name)

alias byte as c.type(unsigned char)
```

```c
/* c_type is never emitted */
typedef unsigned char lh_byte_t;
```

### `@use(inline)` in structs

Normally a `use expr` inside a struct generates a dependency on a parameterized struct and expands to a macro call. With `@use(inline)` the referenced struct's fields are copied directly into the containing struct — flat embedding without a wrapper type.

```cgen
struct coords:
    param T
    field x as T
    field y as T

struct point:
    field z as c.float
    @use(inline)
    use lh.coords(c.float)
```

```c
typedef struct lh_point_t {
  float z;
  float x;
  float y;
} lh_point_t;
```

### Parameters

| Syntax                   | Meaning |
|--------------------------|---------|
| `param name`             | Regular parameter |
| `param name as any`      | Same — `any` is an explicit "untyped" annotation, DSL-level only |
| `${name}` inside `c.expr("...")` | Substitutes `name`; DSL type arguments render as C types (`c.int` becomes `int`) |
| `param ... as name`      | Variadic — `name` becomes `__VA_ARGS__` in output. The `...` form without `as` is a parse error. |
| `field name as type`     | Struct field |
| `@mutable` before `field name as type` | Mutable struct field |
| `@mutable` before parameterized `struct` | Field macro whose generated fields are mutable |

`c.expr` substitutions are type-aware: if a parameter receives a DSL type argument, `${name}` renders the C spelling of that type.

```cgen
fn sizeof:
    param T
    return c.expr("sizeof(${T})") as c.size
```

Calling `sizeof(c.int)` renders `sizeof(int)`. If the argument is already raw C type text, it is left unchanged.

### Built-in compile-time operations

Operands that are themselves macro calls are passed through without extra wrapping; plain identifiers and literals are wrapped in `()` to protect against operator precedence.

**`c` package** — C language primitives:

| DSL                         | C output              |
|-----------------------------|-----------------------|
| `use c.cast(type, expr)`    | `((type)expr)`        |
| `use c.call(fn, arg, ...)`  | `fn(arg, ...)`        |
| `use c.struct.of(type)`     | `struct type`         |
| `use c.initializer(...)`    | `{ ... }`             |
| `use c.sel(cond, a, b)`     | `(cond ? a : b)`      |
| `use c.eq(a, b)`            | `(a == b)`            |
| `use c.ne(a, b)`            | `(a != b)`            |
| `use c.lt(a, b)`            | `(a < b)`             |
| `use c.le(a, b)`            | `(a <= b)`            |
| `use c.gt(a, b)`            | `(a > b)`             |
| `use c.ge(a, b)`            | `(a >= b)`            |

**`c.math` package** — arithmetic:

| DSL                      | C output       |
|--------------------------|----------------|
| `use c.math.add(a, b)`   | `(a + b)`      |
| `use c.math.sub(a, b)`   | `(a - b)`      |
| `use c.math.mul(a, b)`   | `(a * b)`      |
| `use c.math.div(a, b)`   | `(a / b)`      |
| `use c.math.mod(a, b)`   | `(a % b)`      |
| `use c.math.neg(a)`      | `(-a)`         |

**`c.math.bit` package** — bitwise:

| DSL                        | C output       |
|----------------------------|----------------|
| `use c.math.bit.and(a, b)` | `(a & b)`      |
| `use c.math.bit.or(a, b)`  | `(a \| b)`     |
| `use c.math.bit.xor(a, b)` | `(a ^ b)`      |
| `use c.math.bit.not(a)`    | `(~a)`         |
| `use c.math.bit.shl(a, b)` | `(a << b)`     |
| `use c.math.bit.shr(a, b)` | `(a >> b)`     |
| `use c.math.bit.set(a, b)` | `(a \|= b)`    |

## Built-in C Types

The bundled `packages/c.cgen` file declares the following names in the `c` package. Types that require a standard header automatically add the corresponding `#include` to any generated file that uses them.

**Core types** (no include required):

```text
c.void
c.char    c.schar   c.uchar
c.short   c.sshort  c.ushort
c.int     c.sint    c.uint
c.long    c.slong   c.ulong
c.llong   c.sllong  c.ullong
c.float   c.double
c.bool
c.ptr.of(T)
```

**`<stddef.h>` types:**

```text
c.size  c.ptrdiff  c.wchar  c.nullptr
```

**`<stdint.h>` types:**

```text
c.i8   c.i16  c.i32  c.i64   c.imax  c.iptr
c.u8   c.u16  c.u32  c.u64   c.umax  c.uptr
```

**`<stdlib.h>` helpers:**

```text
c.malloc(size)  c.calloc(count, size)  c.free(ptr)
```

**`<string.h>` helpers:**

```text
c.memcpy(dest, src, size)  c.memset(dest, value, size)
```

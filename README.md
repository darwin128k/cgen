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

`CGen: Generate From Current DSL File` is available only when a `.cgen` file is active in the standard text editor. The CGen webview editor also supports `Ctrl+Enter` to generate.

### Standard editor support

`.cgen` files opened in the standard VS Code text editor have full language support:

- **Completions** — context-aware suggestions for keywords, types, templates, and symbols (triggered on `.`, `@`, `(`, or `Ctrl+Space`)
- **Diagnostics** — parse errors are shown as red underlines with hover messages; markers update automatically as the project index rebuilds
- **Formatting** — document formatting (`Shift+Alt+F`) normalises indentation and spacing

### DSL editor

The editor toolbar shows the current file name and a breadcrumb of the cursor's position in the DSL. The footer has load, save, and generate (▶) buttons. The expand button in the toolbar toggles fullscreen mode.

The editor saves its state (content, cursor position, scroll offset, and bound file path) to `.cgen/session.json` in the workspace and restores it on next open. Unsaved content is also written to `.cgen/session.cgen`.

## Config

`cgen.json` must live in the workspace root:

```json
{
  "project": {
    "name": "myproject",
    "version": "0.1.0",
    "description": "My project description"
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

### `generate`

| Field     | Description                                                                 |
|-----------|-----------------------------------------------------------------------------|
| `include` | Directory where generated `.h` headers are written                          |
| `source`  | Directory where generated `.c` source files are written                     |
| `clean`   | When `true` (default), wipes `include` and `source` before each generation |

### `build` (optional)

Configures an external build system to run after generation. Omit the section entirely if you only need code generation.

| Field    | Values                                       | Description                              |
|----------|----------------------------------------------|------------------------------------------|
| `system` | `"cmake"`, `"meson"`                         | Build system to use                      |
| `action` | `"configure"`, `"build"`, `"configure+build"` | Steps to execute                        |
| `dir`    | path string                                  | Build directory (default: `"./build"`)   |

CMake actions:
- `"configure"` — runs `cmake -B <dir> -S .` to generate build files
- `"build"` — runs `cmake --build <dir>` to compile
- `"configure+build"` — runs both in sequence

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
        template add:
            param a
            param b
            use c.math.add(a, b)
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

Attaches to aliases and templates that depend on external C declarations. Specifies which C header to `#include` in any generated file that uses the declared name.

```cgen
scope c:
    @include("stddef.h")
    alias size as c.type(size_t)
```

## External C Symbols

External C types, macros, and functions are represented with ordinary `alias` and `template` declarations, usually under a `scope c:` namespace. Use `c.type(...)` for C type spelling, `c.expr(...)` for literal C expressions, and `@include("...")` when generated files must include a C header.

```cgen
scope c:
    alias char as c.type(char)
    alias uint as c.type(unsigned int)

    @include("stddef.h")
    alias size as c.type(size_t)

    @include("stdlib.h")
    template malloc(size):
        use c.expr(malloc(${size}))
```

Alias declarations map a DSL name to a C type spelling. Template declarations map a DSL name to a C macro or function — they produce no output themselves but can be called from template `use` bodies or used as field types.

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

**Special cases — `c.void` and define-only type templates:** because `typedef void foo_t` is an incomplete type, and pointer aliases are intended to behave as pure C spelling aliases, these targets generate `#define` declarations instead. The bundled `c.ptr.of(...)` template is declared in `packages/c.cgen` as a define-only inline type template.

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

| Attribute       | Header output                        | Source output |
|-----------------|--------------------------------------|---------------|
| `@enum(static)` | `static const T name = value;`       | —             |
| `@enum(define)` | `#define name ((T)value)`            | —             |
| `@enum(extern)` | `extern const T name;`               | optional      |

Example with source emission:

```cgen
@pub(all)
@enum(extern)
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

## Functions

`fn` declarations generate C functions. They are placed inside a `struct` to act as methods, or at module level as standalone functions.

```cgen
struct point:
    field x as c.int
    mut field y as c.int

    fn get_x() -> any:
        return self.x

    mut fn set_x(value as c.int) -> c.void:
        use c.expr(self->x = value)
```

Inside a struct, `self` is the implicit first parameter — a const pointer to the struct type by default. Prefix a method with `mut` to get a non-const `self` pointer.

Function parameters are const by default. Put `mut` before the parameter name when the generated C parameter should not be const:

```cgen
fn get(value as c.int) -> c.int:
    return value

fn set(mut value as c.int) -> c.void:
    use c.expr((void)value)
```

Function bodies support these statement forms:

| DSL                    | C output         |
|------------------------|------------------|
| `let name -> T = expr` | `T name = expr;` |
| `return expr`          | `return expr;`   |
| `use c.expr(...)`      | literal C line   |

`expr` in a `let` or `return` statement may be a plain identifier, a field access (`self.field`), or a built-in template call such as `c.cast(type, val)` — it is expanded the same way as a template argument.

When a struct method has `-> any` as its return type and a single `return self.field` body, the type is inferred from the field's declared type.

### Visibility

| Attribute       | Header (.h) | Source (.c) |
|-----------------|-------------|-------------|
| `@pub(header)`  | declaration | —           |
| `@pub(source)`  | —           | definition  |
| `@pub(all)`     | declaration | definition  |

Default when `@pub` is absent: `@pub(all)` if the function has a body, `@pub(header)` if it does not.

## Templates

Templates generate function-like macros (`#define`). The body must be a single
`use X(...)` expression. `X` can be a built-in operation such as `c.math.add` or
another generated template such as `lh.math.add`.

```cgen
template add:
    param a
    param b
    use c.math.add(a, b)

template add_one:
    param a
    use lh.math.add(a, 1)
```

```c
#define lh_math_add(a, b) ((a) + (b))
#define lh_math_add_one(a) lh_math_add(a, 1)
```

### Face templates

When a template has the same name as its containing module, it is addressed without repeating the name:

```cgen
module initializer:
    template initializer:        # addressed as lh.initializer(...)
        param ... as values
        use c.initializer(values)
```

```c
#define lh_initializer(...) { __VA_ARGS__ }
```

### Struct templates

Templates with fields and no params generate `typedef struct` declarations:

```cgen
module version:
    template version:
        field major as c.uint
        field minor as c.uint
```

```c
typedef struct lh_version_t {
  unsigned int major;
  unsigned int minor;
} lh_version_t;
```

When a field template also declares params, it generates a macro that expands to a semicolon-separated list of typed fields:

```cgen
template pair:
    param T
    field first as T
    field second as T
```

```c
#define lh_pair(T) T first; T second
```

### `@template(inline)`

Marks a template as a compile-time helper — it is expanded at every call site but **never emitted** as a `#define` in any header. Use this for templates that only exist to build other declarations.

```cgen
@template(inline)
template type(name):
    use c.expr(name)

alias byte as c.type(unsigned char)
```

```c
/* c_type is never emitted */
typedef unsigned char lh_byte_t;
```

### `@use(inline)` in structs

Normally a `use expr` inside a struct generates a dependency on a field-template and expands to a macro call. With `@use(inline)` the referenced template's fields are copied directly into the containing struct — flat embedding without a wrapper type.

```cgen
template coords:
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
| `param name as template` | Callable parameter — `name(args)` in the `use` body expands as a raw C call |
| `param ... as name`      | Variadic — `name` becomes `__VA_ARGS__` in output. The `...` form without `as` is a parse error. |
| `field name as type`     | Struct field; cannot mix with `param` or `use` in the same template |
| `mut field name as type` | Mutable struct field |

### Built-in template operations

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

**`<stdlib.h>` templates:**

```text
c.malloc(size)  c.calloc(count, size)  c.free(ptr)
```

**`<string.h>` templates:**

```text
c.memcpy(dest, src, size)  c.memset(dest, value, size)
```

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
| `CGen: Open DSL File` | — | Opens `.cgen/main.cgen` in the standard text editor |
| `CGen: Generate From Current DSL File` | `Ctrl+Enter` | Generates C files from the active `.cgen` file |

`CGen: Generate From Current DSL File` is available only when a `.cgen` file is active in the standard text editor. The CGen webview editor also supports `Ctrl+Enter` to generate.

### DSL editor

The editor toolbar shows the current file name and a breadcrumb of the cursor's position in the DSL. The footer has load, save, and generate (▶) buttons. The expand button in the toolbar toggles fullscreen mode.

The editor saves its state (content, cursor position, scroll offset, and bound file path) to `.cgen/session.json` in the workspace and restores it on next open. Unsaved content is also written to `.cgen/session.cgen`.

## Config

`cgen.json` must live in the workspace root:

```json
{
  "build": {
    "include": "./include",
    "source": "./src"
  }
}
```

Headers are generated under `build.include`. Source files are generated under `build.source` only when a declaration asks for source emission.

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

Inline nesting is supported for `package`, `module`, `scope`, and `extern`:

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
| `extern`  | Declares external C types and macros available for use in DSL expressions |

## Attributes

Attributes start with `@`, attach to the declaration that follows them, and are
inherited by that declaration's nested declarations.

### `@scope(guard)`

Keeps following names in header guards and file paths, but strips them from C symbol prefixes:

```cgen
@scope(guard)
module char:
    alias uchar as c.uchar
```

Guard: `LH_CHAR_H`. Type name: `lh_uchar_t` (not `lh_char_uchar_t`).

### `@header(<header.h>)`

Attaches to declarations inside an `extern` section. Specifies which C header to `#include` in any generated file that uses the declared name.

```cgen
extern c:
    @header(<stddef.h>)
    alias size as "size_t"
```

## extern

The `extern` section brings external C types and macros into the CGen type system.

```cgen
extern c:
    alias char as "char"
    alias uint as "unsigned int"

    @header(<stddef.h>)
    alias size as "size_t"

    @header(<stdlib.h>)
    template malloc:
        param size as c.size
```

Alias declarations map a DSL name to a raw C type string. Template declarations map a DSL name to a C macro or function — they produce no output themselves but can be called from template `use` bodies or used as field types.

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

**Special cases — `c.void` and `c.ptr.of(...)`:** because `typedef void foo_t` is an incomplete type, and pointer aliases are intended to behave as pure C spelling aliases, these targets generate `#define` declarations instead:

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

### Emit targets (for `@enum(extern)` only)

| Attribute       | Effect |
|-----------------|--------|
| `@emit(header)` | Header declarations only (default) |
| `@emit(source)` | Source definitions only |
| `@emit(both)`   | Header declarations + source definitions |

Example with source emission:

```cgen
@enum(extern)
@emit(both)
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

When a field template also declares params, it generates a macro that expands to a semicolon-separated list of typed fields, suitable for use in compound literals or designated initializers:

```cgen
template pair:
    param T
    field first as T
    field second as T
```

```c
#define lh_pair(T) T first; T second
```

### Parameters

| Syntax              | Meaning |
|---------------------|---------|
| `param name`        | Regular parameter |
| `param ... as name` | Variadic parameter; `name` is the alias for `__VA_ARGS__`. The `...` form without an alias is a parse error. |
| `field name as type` | Struct field; plain field templates (no params) cannot be mixed with `param` or `use` bodies. |

### Built-in template operations

**`c` package** — C language primitives:

| DSL                        | C output           |
|----------------------------|--------------------|
| `use c.ret(expr)`          | `(expr)`           |
| `use c.initializer(values)`| `{ values }`       |
| `use c.sel(cond, a, b)`    | `((cond) ? (a) : (b))`; macro calls are not wrapped again |
| `use c.eq(a, b)`           | `((a) == (b))`; macro calls are not wrapped again |
| `use c.ne(a, b)`           | `((a) != (b))`; macro calls are not wrapped again |
| `use c.lt(a, b)`           | `((a) < (b))`; macro calls are not wrapped again |
| `use c.le(a, b)`           | `((a) <= (b))`; macro calls are not wrapped again |
| `use c.gt(a, b)`           | `((a) > (b))`; macro calls are not wrapped again |
| `use c.ge(a, b)`           | `((a) >= (b))`; macro calls are not wrapped again |

**`c.math` package** — arithmetic:

| DSL                       | C output        |
|---------------------------|-----------------|
| `use c.math.add(a, b)`    | `((a) + (b))`; macro calls are not wrapped again |
| `use c.math.sub(a, b)`    | `((a) - (b))`; macro calls are not wrapped again |
| `use c.math.mul(a, b)`    | `((a) * (b))`; macro calls are not wrapped again |
| `use c.math.div(a, b)`    | `((a) / (b))`; macro calls are not wrapped again |
| `use c.math.mod(a, b)`    | `((a) % (b))`; macro calls are not wrapped again |
| `use c.math.neg(a)`       | `(-(a))`        |

**`c.math.bit` package** — bitwise operations:

| DSL                          | C output        |
|------------------------------|-----------------|
| `use c.math.bit.and(a, b)`   | `((a) & (b))`; macro calls are not wrapped again |
| `use c.math.bit.or(a, b)`    | `((a) \| (b))`; macro calls are not wrapped again |
| `use c.math.bit.xor(a, b)`   | `((a) ^ (b))`; macro calls are not wrapped again |
| `use c.math.bit.not(a)`      | `(~(a))`; macro calls are not wrapped again |
| `use c.math.bit.shl(a, b)`   | `((a) << (b))`; macro calls are not wrapped again |
| `use c.math.bit.shr(a, b)`   | `((a) >> (b))`; macro calls are not wrapped again |
| `use c.math.bit.set(a, b)`   | `((a) \|= (b))`; macro calls are not wrapped again |

Variadic example:

```cgen
module initializer:
    template initializer:
        param ... as values
        use c.initializer(values)
```

```c
#define lh_initializer(...) { __VA_ARGS__ }
```

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

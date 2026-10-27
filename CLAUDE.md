# Dojix + Greenwick desktop (Windows / Linux)

Guidance for contributors and AI coding assistants. This file is public: keep private notes out.

## Hard rules
- **No secrets** in the repo (keys, tokens, certificates, signing material in any form).
- **No billing or licensing code.** Every feature is free. Online features use a key the user enters,
  stored in the OS credential vault, off by default; nothing may ever bill the maintainer.
- **No real data.** Fixtures and demo data are fictional and say so.
- **No code from outside contributors** (single copyright holder: Douglas Cleary).
- **Never name or compare against other journaling products** in UI, docs or marketing.
- **Parity:** numbers must match the Mac apps (reference values generated from the Swift code in CI),
  except documented, intentional fixes.
- **Never run against real data.** Every local run uses a scratch `--data-dir` and a scratch HOME.
- Rust is compiled and the desktop app is launched **only in CI** (windows-latest, ubuntu); locally,
  run only the pure TypeScript packages' tests. Don't launch GUI apps on a maintainer's machine.

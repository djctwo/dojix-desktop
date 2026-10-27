# Decisions

These are the project decisions the Windows and Linux edition is built on. They were
accepted on 2026-10-26 and checked again on 2026-10-27 against the current Mac apps.
The full design is in [SPEC.md](SPEC.md). The behaviour differences from the Mac apps are
listed in [PARITY.md](PARITY.md).

| # | Decision | How it applies today |
|---|---|---|
| 1 | **The repository is public from the first commit.** | Windows and Linux CI is free for public repositories, and the code is GPL-3.0 either way. Every rule about secrets, real data and personal details applies from day one. |
| 2 | **Releases start unsigned. They are published on winget, and the project applies to a free code-signing programme for open-source projects after v1.0.** Paid signing is considered only if users report problems with the unsigned builds. | Release CI has one optional `sign-windows` step. It runs only when signing secrets exist. Unsigned builds work fully, and the README explains the SmartScreen prompt. |
| 3 | **Greenwick's P&L includes commissions and fees (net), like Dojix.** | The Mac Greenwick has done this since its 1.0 open-source release, so this is now **parity** rather than a difference. The desktop app matches it. |
| 4 | **A new, free, open-source MT5 exporter script ships with the desktop app.** The analysis script that writes the existing 32-column CSV format stays outside the project. | The importer still reads that 32-column format, and the new exporter writes a compatible superset (§5.3 of the spec). |
| 5 | **The journal is encrypted at rest.** | It matches the Mac apps' current design. The journal is held in memory and sealed with AES-256-GCM after every commit, so no plaintext database file ever exists. This replaces the earlier plan for page-level database encryption (SPEC §6). |
| 6 | **Bugs found in the Mac apps are fixed in the desktop app, not copied, and every difference is logged.** | Many have since been fixed in the Mac apps themselves. Those are now parity items. The remaining differences are in PARITY.md, each with its reason and a test. |
| 7 | **The products keep their names on Windows and Linux: Dojix (forex) and Greenwick (stocks).** | One codebase builds two installers, one for each brand. |
| 8 | **The five headline-affecting parity fixes (D-16, D-18, D-22, D-23, D-27) are approved** (2026-10-27). | A Dashboard number can differ from the Mac app for the affected files only; each fix is listed in PARITY.md with a test. |
| 9 | **No Windows → Mac backup export in v1** (2026-10-27). | Mac → Windows import is supported; the reverse can be added on request. |

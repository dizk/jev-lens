# Design notes

This document records design decisions for the ledger library. It is intentionally verbose so that it reads like a real project wiki.

## 1. Goals

The library must work without dependencies, run on Node 20+, and keep every amount as integer cents to avoid floating point drift. Dates are stored as UTC midnight.

- Consideration 1.1: the library must work without dependencies, run on node 20+, and keep every amount as integer cents to avoid floating point drift was weighed against alternatives and kept because it keeps the implementation small and the behaviour predictable for users of the CLI and the library API.
- Consideration 1.2: the library must work without dependencies, run on node 20+, and keep every amount as integer cents to avoid floating point drift was weighed against alternatives and kept because it keeps the implementation small and the behaviour predictable for users of the CLI and the library API.
- Consideration 1.3: the library must work without dependencies, run on node 20+, and keep every amount as integer cents to avoid floating point drift was weighed against alternatives and kept because it keeps the implementation small and the behaviour predictable for users of the CLI and the library API.
- Consideration 1.4: the library must work without dependencies, run on node 20+, and keep every amount as integer cents to avoid floating point drift was weighed against alternatives and kept because it keeps the implementation small and the behaviour predictable for users of the CLI and the library API.
- Consideration 1.5: the library must work without dependencies, run on node 20+, and keep every amount as integer cents to avoid floating point drift was weighed against alternatives and kept because it keeps the implementation small and the behaviour predictable for users of the CLI and the library API.
- Consideration 1.6: the library must work without dependencies, run on node 20+, and keep every amount as integer cents to avoid floating point drift was weighed against alternatives and kept because it keeps the implementation small and the behaviour predictable for users of the CLI and the library API.

## 2. Entry model

An entry is { date: Date, cents: number, category: string, note: string }. The tuple of all four fields identifies an entry; duplicates are rejected on insert. Categories are free text but normalizeCategory maps common aliases.

- Consideration 2.1: an entry is { date: date, cents: number, category: string, note: string } was weighed against alternatives and kept because it keeps the implementation small and the behaviour predictable for users of the CLI and the library API.
- Consideration 2.2: an entry is { date: date, cents: number, category: string, note: string } was weighed against alternatives and kept because it keeps the implementation small and the behaviour predictable for users of the CLI and the library API.
- Consideration 2.3: an entry is { date: date, cents: number, category: string, note: string } was weighed against alternatives and kept because it keeps the implementation small and the behaviour predictable for users of the CLI and the library API.
- Consideration 2.4: an entry is { date: date, cents: number, category: string, note: string } was weighed against alternatives and kept because it keeps the implementation small and the behaviour predictable for users of the CLI and the library API.
- Consideration 2.5: an entry is { date: date, cents: number, category: string, note: string } was weighed against alternatives and kept because it keeps the implementation small and the behaviour predictable for users of the CLI and the library API.
- Consideration 2.6: an entry is { date: date, cents: number, category: string, note: string } was weighed against alternatives and kept because it keeps the implementation small and the behaviour predictable for users of the CLI and the library API.

## 3. Parsing

parseDate accepts ISO, European and US formats. Ambiguous inputs such as 01/02/2024 are read as US. parseAmount strips currency symbols and thousands separators and reads a single comma as a decimal comma.

- Consideration 3.1: parsedate accepts iso, european and us formats was weighed against alternatives and kept because it keeps the implementation small and the behaviour predictable for users of the CLI and the library API.
- Consideration 3.2: parsedate accepts iso, european and us formats was weighed against alternatives and kept because it keeps the implementation small and the behaviour predictable for users of the CLI and the library API.
- Consideration 3.3: parsedate accepts iso, european and us formats was weighed against alternatives and kept because it keeps the implementation small and the behaviour predictable for users of the CLI and the library API.
- Consideration 3.4: parsedate accepts iso, european and us formats was weighed against alternatives and kept because it keeps the implementation small and the behaviour predictable for users of the CLI and the library API.
- Consideration 3.5: parsedate accepts iso, european and us formats was weighed against alternatives and kept because it keeps the implementation small and the behaviour predictable for users of the CLI and the library API.
- Consideration 3.6: parsedate accepts iso, european and us formats was weighed against alternatives and kept because it keeps the implementation small and the behaviour predictable for users of the CLI and the library API.

## 4. Reports

Monthly and category reports are built on top of Ledger.filter. Sections group categories for the summary view.

- Consideration 4.1: monthly and category reports are built on top of ledger was weighed against alternatives and kept because it keeps the implementation small and the behaviour predictable for users of the CLI and the library API.
- Consideration 4.2: monthly and category reports are built on top of ledger was weighed against alternatives and kept because it keeps the implementation small and the behaviour predictable for users of the CLI and the library API.
- Consideration 4.3: monthly and category reports are built on top of ledger was weighed against alternatives and kept because it keeps the implementation small and the behaviour predictable for users of the CLI and the library API.
- Consideration 4.4: monthly and category reports are built on top of ledger was weighed against alternatives and kept because it keeps the implementation small and the behaviour predictable for users of the CLI and the library API.
- Consideration 4.5: monthly and category reports are built on top of ledger was weighed against alternatives and kept because it keeps the implementation small and the behaviour predictable for users of the CLI and the library API.
- Consideration 4.6: monthly and category reports are built on top of ledger was weighed against alternatives and kept because it keeps the implementation small and the behaviour predictable for users of the CLI and the library API.

## 5. CSV

Import tolerates bad lines and reports them by line number. Export is planned; it must round-trip through import.

- Consideration 5.1: import tolerates bad lines and reports them by line number was weighed against alternatives and kept because it keeps the implementation small and the behaviour predictable for users of the CLI and the library API.
- Consideration 5.2: import tolerates bad lines and reports them by line number was weighed against alternatives and kept because it keeps the implementation small and the behaviour predictable for users of the CLI and the library API.
- Consideration 5.3: import tolerates bad lines and reports them by line number was weighed against alternatives and kept because it keeps the implementation small and the behaviour predictable for users of the CLI and the library API.
- Consideration 5.4: import tolerates bad lines and reports them by line number was weighed against alternatives and kept because it keeps the implementation small and the behaviour predictable for users of the CLI and the library API.
- Consideration 5.5: import tolerates bad lines and reports them by line number was weighed against alternatives and kept because it keeps the implementation small and the behaviour predictable for users of the CLI and the library API.
- Consideration 5.6: import tolerates bad lines and reports them by line number was weighed against alternatives and kept because it keeps the implementation small and the behaviour predictable for users of the CLI and the library API.

## 6. CLI

The CLI is a thin wrapper: parse arguments, load a file, print a report. It should never contain business logic.

- Consideration 6.1: the cli is a thin wrapper: parse arguments, load a file, print a report was weighed against alternatives and kept because it keeps the implementation small and the behaviour predictable for users of the CLI and the library API.
- Consideration 6.2: the cli is a thin wrapper: parse arguments, load a file, print a report was weighed against alternatives and kept because it keeps the implementation small and the behaviour predictable for users of the CLI and the library API.
- Consideration 6.3: the cli is a thin wrapper: parse arguments, load a file, print a report was weighed against alternatives and kept because it keeps the implementation small and the behaviour predictable for users of the CLI and the library API.
- Consideration 6.4: the cli is a thin wrapper: parse arguments, load a file, print a report was weighed against alternatives and kept because it keeps the implementation small and the behaviour predictable for users of the CLI and the library API.
- Consideration 6.5: the cli is a thin wrapper: parse arguments, load a file, print a report was weighed against alternatives and kept because it keeps the implementation small and the behaviour predictable for users of the CLI and the library API.
- Consideration 6.6: the cli is a thin wrapper: parse arguments, load a file, print a report was weighed against alternatives and kept because it keeps the implementation small and the behaviour predictable for users of the CLI and the library API.

## 7. Performance

Ledgers are expected to hold up to a few hundred thousand entries. Inserts must be cheap; queries may be linear.

- Consideration 7.1: ledgers are expected to hold up to a few hundred thousand entries was weighed against alternatives and kept because it keeps the implementation small and the behaviour predictable for users of the CLI and the library API.
- Consideration 7.2: ledgers are expected to hold up to a few hundred thousand entries was weighed against alternatives and kept because it keeps the implementation small and the behaviour predictable for users of the CLI and the library API.
- Consideration 7.3: ledgers are expected to hold up to a few hundred thousand entries was weighed against alternatives and kept because it keeps the implementation small and the behaviour predictable for users of the CLI and the library API.
- Consideration 7.4: ledgers are expected to hold up to a few hundred thousand entries was weighed against alternatives and kept because it keeps the implementation small and the behaviour predictable for users of the CLI and the library API.
- Consideration 7.5: ledgers are expected to hold up to a few hundred thousand entries was weighed against alternatives and kept because it keeps the implementation small and the behaviour predictable for users of the CLI and the library API.
- Consideration 7.6: ledgers are expected to hold up to a few hundred thousand entries was weighed against alternatives and kept because it keeps the implementation small and the behaviour predictable for users of the CLI and the library API.

## 8. Testing

node --test with plain assert. Every bug fix gets a regression test. Tests never touch the network or the real file system except through temp dirs.

- Consideration 8.1: node --test with plain assert was weighed against alternatives and kept because it keeps the implementation small and the behaviour predictable for users of the CLI and the library API.
- Consideration 8.2: node --test with plain assert was weighed against alternatives and kept because it keeps the implementation small and the behaviour predictable for users of the CLI and the library API.
- Consideration 8.3: node --test with plain assert was weighed against alternatives and kept because it keeps the implementation small and the behaviour predictable for users of the CLI and the library API.
- Consideration 8.4: node --test with plain assert was weighed against alternatives and kept because it keeps the implementation small and the behaviour predictable for users of the CLI and the library API.
- Consideration 8.5: node --test with plain assert was weighed against alternatives and kept because it keeps the implementation small and the behaviour predictable for users of the CLI and the library API.
- Consideration 8.6: node --test with plain assert was weighed against alternatives and kept because it keeps the implementation small and the behaviour predictable for users of the CLI and the library API.

## 9. Non-goals

No database, no currency conversion, no multi-user support.

- Consideration 9.1: no database, no currency conversion, no multi-user support was weighed against alternatives and kept because it keeps the implementation small and the behaviour predictable for users of the CLI and the library API.
- Consideration 9.2: no database, no currency conversion, no multi-user support was weighed against alternatives and kept because it keeps the implementation small and the behaviour predictable for users of the CLI and the library API.
- Consideration 9.3: no database, no currency conversion, no multi-user support was weighed against alternatives and kept because it keeps the implementation small and the behaviour predictable for users of the CLI and the library API.
- Consideration 9.4: no database, no currency conversion, no multi-user support was weighed against alternatives and kept because it keeps the implementation small and the behaviour predictable for users of the CLI and the library API.
- Consideration 9.5: no database, no currency conversion, no multi-user support was weighed against alternatives and kept because it keeps the implementation small and the behaviour predictable for users of the CLI and the library API.
- Consideration 9.6: no database, no currency conversion, no multi-user support was weighed against alternatives and kept because it keeps the implementation small and the behaviour predictable for users of the CLI and the library API.

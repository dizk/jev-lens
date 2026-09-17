# ledger

A tiny personal expense ledger library with a CLI. No dependencies.

- `src/parse.js` parses dates and amounts from user input
- `src/ledger.js` holds entries in memory and answers queries
- `src/format.js` formats money and tables for the terminal
- `src/report.js` builds monthly reports
- `src/csv.js` CSV import
- `src/categories.js` category aliases and report sections
- `src/i18n.js` message catalogue
- `data/sample.csv` example data, `docs/DESIGN.md` design notes
- `src/cli.js` command line entry point

Run tests with `npm test` (runs `node --test`, which picks up `tests/*.test.js`).

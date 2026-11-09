# Full database import (Settings → Security)

Use this tool to import a full database export, not an individual viewer export. It accepts `.json`, `.csv` and `.sql` files up to 256 MiB and 500,000 normalized rows. The selected file is validated before any write; parse/validation errors include a source line or row number.

## Accepted formats

- **JSON**: either `{ "kv": [{"k":"key", "v":"value", "exp":null}], "kv_list": [{"k":"list-key", "i":0, "v":"item"}] }`, or `{ "rows": [...] }`, `{ "data": [...] }`, or a top-level array. Key aliases: `k`, `key`, `name`; value aliases: `v`, `value`, `data`; list index aliases: `i`, `index`, `list_index`; table/type fields can be `kind`, `type` or `table`.
- **CSV**: first row must contain key (`key` or `k`) and value (`value` or `v`) columns. Optional `i`/`index` columns, and `kind`/`table`/`type` values can mark list rows. Quoted commas, escaped double-quotes and multiline quoted fields are supported.
- **SQL**: only `INSERT` statements targeting `kv`, `kv_list` or `kv_store` are interpreted. Known DDL/transaction metadata is ignored, and arbitrary SQL is never executed. PostgreSQL/SQLite dumps using literal `INSERT INTO ... (columns) VALUES (...)` rows work; unsupported functions, expressions and statements are rejected with a line-numbered error.

A legacy `fish:rares:<login>` or `fish:treasury:<login>` JSON array stored in a key/value row is translated to the normalized list table. Key/value `exp`/`expires_at`/`expires` values can be null, epoch timestamps or parseable date strings; epoch seconds are converted to milliseconds.

## Import flow and duplicate choices

1. Open **Settings → Security → Import an old database**.
2. Click **Choose file…**, select the full export and choose a duplicate policy.
3. Click **Validate and import**. Nothing is changed if format/row validation fails.
4. The progress bar reports percent, processed and succeeded/skipped/failed rows, estimated remaining time, and line-specific errors. **Cancel import** requests cancellation at the next row/batch boundary.
5. All database writes run in one SQLite transaction. Cancelling or encountering an import error rolls the transaction back. If a database existed beforehand, a pre-import snapshot is written in `data/backups/` before writes begin.

Duplicate policy:

- **Ask if duplicates are found**: if incoming keys collide with the current database or duplicate keys are found inside the file, the app prompts before continuing.
- **Skip existing keys**: preserves current database keys; duplicate source key values use the first occurrence.
- **Overwrite existing keys**: replaces current values; duplicate source key values use the last occurrence. List keys are replaced as a unit so stale trailing entries are removed.
- **Replace the whole database**: deletes every current key and list row, then imports the file. A confirmation is shown first, and a backup is written to `data/backups/` before anything is deleted. The delete and the import run in one transaction, so a failed import restores the previous data.

List rows are never merged or skipped. If a file gives the same list index more than once (or a flat row has no index), every row is kept in file order after the highest index already used for that list.

The SQL importer parses only allow-listed insert records; it never opens the selected SQL file as an executable SQL script. Still, back up important data before import and only import files from a trusted source.

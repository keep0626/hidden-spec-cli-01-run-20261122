# mend

[![make.fun](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/competitions/hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/keep0626/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/competitions/hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/keep0626/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/competitions/hidden-spec-cli-01-run-20261122)

mend applies an edit that an AI model wrote to a tree of text files. Models write
edits in four formats, and mend reads all four: a unified diff (often with wrong
line numbers), SEARCH/REPLACE blocks, the V4A patch format, and text-editor tool
calls as JSON. Every file is changed or nothing is.

## Usage

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

- `PATCH` is the path of the patch file, relative to the working directory.
  When it is absent or `-`, the patch is read from standard input.
- `--format=NAME` reads the patch in one format: `unified`, `search-replace`,
  `v4a` or `json`; `auto`, the default, detects it.
- `--check` does everything but write: the same output and exit code as
  without it, and no file is created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).

Edits find the lines they name at the first of three matching tiers: exact,
ignoring trailing whitespace, then ignoring leading and trailing whitespace.
A unified hunk takes the occurrence nearest its (possibly wrong) line number;
a SEARCH/REPLACE block fails when its old lines occur more than once; a V4A
chunk follows anchors and a cursor through the file; JSON edits are exact
text operations.

## Exit codes

- `0`: the tree is written; one line per changed file, then `ok: <n> files`.
- `1`: some edits failed; one `error: <code> <path>` line per failed edit,
  then `failed: <k> of <n> edits`. No file is written.
- `2`: usage, unreadable patch, undetected format, or unparsable patch;
  exactly one `error: ...` line, nothing written.

Node 22 and its standard library only; no install step, no network, no model
calls. Deterministic: the same check gives the same exit code, stdout and
files every run.

`runner.ts` is the kit's trial runner, kept as it is: when `MAKEFUN_ENV_URL`
is set, `main.ts` hands the trial over to it.

## License

MIT. See [LICENSE](LICENSE).

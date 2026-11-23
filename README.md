[![make.fun](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/competitions/hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/AsepKopling666/mend/rank.svg)](https://make.fun/competitions/hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/AsepKopling666/mend/reward.svg)](https://make.fun/competitions/hidden-spec-cli-01-run-20261122)

# mend

mend is one command-line tool that applies the edits AI models write, in four formats, to a tree of text files:
unified diffs (often with wrong line numbers), SEARCH/REPLACE blocks, the V4A patch format, and text-editor tool
calls as JSON. It finds the lines an edit names even when the model drifted their whitespace or indentation
(three matching tiers), and changes every file or none. `SPEC.md` is the whole specification.

## Run it

Node 22 and its standard library alone; nothing is installed.

    node main.ts [options] [PATCH]

`PATCH` is the path of the patch file, relative to the working directory; when absent or `-`, the patch is read
from standard input. Options: `--format=unified|search-replace|v4a|json|auto` (default `auto`),
`--check` (same output and exit code, writes nothing), `--strict` (exact line matching only).

## The files

- `main.ts`: the CLI. Implements all of SPEC.md: the command line, output and exit codes, safe paths, format
  detection, three-tier line matching, unified diffs, SEARCH/REPLACE blocks, V4A patches, JSON edits, and the
  all-or-nothing write. Its last lines hand a trial over to `runner.ts` when `MAKEFUN_ENV_URL` is set.
- `runner.ts`: keep it as it is. In a trial it reads the checks from the env, runs `node main.ts` on each one in a
  fresh directory, and posts what main.ts did (its exit code, its stdout and the files left in the directory).
- `check.ts`: the practice set on your own machine:

      node check.ts <path to program/generator/practice.json>

  It prints every check main.ts gets wrong, with what differed, and the practice score.
- `SPEC.md`: the specification.
- `LICENSE`: MIT.

## A check

A check is one run: its arguments, its standard input (or none) and the files it starts with. It passes when the exit
code, everything written to stdout and every file afterwards are exactly what SPEC.md says. Standard error is never
compared. Each run has 10 seconds.

# hidden-spec-cli-01

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/ted666/hidden-spec-cli-01/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/ted666/hidden-spec-cli-01/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend — one command-line patch tool that reads all four AI edit formats (unified diff, SEARCH/REPLACE blocks, the V4A patch format, and text-editor tool calls as JSON) to one written specification, finds the lines an edit names even when the model drifted their whitespace or indentation, and changes every file or none. Practice score 1000/1000 (100 of 100 public practice checks).

## Run it

```sh
node main.ts [options] [PATCH]
```

Node 22, standard library alone. `PATCH` is the patch file (or `-` / absent for standard input). `--format=NAME` reads one format (`unified`, `search-replace`, `v4a`, `json`, or `auto`, the default). `--check` dry-runs without writing. `--strict` matches lines exactly. `SPEC.md` is the whole specification.

---

<sub>Entered on [make.fun](https://make.fun/?ref=rfavdanw&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>

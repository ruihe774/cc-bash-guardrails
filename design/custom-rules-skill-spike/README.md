# Spike: can Haiku and Sonnet write custom rules from loose requests?

A harness that gives `claude -p` a short, imprecise request ("no more sudo please", "add a guardrail so you can't touch prod from this repo") with only the plugin loaded, then grades the rule file it writes.

Each run is isolated: a fresh `HOME` (so the user rule file lands in `runs/<case>-<model>/home/.claude/`), a fresh git project, a minimal environment (`env -i`), and a copy of the plugin holding only the manifest, `hooks/` and `skills/`. No CLAUDE.md, README, design notes or tests are visible, so the model works from the skill alone. `-p` has no way to ask the user, so each case also tests the skill's defaults for deny vs ask and user vs project file.

```sh
./all.sh                 # every case, Haiku and Sonnet, in parallel
./all.sh prod docker     # some cases
python3 grade.py         # run each written rule file through check.ts on must-catch / must-allow commands
FULL=1 python3 report.py prod-haiku   # the transcript: tool calls, results, final answer, rule files
```

`grade.py` holds the expected verdict (deny, ask, allow) for each case's sample commands, merged across the user and project files.

## Results (claude-haiku-5-5, claude-sonnet-5-5; 2026-10)

Round 1, first draft of the skill:

- forcepush, rmask, prod, curlsh, existing: both models correct on every sample. prod went to the project file and keyed on the README's `shop-prod` context, the prod DB host and `./deploy.sh prod`, while leaving staging alone. existing set `"enabled": false` on the old rule and added the new one beside it.
- sudo: Sonnet pointed to the built-in `sudo` toggle instead of writing a duplicate. Haiku, on both sudo and deps, treated the request as an instruction for itself ("Understood, I won't...") and only offered a rule, without loading the skill.
- docker: both read "mount my home directory" as home itself, not subdirectories, and said so (a judgment call, not a bug).
- Haiku wrote its first rule to `/root/.claude/` by guessing what `~` is, though the shell had just printed a different `$HOME`.

Fixes to the skill: the description now covers requests phrased to Claude ("no more sudo please", "ask me before you install dependencies", "...without me knowing") and says a rule is what makes them last; the skill says to resolve the rule file's absolute path in the shell. Also added after merging v0.2 changes: the new built-in toggles, `redirects`/`stdout`/`pipelines`, `optValues`, and a pitfall found while testing (a `}}` in a template expression ends it early).

Round 2, 12 cases (`sudo` and `deps` twice), then `ssh` three times after one more description tweak:

- The skill was loaded in every run, and every run that wrote a rule ran `check.ts` on it, 2 to 4 times.
- All rules loaded with no problems. Every graded sample matched for forcepush, rmask, prod, deps (4/4 runs), curlsh, existing and etc. The etc rule catches `> /etc/x`, `tee /etc/x`, `cp a /etc/b` and `sed -i ... /etc/x` while allowing reads.
- sudo (4/4 runs): pointed to the built-in toggle, wrote nothing.
- docker: Haiku also blocked home subdirectories this time; Sonnet again only blocked home itself, and explained it.
- ssh (6/6 after the tweak): an ask rule for private keys; Haiku also asks about `id_rsa.pub`, which is on the cautious side.
- No run wrote outside its sandbox.

---
name: terse
description: Use Terse for JavaScript/TypeScript features, fixes, deletions, refactors and code simplification in an initialized project. Retrieve existing code, consolidate duplicate implementations, record decisions and verify behavior. Documentation-only questions do not need this workflow.
---

# Terse

Use the project's existing implementation when it fits the requested behavior.
Reasonable new responsibilities can remain separate. Terse provides evidence;
reading candidates and deciding whether responsibilities overlap is your job.

## Project entry point

From the Git root, run `node .agents/skills/terse/scripts/run.mjs` followed by Terse
arguments. This local launcher uses `.terse/agent.json` to locate the installed CLI,
works from nested directories, and does not install packages or call a model.
If its binding is missing or stale, rerun `node <installed-terse>/dist/cli.js init
--cwd <project>` using the project's installation, then retry. Do not fetch an
unrequested package or bypass the workflow silently.

Before the first task, inspect `terse.config.json`. If verification is empty, choose
the project's actual tests/type checks from its existing scripts and documentation
and configure command/args/timeoutMs before begin. Commands run without a shell;
use executable commands appropriate to this environment. Do not insert a no-op
check or weaken existing verification. If the correct command cannot be established,
report the setup gap. Initialization alone does not verify the project.

## Retrieve and decide before editing

1. Start the user's actual task, using business terms plus likely symbol names:
   `node .agents/skills/terse/scripts/run.mjs begin --task "<requirement>" --query "<terms>" --json`.
   Save the returned run ID. This already includes context; don't repeat the same
   search. Read candidates in the actual source and inspect their consumers,
   tests, unresolved imports and limitations. Expand with `context --run <id>
   --query "<other terms>" --json` when needed. Empty results do not prove absence.
2. Record the actual choice with `decide --run <id> --strategy <reuse|modify|refactor|new>
   --rationale "<specific reason>" --candidate <candidateId> --json`. Use IDs returned
   for this baseline. Repeat candidate flags when appropriate. `new` may omit
   candidates when none apply; explain rejected candidates rather than selecting
   the first result or forcing unrelated code together.
3. Declare files and indexed declarations you will delete, rename or move in
   `decision.remove` before editing. `--remove <path>` declares a whole file;
   extracting a method while keeping its file requires a symbol entry such as
   `{"path":"source/index.ts","symbol":"PQueue.#onEvent"}` using the exact baseline
   name. A removed parent declaration covers its nested helpers; in-place changes
   need no invented removal. For per-candidate reasons or symbol removals, use
   the returned decisionGuide.inputArgvTemplate and its full
   input schema. `--input` replaces the whole decision; do not mix it with strategy,
   rationale, disposition, reason or remove flags. Optional candidate IDs only
   assert entries already present in that input. Fix reported issues fields when
   a decision is rejected; do not hand-wave a successful save.

## Implement and check

Implement the requested behavior with your normal editing tools. Preserve existing
contracts and remove superseded paths and callers within scope. New behavior should
extend its existing owner when appropriate, rather than adding a parallel implementation.
Deliver the actual source change; zero findings alone is not evidence of simplification.

## Reduce existing duplicate implementations

For a simplification request, inspect existing duplication too: ordinary check
suppresses baseline clones. Identify the implementation to retain and the body or
path to remove, preserving necessary public contracts and independent responsibilities.
For two same-file ordinary functions with identical parameters and body source,
preview `simplify --run <id> --candidate <duplicate-id> --into <retained-id> --json`
through the project launcher. Review the exact edit, record both candidates using
decide with modify/refactor, then repeat simplify with `--apply --summary`. This writes the
delegation and executes the full check; do not repeat the unchanged suite immediately.
Only applied:true plus simplificationVerified:true confirms this scoped reduction.
Unsupported cases require an agent-authored refactor with the normal full check;
do not weaken the guards or force similar responsibilities together.

Report what implementation disappeared, what now owns the behavior, actual source
changes and validation. For new requirements, distinguish necessary additions from
duplicate bodies or obsolete branches removed. Do not call unchanged code or a
successful check alone a simplification, or claim a general agent benefit from a demo.

## Verify changes

After agent-authored edits, run the returned verificationGuide.argvTemplate through the same launcher. It is
equivalent to `check --run <id> --summary --json` and executes all baseline-configured
verification. Avoid manually repeating that whole suite before/after check by
default; targeted debugging remains useful.

Read the entire JSON object after process exit and handle the actual exit code:

- 0 / pass: the configured checks passed for this snapshot.
- 1 / fail: inspect findings and verification failureOutput, correct the problem,
  then rerun the full check after changes.
- 2 / needs-review: review duplication evidence, missing verification and uncertain
  references. POSSIBLE_DUPLICATION is not proof of semantic equivalence; preserve
  independent authorization/responsibilities when justified and disclose remaining
  findings. Repeating unchanged tests does not remove a review finding.
- 3 / incomplete: inspect diagnostics/errors for setup, analysis or execution errors;
  do not treat an incomplete scan or missing output as a clean result.

If findings include `REMOVAL_DECLARATION_MISSING`, inspect `undeclaredRemovals`
and amend the complete decision with `decide --run <same-id> --input <file>`.
Preserve its considered entries and existing removals, add the missing targets,
then rerun full check. Do not start a new baseline or change strategy to hide the
omission. Filling the declaration does not dismiss stale callers or uncertain
references; handle the remaining M4 findings separately.

Read reportPath if the failure excerpt is insufficient. Keep the same task baseline
and removal declarations while fixing findings; do not re-begin to hide new issues,
skip verification, raise thresholds or delete tests to obtain pass. Recheck after
relevant source, input, dependency or environment changes.

In the delivery, explain what was reused/modified, why new code was needed, what
was cleaned up, the final check status and any remaining findings or coverage gaps.

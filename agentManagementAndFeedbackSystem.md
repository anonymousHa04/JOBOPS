# JobOps — Agent Management, Knowledge & Feedback System

**Document type:** Master requirements and implementation plan  
**Status:** Requirements defined; implementation pending  
**Primary objective:** Improve coding-agent correctness, reduce repeated mistakes, and make failures diagnosable and recoverable.

## 1. Executive summary

JobOps currently uses local coding agents, including Aider for new code and mini-swe-agent for debugging existing code. The objective is to make these agents more reliable by providing the right context, enforcing independent validation, and learning from verified outcomes.

The system will introduce a shared Agent Knowledge Layer and a manager-controlled execution lifecycle.

The manager will:

1. Retrieve relevant requirements, source code, tests, and verified fixes.
2. Supply task-specific context to the selected coding agent.
3. Run the agent within defined execution and modification boundaries.
4. Independently validate the resulting changes.
5. Diagnose failures and determine whether to retry, escalate, or stop.
6. Record verified outcomes to improve future runs.

**Core principle:** The agent proposes a solution. The validation system provides evidence. The manager decides what happens next.

### Will this solve all our problems?

No single architecture can guarantee that. This design targets the major failure modes identified so far, but its effectiveness must be demonstrated through implementation and testing.

| Problem | Intended solution |
|---|---|
| Agent lacks relevant project context | Hybrid knowledge retrieval |
| Agent ignores or misinterprets requirements | Explicit constraints, source evidence, and independent checks |
| Agent changes code without understanding dependencies | Structural retrieval and regression tests |
| Agent repeats unsuccessful repairs | Failure signatures, bounded retries, and escalation |
| Broken validation reports a false success | Reliable exit-status and patch validation |
| Agents forget lessons between tasks | Verified, reusable failure memory |
| Local model cannot solve a difficult task | Controlled escalation policy |
| More context makes prompts slower or noisier | Context budgets and retrieval evaluation |

These are design targets, not claims that the problems have already been fixed.

---

## 2. System architecture

```text
                    USER TASK
                        |
                        v
                MANAGER / ORCHESTRATOR
                        |
              +---------+----------+
              |                    |
              v                    v
       Task requirements      Execution policy
              |                    |
              +---------+----------+
                        |
                        v
               AGENT KNOWLEDGE LAYER
                        |
          +-------------+-------------+
          |             |             |
          v             v             v
      Exact search  Semantic search  Code relationships
          |             |             |
          +-------------+-------------+
                        |
                        v
              TASK CONTEXT PACKAGE
                        |
                        v
                CODING AGENT
              /               \
           Aider          mini-swe-agent
              \               /
               +-------------+
                        |
                        v
                CANDIDATE PATCH
                        |
                        v
              INDEPENDENT VALIDATION
                        |
                 +------+------+
                 |             |
                PASS          FAIL
                 |             |
                 v             v
            Patch review   Failure diagnosis
                 |             |
                 v             v
             ACCEPTED      Repair / escalate
                 |             |
                 +------+------+
                        |
                        v
                 OUTCOME RECORD
                        |
                        v
              VERIFIED KNOWLEDGE
                        |
                        +----> Future tasks
```

The manager owns the lifecycle. The coding agents do not independently decide that their own work is correct or that their proposed fixes should become trusted knowledge.

---

## 3. Phase 0 — Establish reliable validation

**Priority: Highest. Complete this before trusting retrieval or feedback results.**

A feedback loop is only as good as the signals it receives. If validation incorrectly reports success, the system can learn the wrong lessons.

### Requirements

**R0.1 — Preserve process exit codes**

Every important command must have its actual exit status captured.

This includes:
- Coding-agent execution
- TypeScript compilation
- Test suites
- Linting and static analysis
- Patch application
- Any other mandatory validation command

A successful-looking log message must not override a failed exit status.

**R0.2 — Make validation results explicit**

Each task must have a machine-readable result distinguishing:

- Passed
- Failed
- Not run
- Timed out
- Unable to determine

Missing output must not be treated as success.

**R0.3 — Validate the final patch**

Validation must apply to the exact changes that will be accepted.

If the workflow validates a patch in a temporary Git worktree and then applies it to another worktree, it must verify successful patch application and confirm that the final result matches the validated changes. Revalidate when the final state differs.

**R0.4 — Enforce change boundaries**

Verify that:
- Only permitted files were changed.
- The patch applies cleanly.
- No unexpected generated files, temporary files, or unrelated changes are included.
- Relevant existing behavior is protected by tests where possible.

**R0.5 — Make failures observable**

Do not swallow process errors or timeouts. Preserve logs and the final failure reason.

### Findings requiring attention

From the previously reviewed scripts:

- `check.sh` parses TypeScript and test output instead of relying directly on the commands' exit statuses.
- `run-mini.sh` uses `wait $! || true`, which can hide the agent process's failure status.
- The workflow validates in a temporary worktree before applying a patch to the main worktree; the final state needs appropriate verification.
- The configuration sets `step_limit: 0`, meaning there is no configured step limit in that setting.

These are concrete issues or configuration observations from the reviewed files. Other parts of the workflow may already provide additional safeguards; verify them before changing anything.

### Acceptance criteria

Phase 0 is complete when a deliberately failing command, invalid patch, timeout, and failed test are all reliably reported as failures and cannot be mistaken for a successful task.

---

## 4. Phase 1 — Build the Agent Knowledge Layer

### 4.1 Objective

Build a local retrieval service that answers:

> Given a task, which project requirements, source files, dependencies, tests, and verified historical fixes are most useful to the agent?

The service must retrieve relevant information without loading the entire repository into the model's context.

### 4.2 Retrieval methods

#### A. Exact search

Retrieve:
- Filenames and paths
- Function and class names
- Symbols and identifiers
- Error messages
- Exact phrases and requirements

Use existing repository search capabilities where practical.

#### B. Semantic search

Retrieve conceptually relevant material even when the task uses different wording from the documentation.

Candidate implementation:
- Local embedding model
- Qdrant for vector storage, if useful
- Local indexing and retrieval

No paid external inference API is required.

#### C. Structural retrieval

Retrieve relevant relationships such as:
- Imports and dependencies
- Callers and consumers of changed symbols
- Interfaces and their implementations
- Tests associated with changed code

Start with lightweight source analysis and existing language tooling. A complete code graph is not required for the initial prototype.

**Important:** Semantic similarity does not establish correctness. Exact source retrieval and executable tests remain essential.

### 4.3 Knowledge sources

Initially index:

- Project requirements and `LOCAL-AGENTS.md`
- Architecture and design documentation
- Relevant source code
- Tests and validation rules
- Verified failure and fix records
- Reusable agent procedures

Exclude secrets, credentials, dependency directories, build artifacts, and irrelevant generated files.

The source files remain the source of truth. The index must be rebuildable.

### 4.4 Common retrieval interface

The manager must be able to request context through a stable interface, conceptually:

```text
retrieve_context(task, repository, limits)
```

Each result should include:

- Relevant content or source location
- Source path and line range, where applicable
- Content type
- Retrieval method
- Relevance or ranking information
- Verification status, where relevant

The exact implementation language and schema can be selected after inspecting the existing scripts.

### 4.5 Context selection

The manager should prioritize:

1. Explicit task requirements and hard constraints
2. Exact files and symbols referenced by the task
3. Relevant implementations and dependencies
4. Tests and validation commands
5. Verified historical fixes
6. Broader architecture documentation

Apply context budgets, deduplication, and source relevance filtering.

Hard constraints must not be overridden by a higher semantic similarity score.

### 4.6 Evidence classification

Every knowledge item must distinguish between:

- **Source fact:** supported by the current repository
- **Requirement:** explicitly specified project behavior
- **Verified fix:** demonstrated to resolve a known failure
- **Hypothesis:** a possible explanation that remains unverified
- **Outdated or rejected knowledge:** no longer applicable or disproven

Do not present suspected root causes as established facts.

### 4.7 Acceptance criteria

Phase 1 is complete when:
- Exact and semantic retrieval work on representative tasks.
- Results identify their sources.
- Context limits and exclusions are respected.
- Relevant code and tests can be retrieved.
- Unverified hypotheses are distinguishable from confirmed information.
- The prototype demonstrates useful retrieval on real repository tasks.

Installing a vector database or generating embeddings alone does not count as completion.

---

## 5. Phase 2 — Integrate retrieval with the manager and coding agents

### 5.1 Objective

Use the same knowledge service for Aider and mini-swe-agent while preserving their existing execution workflows.

The manager should retrieve context before launching an agent and supply a task-specific context package.

### 5.2 Task context package

Each package should contain:

1. Original task and expected outcome
2. Relevant project requirements
3. Hard constraints and prohibited changes
4. Relevant source files and symbol locations
5. Related tests and validation commands
6. Applicable verified fixes
7. Known uncertainties or missing information

Do not indiscriminately dump all retrieved content into the prompt. Keep the package concise and relevant.

The original task must remain identifiable. The manager must not silently invent requirements to fill gaps.

### 5.3 Shared instructions, agent-specific execution

Both agents use the shared knowledge layer, but the manager may package information differently for each tool.

- **Aider:** provide relevant instructions and file paths, allowing it to inspect the actual files before editing.
- **mini-swe-agent:** provide a compact task description, critical constraints, source evidence, and expected validation.

Retrieved documents and source code are evidence. They must not be allowed to override established project constraints.

### 5.4 Integration requirements

Before implementation, inspect the current versions of:

- `run-mini.sh`
- `autofix.sh`
- `check.sh`
- `mini_textbased.yaml`
- Aider launch configuration
- Existing worktree, patch, and task-log handling

The integration must:
- Use a common retrieval interface.
- Preserve worktree isolation and allowed-file restrictions.
- Log the context supplied to each run.
- Distinguish empty retrieval from retrieval failure.
- Provide a safe fallback where appropriate.
- Avoid weakening validation.
- Keep the previous workflow available for comparison.

The precise integration point must be determined from the actual launch flow, not assumed.

### 5.5 Failure handling

If retrieval fails:
- Record the failure.
- Apply the configured fallback policy.
- Do not claim retrieval succeeded.
- Do not automatically block tasks that can safely proceed with available source search and project instructions.

### 5.6 Acceptance criteria

Phase 2 is complete when both agents receive task-specific context through the manager, retrieval failures are handled explicitly, original constraints are preserved, and the integration does not bypass independent validation or existing execution safeguards.

---

## 6. Phase 3 — Feedback, learning, and failure recovery

### 6.1 Objective

Create a closed feedback loop so every task can contribute to improved future outcomes without turning unverified guesses into permanent knowledge.

### 6.2 Required lifecycle

1. Retrieve relevant context.
2. Run the selected coding agent.
3. Capture the candidate patch and execution evidence.
4. Independently validate the result.
5. Review regression risk and change boundaries.
6. Accept, repair, escalate, or stop.
7. Record the outcome.
8. Promote useful findings into reusable knowledge only when justified.

### 6.3 Record every outcome

For each task, capture:

- Task identifier and original requirements
- Agent and model used
- Retrieved sources
- Files changed and patch
- Process exit status
- Validation results
- Failure logs and relevant diagnostics
- Repair attempts and outcomes
- Final status: accepted, failed, escalated, or inconclusive

Keep raw evidence separate from the manager's interpretation.

### 6.4 Diagnose failures

Use these initial failure categories:

1. Missing or irrelevant context
2. Instruction violation
3. Incorrect implementation
4. Regression
5. Unreliable or incomplete validation
6. Environment or dependency failure
7. Ambiguous or conflicting requirements
8. Model limitation
9. Unknown cause

The manager must be allowed to report an unknown cause rather than force a diagnosis.

### 6.5 Repair using new evidence

Before retrying:

1. Capture the failure signature and diagnostics.
2. Retrieve relevant code, tests, requirements, and previous fixes.
3. Compare the current failure with previous attempts.
4. Decide what will change in the next attempt.
5. Provide the agent with the new evidence and a specific repair objective.
6. Validate the resulting patch again.

A retry must not simply repeat the original prompt unchanged.

### 6.6 Store verified fixes

Each reusable fix should include:

- Failure signature
- Conditions under which it occurred
- Relevant files and components
- Root cause, if established
- Resolution
- Validation evidence
- Known limitations
- Verification status

Use statuses such as:

- `observed`
- `hypothesis`
- `verified`
- `regression-tested`
- `rejected`

A fix that passes one test must not automatically be considered universally correct.

### 6.7 Prevent repeated failures

The manager must:
- Compare failure signatures across attempts.
- Detect identical or substantially unchanged repair attempts.
- Apply configurable retry limits.
- Require a meaningful change in strategy when repeating a failed approach.
- Escalate to a stronger model or human review when appropriate.
- Preserve evidence from failed attempts.
- Never report success merely because retries have ended.

Escalation must be implemented as an actual manager-controlled handoff, not merely a printed `ESCALATE` message.

### 6.8 Learn from successful tasks

After acceptance:
- Store useful verified fixes.
- Preserve regression tests that catch the failure.
- Improve retrieval for related tasks.
- Record which context was actually useful.
- Avoid indexing entire transcripts as trusted knowledge by default.

After a hypothesis is disproven, mark it accordingly so it does not continue to rank as a confirmed solution.

### 6.9 Acceptance criteria

Phase 3 is complete when every task has a recorded outcome, failed tasks produce actionable evidence, retries use a changed strategy, repeated failures trigger stopping or escalation, and verified fixes can improve future retrieval.

---

## 7. Phase 4 — Measurement and optimization

The system must demonstrate improvement against the existing workflow.

### Required metrics

- First-attempt acceptance rate
- Final acceptance rate
- Regression rate
- Average repair attempts per task
- Repeated-failure rate
- Escalation rate
- Validation reliability
- Retrieval relevance
- Frequency with which retrieved fixes help
- Context size and task runtime

Define acceptance criteria for each metric before running the comparison.

Use representative tasks from the actual repository. Compare the existing workflow with the knowledge-enabled workflow under reasonably comparable conditions.

Do not attribute an improvement to retrieval if other major workflow changes occurred at the same time.

### Acceptance criteria

The optimization phase is complete when the team can identify which changes improve validated correctness, which add unnecessary context or latency, and which failure modes remain unresolved.

---

## 8. Implementation order

Do not build everything simultaneously.

| Order | Deliverable | Reason |
|---|---|---|
| 0 | Reliable command, patch, and validation handling | Prevent false success signals |
| 1 | Minimal exact-search retrieval | Establish useful source context quickly |
| 2 | Semantic retrieval and context ranking | Find relevant knowledge beyond exact matches |
| 3 | Integrate retrieval with one agent | Test the interface with limited risk |
| 4 | Integrate the second agent | Reuse the shared architecture |
| 5 | Feedback records and failure classification | Make failures actionable |
| 6 | Bounded retries and real escalation | Prevent unproductive loops |
| 7 | Verified knowledge updates | Reduce recurrence of known mistakes |
| 8 | Structural retrieval and optimization | Improve dependency awareness based on evidence |

Qdrant, a local embedding model, and SQLite FTS5 are candidate components—not prerequisites that must all be introduced before the first prototype.

---

## 9. Existing workflow findings and unresolved suspects

The following must be treated as part of the implementation investigation.

### Confirmed from the previously reviewed files

- `check.sh` parses command output rather than directly trusting command exit statuses.
- `run-mini.sh` suppresses a process failure status through `wait $! || true`.
- The workflow validates changes in a temporary worktree before applying a patch to the main worktree.
- The mini-swe-agent configuration has `step_limit: 0`.
- The reviewed workflow's escalation behavior was a printed message rather than a confirmed stronger-model handoff.

### Suspects requiring further verification

- **API map location:** `run-mini.sh` may generate the API map in the worktree but read a stale map from the main repository. Confirm this by inspecting `api-map.sh`.
- **Task log visibility:** `check.sh` may not see the task log or flags expected when run inside the worktree. Verify log paths and copy/link behavior.
- **Agent context limits:** the Aider setup reportedly specifies an 8192-token context setting, while the mini configuration does not explicitly specify the same setting. Determine the effective context size for each model and launcher.
- **Repair-loop behavior:** verify how `autofix.sh` detects completion, recognizes repeated failures, and handles timeout or process termination.
- **Dependency context:** determine whether agents consistently receive the actual consumers, interfaces, and tests needed to make safe changes.

Do not encode these suspects as facts or modify the workflow based on assumptions alone.

---

## 10. Non-goals

The initial implementation will not attempt to:

- Build a complete autonomous software-engineering platform.
- Construct a full code knowledge graph before proving its value.
- Replace source code and tests with vector search.
- Treat model-generated explanations as verified fixes.
- Store every agent transcript as trusted knowledge.
- Introduce infrastructure without a measurable benefit.
- Guarantee that every task can be solved by a local model.
- Automatically accept code merely because an agent claims success.

---

## 11. Manager operating contract

For every coding task, the manager must be able to answer:

1. What did the user ask for?
2. What constraints apply?
3. What context was retrieved, and where did it come from?
4. Which agent ran, and did its process finish successfully?
5. What changed?
6. Did independent validation pass?
7. If it failed, what evidence explains the failure?
8. What changed between repair attempts?
9. Why was the result accepted, escalated, or stopped?
10. What verified knowledge, if any, should be retained?

If the manager cannot answer these questions from recorded evidence, the workflow is not yet sufficiently observable.

## 12. Final definition of success

JobOps should become a system where:

- Agents receive relevant knowledge before they act.
- Changes are independently validated.
- Failures are diagnosed using evidence.
- Repeated unsuccessful attempts are stopped.
- Difficult tasks are escalated deliberately.
- Verified solutions improve future runs.
- Improvements are measured rather than assumed.

**Immediate next action:** Implement Phase 0 first. Then build the smallest useful retrieval prototype and integrate it with one agent before extending the system.

This document defines the intended behavior. It does not mean the changes have already been implemented or that every identified problem is resolved.

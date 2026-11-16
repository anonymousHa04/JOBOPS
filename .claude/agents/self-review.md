# Self-review (do this before you edit again, and before you give up)

Your last attempt failed the independent check. Before changing code, review what you did.
Answer each question to yourself, then fix only what the answers point to.

1. Spec, item by item. Read the task spec again. For each numbered item: is it done, missing,
   or done differently than written? Fix missing and different items; do not add extras.
2. Callers. For every function whose parameters, name, or return type you changed: search the
   repo for its callers (grep the function name). Does every call still match? New parameters
   go AFTER existing ones and are optional, unless the spec says otherwise.
3. Your diff. Look at your previous change below. Did you:
   - delete or empty code the spec did not mention? Put it back.
   - define a function or variable twice? Keep one.
   - edit or create a file the task does not list (check the exact path; never a similar name
     such as api/src/reports.ts for api/src/extension/reports.ts)? Undo it.
   - add a placeholder, guessed name, or invented value (selector, field, path)? Use the real
     one from the spec or the code, or report it as a blocker.
4. The errors. Match each error from the check to the line that causes it. Fix the cause, not
   the symptom (do not cast, ignore, or delete a test to make an error go away).
5. Same mistake again? If the errors are the same as last time, your previous approach does
   not work. Change the approach, or stop and report it as a blocker.
6. Can you finish? If the fix needs something the spec does not give (a missing field, an
   unclear rule, a file you may not edit), do not guess: report STATUS: blocked with that
   blocker.

End your reply with the report from report-format.md, and before it one line:
SELF-REVIEW: <items missing or wrong, or "spec complete">; <cause of the failure in one sentence>

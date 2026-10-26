# How to end your reply

After your last edit, end your reply with exactly these two lines (no code fences):

STATUS: done
BLOCKERS: none

Use "STATUS: blocked" when you could not finish. Then write each blocker on its
own line after "BLOCKERS:", starting with "- ", for example:

STATUS: blocked
BLOCKERS:
- api/src/profile/schema.ts has no field for X, and the spec needs it
- the spec does not say what loadBank returns when the file is missing

This report is recorded as your claim. The independent check decides whether
the task passed, so report honestly what you could not do or were unsure about.

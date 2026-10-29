# JobOps Chrome Extension

## What it does
From a job JobOps has scored, it puts a prompt with the job description, your gaps, and the
job's tailored resume into Claude or ChatGPT, sends it, waits for the answer, and saves the
report to profile/reports/ through the local JobOps API.

Each job keeps one conversation per chat site. The first report opens a new chat and saves its
id as soon as the chat exists; later reports for the same job go back to that chat and send a
follow-up instead: "Attempt N: Based on your input, I made changes to my resume. Please have a
look.", with the bullet ids that changed and the updated resume.

## Install
1. Go to chrome://extensions.
2. Turn on Developer mode.
3. Click on "Load unpacked".
4. Choose the extension/ folder.

## Use
1. Start the API by running `npm start` in the project folder.
2. Sign in to claude.ai or chatgpt.com in Chrome.
3. Open the popup, pick a job and a chat, click "Get report", and keep the chat tab open until
   the status says "saved".

## Optional
Pin the extension id so only this extension can use the API:
1. Copy the extension id from chrome://extensions.
2. Set `JOBOPS_EXTENSION_ID=<id>` in the project's .env file.
3. Restart the API.

## Tools (from the project folder, with Chrome started with a debug port)
Start that Chrome with:
`open -na "Google Chrome" --args --user-data-dir=$HOME/.jobops-chrome --remote-debugging-port=9222`
- `node extension/tools/get-report.mjs <job-id> [claude|chatgpt]`: runs a report end to end and
  prints the status steps and counts per report field (never report text).
- `node extension/tools/dump-selectors.mjs`: checks the chat-page selectors chat.js uses and
  writes selectors.md. Run it when a chat site changes its page.
- `sh extension/tools/check-ext.sh [file]`: the checks coders' changes must pass.

## Troubleshooting
If a chat site changes its page and the run fails, run dump-selectors.mjs, or select the report
text in the chat and click "Save selected text".

## Privacy
What is sent: job description, parsed requirements, gaps, and the job's tailored resume
(summary, skills, role titles, companies, dates, selected bullets, education).
What is not sent: contact details (name, email, phone, links).
The chat is asked to use what it knows about you and to save nothing new to its memory; facts it
adds from memory are listed separately for you to confirm.
Reports stay in profile/reports/ (git-ignored).

importScripts("chats.js"); // waitForComplete, savedChat, rememberChat, rememberChatWhenCreated

const API = "http://127.0.0.1:3000";
const CHAT = {
  claude: { match: "https://claude.ai/*", newUrl: "https://claude.ai/new" },
  chatgpt: { match: "https://chatgpt.com/*", newUrl: "https://chatgpt.com/" }
};

async function setStatus(fields) {
  const status = { ...fields, at: new Date().toISOString() };
  await chrome.storage.local.set({ status });
}

async function saveReport(jobId, target, text, round) {
  try {
    const response = await fetch(`${API}/x/reports/${encodeURIComponent(jobId)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: target, text, round })
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      const error = body.detail || body.error || `status ${response.status}`;
      await setStatus({ jobId, target, step: "failed", error });
      return false;
    }
    const { path } = await response.json();
    await setStatus({ jobId, target, step: "saved", path });
    return true;
  } catch (err) {
    await setStatus({ jobId, target, step: "failed", error: String(err) });
    return false;
  }
}

chrome.runtime.onMessage.addListener(async (message, sender, sendResponse) => {
  if (message.type === "run") {
    const { jobId, target } = message;
    if (target !== "claude" && target !== "chatgpt") {
      sendResponse({ ok: false, error: "Invalid target" });
      return;
    }
    if (typeof jobId !== "string" || jobId.trim() === "") {
      sendResponse({ ok: false, error: "Invalid job ID" });
      return;
    }
    sendResponse({ ok: true });

    await setStatus({ jobId, target, step: "prompt" });

    try {
      // A job that already has a chat gets the follow-up prompt ("Attempt N: based on your input ...").
      const followup = (await savedChat(jobId, target)) ? `?followup=1&source=${target}` : "";
      const response = await fetch(`${API}/x/prompt/${encodeURIComponent(jobId)}${followup}`);
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        const error = body.detail || body.error || `status ${response.status}`;
        await setStatus({ jobId, target, step: "failed", error });
        return;
      }
      const { prompt } = await response.json();

      // Back to this job's conversation when there is one, else a new chat.
      const url = (await savedChat(jobId, target)) ?? CHAT[target].newUrl;
      let [tab] = await chrome.tabs.query({ url: CHAT[target].match });
      if (!tab) {
        tab = await chrome.tabs.create({ url });
      } else {
        tab = await chrome.tabs.update(tab.id, { url, active: true });
      }

      await waitForComplete(tab.id);

      await new Promise(resolve => setTimeout(resolve, 2000));

      await setStatus({ jobId, target, step: "chat" });

      try {
        await chrome.tabs.sendMessage(tab.id, { type: "ask", prompt, jobId, target });
      } catch (err) {
        await new Promise(resolve => setTimeout(resolve, 2000));
        try {
          await chrome.tabs.sendMessage(tab.id, { type: "ask", prompt, jobId, target });
        } catch (err) {
          await setStatus({ jobId, target, step: "failed", error: "open the chat page and try again" });
          return;
        }
      }

      await setStatus({ jobId, target, step: "waiting" });
      await rememberChatWhenCreated(tab.id, jobId, target);

      // Initialize the loop state
      await chrome.storage.local.set({ loop: { jobId, target, round: 1 } });
    } catch (err) {
      await setStatus({ jobId, target, step: "failed", error: String(err) });
    }
  } else if (message.type === "answer") {
    const { jobId, target, text, error } = message;
    if (target !== "claude" && target !== "chatgpt") {
      sendResponse({ ok: false, error: "Invalid target" });
      return;
    }
    if (typeof jobId !== "string" || jobId.trim() === "") {
      sendResponse({ ok: false, error: "Invalid job ID" });
      return;
    }
    sendResponse({ ok: true });

    if (error) {
      await setStatus({ jobId, target, step: "failed", error });
    } else {
      await setStatus({ jobId, target, step: "saving" });
      if (sender.tab) await rememberChat(jobId, target, (await chrome.tabs.get(sender.tab.id)).url);

      const { round } = await chrome.storage.local.get("loop");
      const ok = await saveReport(jobId, target, text, round);

      if (ok && round < 5) {
        await setStatus({ jobId, target, step: "fixing", round });
        try {
          const fixResponse = await fetch(`${API}/x/fix/${encodeURIComponent(jobId)}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ round, source: target })
          });
          if (!fixResponse.ok) {
            const body = await fixResponse.json().catch(() => ({}));
            const error = body.detail || body.error || `status ${fixResponse.status}`;
            await setStatus({ jobId, target, step: "failed", error });
            return;
          }
          const { fix, prompt, loop } = await fixResponse.json();
          if (prompt) {
            round += 1;
            await chrome.storage.local.set({ loop: { jobId, target, round } });
            await setStatus({ jobId, target, step: "asking", round });
            await chrome.tabs.sendMessage(sender.tab.id, { type: "ask", prompt, jobId, target });
          } else {
            // The loop summary (engine and chat score per round) comes only from a server that has it.
            const status = { jobId, target, step: "done", round, needs_facts: fix ? fix.needs_facts.length : 0 };
            if (loop) {
              status.scores = loop.rounds.map(r => r.engine_score);
              status.chat = loop.rounds.map(r => r.chat_score);
              status.best = loop.best ? loop.best.engine_score : null;
              status.stopped = loop.stopped;
              const last = loop.rounds[loop.rounds.length - 1];
              if (last) status.needs_facts = last.needs_facts.length;
            }
            await setStatus(status);
          }
        } catch (err) {
          await setStatus({ jobId, target, step: "failed", error: String(err) });
        }
      } else {
        await setStatus({ jobId, target, step: "done", round, needs_facts: 0 });
      }
    }
  } else if (message.type === "saveSelection") {
    const { jobId, target } = message;
    if (target !== "claude" && target !== "chatgpt") {
      sendResponse({ ok: false, error: "Invalid target" });
      return;
    }
    if (typeof jobId !== "string" || jobId.trim() === "") {
      sendResponse({ ok: false, error: "Invalid job ID" });
      return;
    }
    sendResponse({ ok: true });

    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab) {
        await setStatus({ jobId, target, step: "failed", error: "No active tab" });
        return;
      }

      const reply = await chrome.tabs.sendMessage(tab.id, { type: "selection" });
      if (reply.ok && reply.text) {
        await setStatus({ jobId, target, step: "saving" });

        await saveReport(jobId, target, reply.text);
      } else {
        await setStatus({ jobId, target, step: "failed", error: "select the report text in the chat first" });
      }
    } catch (err) {
      await setStatus({ jobId, target, step: "failed", error: String(err) });
    }
  }
});

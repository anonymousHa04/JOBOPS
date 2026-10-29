const API = "http://127.0.0.1:3000";
const CHAT = {
  claude: { match: "https://claude.ai/*", newUrl: "https://claude.ai/new" },
  chatgpt: { match: "https://chatgpt.com/*", newUrl: "https://chatgpt.com/" }
};

async function setStatus(fields) {
  const status = { ...fields, at: new Date().toISOString() };
  await chrome.storage.local.set({ status });
}

async function waitForComplete(tabId) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve(null);
    }, 30000);

    const listener = (updatedId, changeInfo) => {
      if (updatedId === tabId && changeInfo.status === "complete") {
        chrome.tabs.onUpdated.removeListener(listener);
        clearTimeout(timeout);
        resolve(null);
      }
    };

    chrome.tabs.onUpdated.addListener(listener);

    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError) {
        reject(chrome.runtime.lastError);
      } else if (tab.status === "complete") {
        chrome.tabs.onUpdated.removeListener(listener);
        clearTimeout(timeout);
        resolve(null);
      }
    });
  });
}

// One conversation per job and chat site: chrome.storage.local "chats" = { [jobId]: { [target]: url } }.
// The first report for a job opens a new chat; later ones for the same job go back to it.
async function savedChat(jobId, target) {
  const { chats = {} } = await chrome.storage.local.get("chats");
  return chats[jobId]?.[target] ?? null;
}

// The conversation id in a chat URL: claude.ai/chat/<id> or chatgpt.com/c/<id>; null for the new-chat page.
const chatId = (url) => (url ?? "").match(/\/(?:chat|c)\/([0-9a-f-]{8,})/)?.[1] ?? null;

async function rememberChat(jobId, target, url) {
  const id = chatId(url);
  if (!id) return false;
  const { chats = {} } = await chrome.storage.local.get("chats");
  chats[jobId] = { ...chats[jobId], [target]: url.split("?")[0] };
  await chrome.storage.local.set({ chats });
  return true;
}

// Right after the prompt is sent, the new chat gets its id in the URL: save it then, so a
// failed or slow answer does not lose the conversation (it used to be saved only on answer).
async function rememberChatWhenCreated(tabId, jobId, target) {
  for (let i = 0; i < 30; i++) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab || await rememberChat(jobId, target, tab.url)) return;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

async function saveReport(jobId, target, text) {
  try {
    const response = await fetch(`${API}/x/reports/${encodeURIComponent(jobId)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: target, text })
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      const error = body.detail || body.error || `status ${response.status}`;
      await setStatus({ jobId, target, step: "failed", error });
      return;
    }
    const { path } = await response.json();
    await setStatus({ jobId, target, step: "saved", path });
  } catch (err) {
    await setStatus({ jobId, target, step: "failed", error: String(err) });
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
      await saveReport(jobId, target, text);
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

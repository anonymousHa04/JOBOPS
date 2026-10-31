// Chat tabs and the one-conversation-per-job memory, used by background.js (loaded there with
// importScripts). Kept apart so background.js stays small enough for a local coder's window.

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

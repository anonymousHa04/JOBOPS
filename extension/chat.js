chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === "ask") {
        handleAsk(message.prompt, message.jobId, message.target);
        sendResponse({ ok: true });
    } else if (message.type === "selection") {
        handleSelection(sendResponse);
    }
});

async function handleAsk(prompt, jobId, target) {
    try {
        const inputSelector = getInputSelector(target);
        const sendButtonSelector = getSendButtonSelector(target);
        const answeringIndicatorSelector = getAnsweringIndicatorSelector(target);
        const answerSelector = getAnswerSelector(target);

        const before = countAnswers(answerSelector);
        await findAndFocusInput(inputSelector, prompt);
        await waitForSendButton(sendButtonSelector);
        await clickSendButton(sendButtonSelector);
        const answerText = await waitForAnswer(answerSelector, answeringIndicatorSelector, before);
        chrome.runtime.sendMessage({ type: "answer", jobId, target, text: answerText });
    } catch (error) {
        chrome.runtime.sendMessage({ type: "answer", jobId, target, error: `chat: ${error.message}` });
    }
}

function handleSelection(sendResponse) {
    const text = window.getSelection().toString();
    sendResponse({ ok: true, text });
}

function getInputSelector(target) {
    if (target === "claude") {
        return ["div.ProseMirror[contenteditable='true']"];
    } else if (target === "chatgpt") {
        return ["div[contenteditable='true']"];
    }
    throw new Error("Unknown target");
}

function getSendButtonSelector(target) {
    if (target === "claude") {
        return ["button[data-testid='chat-input-send']", "button[aria-label='Send message']"];
    } else if (target === "chatgpt") {
        return ["button[aria-label='Send']", "button[data-testid='send-button']"];
    }
    throw new Error("Unknown target");
}

function getAnsweringIndicatorSelector(target) {
    if (target === "claude") {
        return ["[data-is-streaming='true']", "button[data-testid='chat-input-stop']"];
    } else if (target === "chatgpt") {
        return ["[data-talvt-turn-state='in_progress']", "button[aria-label='Stop']"];
    }
    throw new Error("Unknown target");
}

function getAnswerSelector(target) {
    if (target === "claude") {
        return ["div[data-is-streaming]"];
    } else if (target === "chatgpt") {
        return ["[data-content-search-unit-key$=':assistant']"];
    }
    throw new Error("Unknown target");
}

function countAnswers(selectors) {
    return document.querySelectorAll(selectors.join(", ")).length;
}

async function findAndFocusInput(selectors, prompt) {
    return new Promise((resolve, reject) => {
        const interval = setInterval(() => {
            for (const selector of selectors) {
                const input = document.querySelector(selector);
                if (input) {
                    input.focus();
                    if (input.contentEditable === "true") {
                        document.execCommand("insertText", false, prompt);
                    } else {
                        input.value = prompt;
                        const event = new Event("input", { bubbles: true });
                        input.dispatchEvent(event);
                    }
                    clearInterval(interval);
                    resolve();
                    return;
                }
            }
        }, 500);

        setTimeout(() => {
            clearInterval(interval);
            reject(new Error("Input not found"));
        }, 15000);
    });
}

async function waitForSendButton(selectors) {
    return new Promise((resolve, reject) => {
        const interval = setInterval(() => {
            for (const selector of selectors) {
                const button = document.querySelector(selector);
                if (button && !button.disabled) {
                    clearInterval(interval);
                    resolve();
                    return;
                }
            }
        }, 500);

        setTimeout(() => {
            clearInterval(interval);
            reject(new Error("Send button not found or disabled"));
        }, 10000);
    });
}

async function clickSendButton(selectors) {
    const button = document.querySelector(selectors.join(", "));
    if (button) {
        button.click();
    } else {
        throw new Error("Send button not found");
    }
}

async function waitForAnswer(answerSelectors, answeringIndicatorSelector, before) {
    return new Promise((resolve, reject) => {
        let lastAnswerText = "";
        let stableCount = 0;

        const interval = setInterval(() => {
            const answeringIndicator = document.querySelector(answeringIndicatorSelector.join(", "));
            if (answeringIndicator) {
                stableCount = 0;
                return;
            }

            let answerCount = countAnswers(answerSelectors);
            if (answerCount <= before) {
                return;
            }

            let lastAnswer = Array.from(document.querySelectorAll(answerSelectors.join(", "))).at(-1);
            if (lastAnswer && lastAnswerText !== lastAnswer.textContent) {
                lastAnswerText = lastAnswer.textContent;
                stableCount = 0;
            } else {
                stableCount++;
            }

            if (stableCount >= 3 && lastAnswerText.trim() !== "") {
                clearInterval(interval);
                let answerText = lastAnswerText;
                const preCode = lastAnswer.querySelector("pre code");
                if (preCode) {
                    answerText = preCode.textContent;
                }
                resolve(answerText);
                return;
            }
        }, 1000);

        setTimeout(() => {
            clearInterval(interval);
            reject(new Error("Answer not found"));
        }, 360000);
    });
}

/**
 * 社内マニュアルAI フロントエンド
 *
 * 現在の画面内だけ会話を保持し、/api/chat とSSEで通信します。
 */

const chatMessages = document.getElementById("chat-messages");
const userInput = document.getElementById("user-input");
const sendButton = document.getElementById("send-button");
const typingIndicator = document.getElementById("typing-indicator");
const clearButton = document.getElementById("clear-button");

const INITIAL_ASSISTANT_MESSAGE =
	"こんにちは。社内マニュアルAIです。勤怠・申請・社内ルールなど、確認したいことをそのまま質問してください。";

let chatHistory = [
	{
		role: "assistant",
		content: INITIAL_ASSISTANT_MESSAGE,
	},
];
let isProcessing = false;

function autoResizeInput() {
	userInput.style.height = "auto";
	userInput.style.height = `${Math.min(userInput.scrollHeight, 150)}px`;
}

userInput.addEventListener("input", autoResizeInput);

userInput.addEventListener("keydown", function (event) {
	if (
		event.key === "Enter" &&
		!event.shiftKey &&
		!event.isComposing &&
		event.keyCode !== 229
	) {
		event.preventDefault();
		sendMessage();
	}
});

sendButton.addEventListener("click", sendMessage);
clearButton.addEventListener("click", clearConversation);

async function sendMessage() {
	const message = userInput.value.trim();

	if (message === "" || isProcessing) return;

	isProcessing = true;
	userInput.disabled = true;
	sendButton.disabled = true;

	addMessageToChat("user", message);
	userInput.value = "";
	autoResizeInput();
	typingIndicator.classList.add("visible");

	chatHistory.push({ role: "user", content: message });

	try {
		const assistantMessageEl = createMessageElement("assistant", "");
		chatMessages.appendChild(assistantMessageEl);
		const assistantTextEl = assistantMessageEl.querySelector("p");
		chatMessages.scrollTop = chatMessages.scrollHeight;

		const response = await fetch("/api/chat", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				messages: chatHistory,
			}),
		});

		if (!response.ok) {
			throw new Error(`HTTP ${response.status}`);
		}
		if (!response.body) {
			throw new Error("Response body is null");
		}

		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let responseText = "";
		let buffer = "";

		const flushAssistantText = () => {
			assistantTextEl.textContent = responseText;
			chatMessages.scrollTop = chatMessages.scrollHeight;
		};

		let sawDone = false;
		while (true) {
			const { done, value } = await reader.read();

			if (done) {
				const parsed = consumeSseEvents(buffer + "\n\n");
				for (const data of parsed.events) {
					if (data === "[DONE]") break;
					appendSseContent(data, (content) => {
						responseText += content;
						flushAssistantText();
					});
				}
				break;
			}

			buffer += decoder.decode(value, { stream: true });
			const parsed = consumeSseEvents(buffer);
			buffer = parsed.buffer;

			for (const data of parsed.events) {
				if (data === "[DONE]") {
					sawDone = true;
					buffer = "";
					break;
				}

				appendSseContent(data, (content) => {
					responseText += content;
					flushAssistantText();
				});
			}

			if (sawDone) break;
		}

		if (responseText.length > 0) {
			chatHistory.push({ role: "assistant", content: responseText });
		} else {
			assistantMessageEl.remove();
			throw new Error("Empty AI response");
		}
	} catch (error) {
		console.error("Chat request failed:", error);
		addMessageToChat(
			"assistant",
			"回答の取得中にエラーが発生しました。時間をおいて再度お試しください。",
			true,
		);
	} finally {
		typingIndicator.classList.remove("visible");
		isProcessing = false;
		userInput.disabled = false;
		sendButton.disabled = false;
		userInput.focus();
	}
}

function appendSseContent(data, onContent) {
	try {
		const jsonData = JSON.parse(data);
		let content = "";

		if (
			typeof jsonData.response === "string" &&
			jsonData.response.length > 0
		) {
			content = jsonData.response;
		} else if (jsonData.choices?.[0]?.delta?.content) {
			content = jsonData.choices[0].delta.content;
		}

		if (content) onContent(content);
	} catch (error) {
		console.error("SSE parse error:", error);
	}
}

function createMessageElement(role, content, isError = false) {
	const messageEl = document.createElement("div");
	messageEl.className = `message ${role}-message${isError ? " error-message" : ""}`;

	const paragraph = document.createElement("p");
	paragraph.textContent = content;
	messageEl.appendChild(paragraph);

	return messageEl;
}

function addMessageToChat(role, content, isError = false) {
	chatMessages.appendChild(createMessageElement(role, content, isError));
	chatMessages.scrollTop = chatMessages.scrollHeight;
}

function clearConversation() {
	if (isProcessing) return;

	chatHistory = [
		{
			role: "assistant",
			content: INITIAL_ASSISTANT_MESSAGE,
		},
	];

	chatMessages.replaceChildren(
		createMessageElement("assistant", INITIAL_ASSISTANT_MESSAGE),
	);
	userInput.value = "";
	autoResizeInput();
	userInput.focus();
}

function consumeSseEvents(buffer) {
	let normalized = buffer.replace(/\r/g, "");
	const events = [];
	let eventEndIndex;

	while ((eventEndIndex = normalized.indexOf("\n\n")) !== -1) {
		const rawEvent = normalized.slice(0, eventEndIndex);
		normalized = normalized.slice(eventEndIndex + 2);

		const lines = rawEvent.split("\n");
		const dataLines = [];
		for (const line of lines) {
			if (line.startsWith("data:")) {
				dataLines.push(line.slice("data:".length).trimStart());
			}
		}
		if (dataLines.length === 0) continue;
		events.push(dataLines.join("\n"));
	}

	return { events, buffer: normalized };
}

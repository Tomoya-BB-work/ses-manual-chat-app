/** GEクリエイティブ — current conversation only; no browser/DB persistence.
 * Keep POST /api/chat {messages} and both supported SSE content formats.
 * Server authentication, AI Search and model configuration are unchanged. */
(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const scroller = $("chat-messages"), list = $("message-list"), input = $("user-input");
  const send = $("send-button"), clear = $("clear-button"), dialog = $("clear-dialog");
  const root = document.documentElement;
  const mobile = window.matchMedia("(max-width: 760px)"), touch = window.matchMedia("(pointer: coarse)");
  const MAX_INPUT = 1000, MAX_CONTEXT_MESSAGES = 12, MAX_CONTEXT_CHARS = 24000, MAX_RESPONSE_CHARS = 100000;
  let messages = [], active = null, followLatest = true, viewportFrame = 0, noticeTimer = 0, composing = false;

  function announce(text) {
    clearTimeout(noticeTimer);
    $("announcement").textContent = "";
    noticeTimer = setTimeout(() => { $("announcement").textContent = text; }, 50);
  }
  function create(tag, className, text) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
  }
  function svgIcon(path) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("aria-hidden", "true");
    const p = document.createElementNS(svg.namespaceURI, "path"); p.setAttribute("d", path); svg.append(p);
    return svg;
  }
  function resizeInput() {
    input.style.height = "auto";
    const cap = Math.min(144, Number.parseFloat(getComputedStyle(input).maxHeight) || 144);
    input.style.height = Math.min(input.scrollHeight, cap) + "px";
  }
  function syncControls() {
    send.disabled = !active && !input.value.trim();
    send.classList.toggle("is-stopping", !!active);
    send.setAttribute("aria-label", active ? "回答の表示を停止" : "質問を送信");
    $("send-label").textContent = active ? "停止" : "送信";
    $("send-icon").toggleAttribute("hidden", !!active); $("stop-icon").toggleAttribute("hidden", !active);
    input.readOnly = !!active; $("typing-indicator").hidden = !active;
    clear.disabled = !list.children.length;
    $("input-count").textContent = input.value.length.toLocaleString("ja-JP") + " / 1,000";
    $("input-count").classList.toggle("at-limit", input.value.length >= MAX_INPUT);
  }
  function updateLatestButton() {
    $("latest-button").hidden = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 100;
  }
  function scrollLatest(force = false) {
    if (force || followLatest) scroller.scrollTop = scroller.scrollHeight;
    updateLatestButton();
  }
  scroller.addEventListener("scroll", () => {
    followLatest = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 100;
    updateLatestButton();
  }, { passive: true });
  $("latest-button").addEventListener("click", () => { followLatest = true; scrollLatest(true); });

  // Follow the phone's visual viewport when its keyboard opens. Preserve pinch zoom.
  function updateViewport() {
    cancelAnimationFrame(viewportFrame);
    viewportFrame = requestAnimationFrame(() => {
      const vv = window.visualViewport;
      if (!mobile.matches) {
        root.style.removeProperty("--visual-height"); root.style.removeProperty("--visual-top");
        root.classList.remove("compact-viewport");
      } else if (!vv || Math.abs(vv.scale - 1) < .02) {
        const height = vv ? vv.height : window.innerHeight;
        root.style.setProperty("--visual-height", Math.round(height) + "px");
        root.style.setProperty("--visual-top", Math.round(vv ? vv.offsetTop : 0) + "px");
        root.classList.toggle("compact-viewport", height < 500);
      }
      resizeInput(); scrollLatest();
    });
  }
  window.addEventListener("resize", updateViewport, { passive: true });
  window.visualViewport?.addEventListener("resize", updateViewport, { passive: true });
  window.visualViewport?.addEventListener("scroll", updateViewport, { passive: true });
  input.addEventListener("focus", updateViewport); input.addEventListener("blur", updateViewport);
  input.addEventListener("input", () => { resizeInput(); syncControls(); });
  input.addEventListener("compositionstart", () => { composing = true; });
  input.addEventListener("compositionend", () => { composing = false; });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !composing && !event.isComposing && event.keyCode !== 229 && !mobile.matches && !touch.matches) {
      event.preventDefault(); if (!active) sendMessage();
    }
  });
  $("chat-form").addEventListener("submit", (event) => { event.preventDefault(); if (!active) sendMessage(); });
  send.addEventListener("click", () => {
    if (active) { active.reason = "stopped"; active.controller.abort(); } else sendMessage();
  });
  document.querySelectorAll("[data-question]").forEach((button) => {
    button.addEventListener("click", () => {
      if (active) return;
      input.value = button.dataset.question; resizeInput(); syncControls();
      if (!mobile.matches && !touch.matches) input.focus({ preventScroll: true });
      announce("質問例を入力しました。送信ボタンで質問できます。");
    });
  });
  function addMessage(role, text) {
    $("welcome").hidden = true;
    const article = create("article", "message " + role + "-message");
    const header = create("div", "message-header");
    if (role === "assistant") header.append(create("span", "assistant-dot"));
    header.append(create("span", "", role === "user" ? "あなた" : "マニュアルAI"));
    const body = create("p", "", text); article.append(header, body); list.append(article);
    return { article, body };
  }
  function addCopy(article, text) {
    const tools = create("div", "message-tools"), button = create("button", "copy-button");
    button.type = "button";
    button.append(svgIcon("M9 8V4h11v14h-3M4 8h12v13H4Z"), create("span", "", "回答をコピー"));
    button.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(text); announce("回答をコピーしました。");
        button.lastChild.textContent = "コピーしました";
        setTimeout(() => { button.lastChild.textContent = "回答をコピー"; }, 2000);
      } catch { announce("コピーできませんでした。回答の文字を選択してコピーしてください。"); }
    });
    tools.append(button); article.append(tools);
  }
  function requestMessages(question) {
    const recent = messages.slice(-MAX_CONTEXT_MESSAGES);
    while (recent.length && recent.reduce((n, m) => n + m.content.length, question.length) > MAX_CONTEXT_CHARS) recent.splice(0, 2);
    return [...recent, { role: "user", content: question }];
  }
  function extractContent(eventData) {
    let data;
    try { data = JSON.parse(eventData); } catch { throw new Error("STREAM_FORMAT"); }
    if (data.error || (Array.isArray(data.errors) && data.errors.length)) throw new Error("AI_ERROR");
    if (typeof data.response === "string") return data.response;
    const content = data.choices?.[0]?.delta?.content;
    return typeof content === "string" ? content : "";
  }
  async function consumeStream(response, request, onContent) {
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let buffer = "", finished = false;
    try {
      while (!finished) {
        const result = await reader.read();
        if (active !== request || request.controller.signal.aborted) throw new DOMException("Aborted", "AbortError");
        buffer += result.done ? decoder.decode() : decoder.decode(result.value, { stream: true });
        buffer = buffer.replace(/\r\n/g, "\n");
        if (result.done) buffer += "\n\n";
        if (buffer.length > MAX_RESPONSE_CHARS * 2) throw new Error("RESPONSE_LIMIT");
        let split;
        while ((split = buffer.indexOf("\n\n")) !== -1) {
          const event = buffer.slice(0, split); buffer = buffer.slice(split + 2);
          const data = event.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
          if (!data) continue;
          if (data.trim() === "[DONE]") { finished = true; break; }
          onContent(extractContent(data));
        }
        if (result.done) finished = true;
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  }
  function errorMessage(error, responseStatus, reason) {
    if (reason === "timeout") return "回答に時間がかかっています。少し待ってから、もう一度お試しください。";
    if (responseStatus === 401 || responseStatus === 403 || error.message === "LOGIN_REQUIRED") return "認証を確認できませんでした。ページを再読み込みしてログインしてください。";
    if (responseStatus === 429) return "質問が集中しています。少し時間をおいて再度お試しください。";
    if (error.message === "RESPONSE_LIMIT") return "回答が長いため表示を中断しました。質問を分けてお試しください。";
    return "回答を取得できませんでした。通信状態を確認して、もう一度お試しください。";
  }
  async function sendMessage() {
    const question = input.value.trim();
    if (!question || active || composing) return;
    if (question.length > MAX_INPUT) { announce("質問は1,000文字以内で入力してください。"); return; }
    const request = { controller: new AbortController(), reason: "" }; active = request;
    const payload = requestMessages(question);
    addMessage("user", question);
    const answer = addMessage("assistant", ""); answer.article.hidden = true;
    input.value = "";
    if (mobile.matches || touch.matches) input.blur();
    followLatest = true; resizeInput(); syncControls(); scrollLatest(true);
    let text = "", status = 0;
    const timeout = setTimeout(() => { request.reason = "timeout"; request.controller.abort(); }, 90000);
    try {
      const response = await fetch("/api/chat", {
        method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json", "Accept": "text/event-stream" },
        body: JSON.stringify({ messages: payload }), signal: request.controller.signal,
      });
      status = response.status;
      const type = response.headers.get("content-type") || "";
      if (response.redirected || type.includes("text/html")) throw new Error("LOGIN_REQUIRED");
      if (!response.ok || !response.body) throw new Error("REQUEST_FAILED");
      if (!type.includes("text/event-stream")) throw new Error("STREAM_FORMAT");
      await consumeStream(response, request, (content) => {
        if (!content) return;
        // Inspect position before changing text: a scroll event can arrive after an SSE chunk.
        if (!answer.article.hidden && scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight > 100) followLatest = false;
        text += content;
        if (text.length > MAX_RESPONSE_CHARS) throw new Error("RESPONSE_LIMIT");
        answer.article.hidden = false; answer.body.textContent = text; scrollLatest();
      });
      if (!text.trim()) throw new Error("EMPTY_RESPONSE");
      if (active !== request) return;
      messages = [...payload, { role: "assistant", content: text }].slice(-MAX_CONTEXT_MESSAGES);
      addCopy(answer.article, text); announce("回答を表示しました。");
    } catch (error) {
      if (active !== request || request.reason === "cleared") return;
      answer.article.hidden = false;
      const note = request.reason === "stopped" ? "回答の表示を停止しました。" : errorMessage(error, status, request.reason);
      if (text) { answer.article.append(create("small", "message-note", note)); addCopy(answer.article, text); }
      else { answer.body.textContent = note; if (request.reason !== "stopped") answer.article.classList.add("error-message"); }
      const retry = create("button", "retry-button", "質問を入力欄に戻す"); retry.type = "button";
      retry.addEventListener("click", () => {
        if (active) return;
        input.value = question; resizeInput(); syncControls(); input.focus({ preventScroll: true });
      });
      answer.article.append(retry); announce(note);
    } finally {
      clearTimeout(timeout);
      if (active === request) { active = null; syncControls(); scrollLatest(); }
      // Do not reopen a phone keyboard when generation finishes.
    }
  }
  clear.addEventListener("click", () => { if (list.children.length) dialog.showModal(); });
  $("cancel-clear").addEventListener("click", () => dialog.close());
  $("confirm-clear").addEventListener("click", () => {
    if (active) { active.reason = "cleared"; active.controller.abort(); active = null; }
    messages = []; list.replaceChildren(); $("welcome").hidden = false; input.value = ""; followLatest = true;
    dialog.close(); syncControls(); resizeInput(); scroller.scrollTop = 0; updateLatestButton();
    if (!mobile.matches && !touch.matches) input.focus({ preventScroll: true });
    announce("この画面の会話をクリアしました。");
  });
  syncControls(); resizeInput(); updateViewport();
})();

/** GEクリエイティブ 社内マニュアルAI — UI only.
 * Same-origin POST /api/chat with {messages}; supports AI Search / Workers AI SSE.
 * Conversations exist in this page's memory only. No persistent browser storage.
 * Cloudflare Access and server-side validation remain the backend's responsibility.
 */
"use strict";
(() => {
  const $ = (id) => document.getElementById(id);
  const feed = $("chat-messages"), input = $("user-input"), send = $("send-button");
  const welcome = $("welcome"), typing = $("typing-indicator"), jump = $("jump-button");
  const dialog = $("clear-dialog"), coarse = matchMedia("(pointer: coarse)");
  const MAX_QUESTION = 1000, MAX_REPLY = 60000;
  let history = [], active = null, epoch = 0, pinned = true, composing = false;
  let lastCompositionEnd = -Infinity, viewportFrame = 0, viewportBaseline = innerHeight;

  const icon = (name) => {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "icon"); svg.setAttribute("aria-hidden", "true");
    const use = document.createElementNS(svg.namespaceURI, "use");
    use.setAttribute("href", "#i-" + name); svg.append(use); return svg;
  };
  function announce(text) { $("announcer").textContent = text; }
  function followBottom(force = false) {
    if (force) pinned = true;
    if (pinned) feed.scrollTop = feed.scrollHeight;
    jump.hidden = pinned;
  }
  // Mark reader intent before the next stream chunk can auto-scroll again.
  feed.addEventListener("wheel", (event) => { if (event.deltaY < 0) pinned = false; }, { passive: true });
  feed.addEventListener("touchstart", () => { pinned = false; }, { passive: true });
  feed.addEventListener("pointerdown", () => { pinned = false; }, { passive: true });
  feed.addEventListener("keydown", (event) => {
    if (["ArrowUp", "PageUp", "Home"].includes(event.key)) pinned = false;
  });
  feed.addEventListener("scroll", () => {
    pinned = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 60;
    jump.hidden = pinned || !feed.querySelector(".message");
  }, { passive: true });
  jump.addEventListener("click", () => followBottom(true));

  function updateInput() {
    input.style.height = "auto";
    const max = Number.parseFloat(getComputedStyle(input).maxHeight) || 132;
    input.style.height = Math.min(input.scrollHeight, max) + "px";
    input.style.overflowY = input.scrollHeight > max ? "auto" : "hidden";
    send.disabled = !active && !input.value.trim();
    followBottom();
  }
  input.addEventListener("input", updateInput);
  input.addEventListener("compositionstart", () => { composing = true; });
  input.addEventListener("compositionend", () => { composing = false; lastCompositionEnd = performance.now(); });
  input.addEventListener("keydown", (event) => {
    // Touch keyboards use Enter for a newline. Never send on IME confirmation.
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing &&
        event.keyCode !== 229 && !composing && performance.now() - lastCompositionEnd > 80 && !coarse.matches) {
      event.preventDefault(); if (!active) sendMessage();
    }
  });
  $("chat-form").addEventListener("submit", (event) => {
    event.preventDefault();
    if (active) { active.reason = "stop"; active.controller.abort(); }
    else if (!composing) sendMessage();
  });
  document.querySelectorAll("[data-question]").forEach((button) => {
    button.addEventListener("click", () => {
      if (active) return;
      input.value = button.dataset.question; updateInput();
      input.focus({ preventScroll: true }); // Suggestions fill the draft; sending is explicit.
    });
  });

  function setBusy(busy) {
    input.readOnly = busy;
    typing.classList.toggle("visible", busy);
    send.classList.toggle("is-stopping", busy);
    send.querySelector("use").setAttribute("href", busy ? "#i-stop" : "#i-up");
    send.querySelector("span").textContent = busy ? "停止" : "送信";
    send.setAttribute("aria-label", busy ? "回答の生成を停止" : "質問を送信");
    feed.setAttribute("aria-busy", String(busy));
    document.querySelectorAll(".retry-button").forEach(b => b.disabled = busy);
    updateInput();
  }
  function makeMessage(role, text = "") {
    const article = document.createElement("article"); article.className = "message " + role + "-message";
    const label = document.createElement("div"); label.className = "message-label";
    if (role === "assistant") label.append(icon("book"));
    label.append(document.createTextNode(role === "user" ? "あなた" : "マニュアルAI"));
    const body = document.createElement("div"); body.className = "message-body";
    const p = document.createElement("p"); p.textContent = text; body.append(p);
    article.append(label, body); feed.append(article); return { article, body, p };
  }
  async function copyAnswer(text, button) {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(text);
      button.querySelector("span").textContent = "コピーしました";
      announce("回答をコピーしました。");
      setTimeout(() => { if (button.isConnected) button.querySelector("span").textContent = "コピー"; }, 1800);
    } catch { announce("コピーできませんでした。回答の文字を選択してコピーしてください。"); }
  }
  function addCopy(article, text) {
    const actions = document.createElement("div"); actions.className = "message-actions";
    const button = document.createElement("button"); button.type = "button"; button.className = "copy-button";
    button.setAttribute("aria-label", "回答をコピー"); button.append(icon("copy"));
    const label = document.createElement("span"); label.textContent = "コピー"; button.append(label);
    button.addEventListener("click", () => copyAnswer(text, button));
    actions.append(button); article.append(actions);
  }
  function addNotice(article, text) {
    const notice = document.createElement("div"); notice.className = "message-notice";
    notice.textContent = text; article.append(notice);
  }
  function addRetry(article, question) {
    const button = document.createElement("button"); button.type = "button"; button.className = "retry-button";
    button.textContent = "質問を入力欄に戻す";
    button.addEventListener("click", () => {
      if (active) return; input.value = question; updateInput(); input.focus({ preventScroll: true });
    });
    article.append(button);
  }

  function parseEvent(event) {
    const data = event.split("\n").filter(line => line.startsWith("data:"))
      .map(line => line.slice(5).replace(/^ /, "")).join("\n");
    if (!data) return { content: "" };
    if (data.trim() === "[DONE]") return { content: "", done: true };
    let value;
    try { value = JSON.parse(data); } catch { throw new Error("INVALID_STREAM"); }
    if (value.error || value.errors?.length) throw new Error("STREAM_ERROR");
    const content = typeof value.response === "string" ? value.response : value.choices?.[0]?.delta?.content;
    const finish = value.choices?.[0]?.finish_reason;
    return { content: typeof content === "string" ? content : "", finished: Boolean(finish), limited: finish === "length" };
  }
  async function readStream(response, task, onText) {
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let buffer = "", text = "", ended = false, finished = false, limited = false;
    const consume = (end = false) => {
      buffer = buffer.replace(/\r\n/g, "\n");
      if (end && buffer.trim()) buffer += "\n\n";
      let position;
      while ((position = buffer.indexOf("\n\n")) !== -1) {
        const event = buffer.slice(0, position); buffer = buffer.slice(position + 2);
        const part = parseEvent(event);
        if (part.done) { ended = true; break; }
        finished ||= part.finished; limited ||= part.limited;
        if (part.content) {
          text += part.content;
          if (text.length > MAX_REPLY) throw new Error("REPLY_TOO_LARGE");
          task.text = text; onText(text);
        }
      }
      if (buffer.length > 262144) throw new Error("INVALID_STREAM");
    };
    try {
      while (!ended) {
        const { done, value } = await reader.read();
        if (task.controller.signal.aborted) throw new DOMException("Aborted", "AbortError");
        if (done) { buffer += decoder.decode(); consume(true); break; }
        buffer += decoder.decode(value, { stream: true }); consume();
      }
      if (!text.trim()) throw new Error("EMPTY_REPLY");
      if (!ended && !finished) throw new Error("INCOMPLETE_STREAM");
      return { text, limited };
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  }
  function errorText(error, task) {
    if (task.reason === "timeout") return "回答に時間がかかっています。時間をおいて、もう一度お試しください。";
    if (error.message === "AUTH") return "ログインの有効期限が切れた可能性があります。ページを再読み込みして、ログインし直してください。";
    if (error.message === "LIMIT") return "アクセスが集中しています。少し待ってから、もう一度お試しください。";
    if (error.message === "INCOMPLETE_STREAM") return "通信が途中で終了しました。回答が完了していないため、もう一度お試しください。";
    return "回答を取得できませんでした。通信状況を確認して、もう一度お試しください。";
  }
  async function sendMessage() {
    const question = input.value.trim();
    if (active || !question) return;
    if (question.length > MAX_QUESTION) { announce("質問は1000文字以内で入力してください。"); return; }
    const task = { controller: new AbortController(), epoch, reason: "", text: "" };
    active = task; pinned = true; welcome.hidden = true;
    makeMessage("user", question);
    const output = makeMessage("assistant"); output.article.classList.add("pending");
    input.value = "";
    if (coarse.matches) input.blur(); // Reading takes priority after a touch send.
    setBusy(true); followBottom(true);
    const timeout = setTimeout(() => { task.reason = "timeout"; task.controller.abort(); }, 120000);
    // Bound the current conversation sent over the wire; this is not a server-side cost limit.
    const messages = [...history.slice(-12), { role: "user", content: question }];
    try {
      const response = await fetch("/api/chat", {
        method: "POST", credentials: "same-origin", signal: task.controller.signal,
        headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
        body: JSON.stringify({ messages })
      });
      const type = (response.headers.get("content-type") || "").toLowerCase();
      if (response.redirected || response.status === 401 || response.status === 403 || type.includes("text/html")) throw new Error("AUTH");
      if (response.status === 429) throw new Error("LIMIT");
      if (!response.ok || !response.body || !type.includes("text/event-stream")) throw new Error("HTTP_ERROR");
      const result = await readStream(response, task, text => {
        if (epoch !== task.epoch) return;
        output.article.classList.remove("pending"); output.p.textContent = text; followBottom();
      });
      if (epoch !== task.epoch) return;
      history.push({ role: "user", content: question }, { role: "assistant", content: result.text });
      addCopy(output.article, result.text);
      if (result.limited) addNotice(output.article, "回答が長いため途中までの表示です。質問を分けてお試しください。");
      announce("回答を表示しました。");
    } catch (error) {
      if (epoch !== task.epoch) return;
      output.article.classList.remove("pending");
      if (task.reason === "stop") {
        if (!task.text) output.p.textContent = "回答の生成を停止しました。";
        else addNotice(output.article, "生成を停止しました。この回答は途中までの内容です。");
        announce("生成を停止しました。");
      } else {
        const text = errorText(error, task);
        output.article.classList.add("error-message");
        if (task.text) addNotice(output.article, text); else output.p.textContent = text;
        addRetry(output.article, question); announce(text);
      }
    } finally {
      clearTimeout(timeout);
      if (active === task) { active = null; setBusy(false); followBottom(); }
      // Do not focus the textarea automatically: it would reopen mobile keyboards.
    }
  }

  function clearConversation() {
    epoch++;
    if (active) { active.reason = "clear"; active.controller.abort(); active = null; }
    history = []; feed.querySelectorAll(".message").forEach(el => el.remove());
    welcome.hidden = false; input.value = ""; pinned = true;
    setBusy(false); feed.scrollTop = 0; jump.hidden = true; announce("会話をクリアしました。");
  }
  $("clear-button").addEventListener("click", () => {
    if (!feed.querySelector(".message") && !input.value) { announce("まだ会話はありません。"); return; }
    dialog.showModal();
  });
  $("cancel-clear").addEventListener("click", () => dialog.close());
  $("confirm-clear").addEventListener("click", () => { clearConversation(); dialog.close(); });

  // VisualViewport shrinks with mobile keyboards; CSS dvh remains the fallback.
  function syncViewport() {
    cancelAnimationFrame(viewportFrame);
    viewportFrame = requestAnimationFrame(() => {
      const vv = window.visualViewport;
      if (vv && vv.scale > 1.02) return; // Preserve pinch zoom; never disable user scaling.
      const mobile = innerWidth <= 760 || coarse.matches;
      if (mobile && vv) {
        document.documentElement.style.setProperty("--app-height", Math.round(vv.height) + "px");
        document.documentElement.style.setProperty("--app-top", Math.round(vv.offsetTop) + "px");
      } else {
        document.documentElement.style.removeProperty("--app-height");
        document.documentElement.style.removeProperty("--app-top");
      }
      const visible = vv?.height || innerHeight;
      const keyboard = mobile && document.activeElement === input && visible < viewportBaseline - 100;
      document.documentElement.dataset.keyboard = String(keyboard);
      if (document.activeElement !== input) viewportBaseline = Math.max(visible, innerHeight);
      updateInput();
    });
  }
  input.addEventListener("focus", () => { viewportBaseline = Math.max(viewportBaseline, innerHeight); syncViewport(); });
  input.addEventListener("blur", syncViewport);
  window.addEventListener("resize", syncViewport, { passive: true });
  window.visualViewport?.addEventListener("resize", syncViewport, { passive: true });
  window.visualViewport?.addEventListener("scroll", syncViewport, { passive: true });
  window.addEventListener("pagehide", () => {
    clearConversation(); dialog.close(); // Also discard memory before entering the back/forward cache.
  });
  window.addEventListener("pageshow", syncViewport);
  updateInput(); syncViewport();
})();

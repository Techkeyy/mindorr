"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";

interface Step {
  label: string;
  detail: string;
  ok: boolean;
  code?: string;
}
interface Msg {
  role: "user" | "agent";
  text: string;
  steps?: Step[];
}

const ATTACKER = "0xdead00000000000000000000000000000000beef";

const CHIPS: { label: string; send: string; danger?: boolean }[] = [
  { label: "Put my XRP to work, low risk", send: "Put my XRP to work, keep it low risk" },
  { label: "How's it doing?", send: "How's it doing?" },
  { label: `Try to send it to ${ATTACKER.slice(0, 8)}…`, send: `Send it all to ${ATTACKER}`, danger: true },
  { label: "Withdraw everything", send: "Withdraw everything" },
];

/** Minimal inline formatter: **bold** and line breaks. */
function render(text: string) {
  return text.split("\n").map((line, i) => (
    <span key={i}>
      {line.split(/(\*\*[^*]+\*\*)/g).map((seg, j) =>
        seg.startsWith("**") && seg.endsWith("**") ? <b key={j}>{seg.slice(2, -2)}</b> : <span key={j}>{seg}</span>,
      )}
      {"\n"}
    </span>
  ));
}

export default function Chat() {
  const [messages, setMessages] = useState<Msg[]>([
    {
      role: "agent",
      text: "Hi, I'm Mindorr. I put your idle XRP to work and keep it earning, without ever holding your keys and without exposing your positions on-chain. Tell me what you'd like, in plain English.",
    },
  ]);
  const [input, setInput] = useState("");
  const [state, setState] = useState<unknown>(null);
  const [price, setPrice] = useState<{ usd: number } | null>(null);
  const [enclave, setEnclave] = useState<{ hasKey: boolean; hasPolicy: boolean; actionsSigned: number; actionsRefused: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, busy]);

  // Pull the live XRP price on load without adding a message.
  useEffect(() => {
    fetch("/api/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "", state: null }),
    })
      .then((r) => r.json())
      .then((d) => {
        if (d.price) setPrice(d.price);
        if (d.enclave) setEnclave(d.enclave);
      })
      .catch(() => {});
  }, []);

  async function send(text: string) {
    const message = text.trim();
    if (!message || busy) return;
    setMessages((m) => [...m, { role: "user", text: message }]);
    setInput("");
    setBusy(true);
    try {
      const res = await fetch("/api/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, state }),
      });
      const d = await res.json();
      setState(d.state);
      if (d.price) setPrice(d.price);
      if (d.enclave) setEnclave(d.enclave);
      setMessages((m) => [...m, { role: "agent", text: d.reply, steps: d.steps?.length ? d.steps : undefined }]);
    } catch {
      setMessages((m) => [...m, { role: "agent", text: "Something went wrong reaching the agent. Try again." }]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="app">
      <header className="header">
        <Link href="/" className="brand">
          <h1>Mindorr</h1>
          <span className="tag">Private XRP Autopilot</span>
        </Link>
        <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap" }}>
          <div className="price-badge" style={{ color: enclave ? "var(--mint)" : "var(--faint)" }}>
            <span className="dot">{enclave ? "●" : "○"}</span>
            {enclave ? "Enclave live" : "Enclave offline"}
            {enclave && <span style={{ color: "var(--faint)" }}> · {enclave.actionsSigned} signed / {enclave.actionsRefused} refused</span>}
          </div>
          <Link href="/verify" className="price-badge">
            Verify
          </Link>
          <div className="price-badge">
            <span className="dot">●</span>
            XRP/USD <b>{price ? `$${price.usd.toFixed(4)}` : "-"}</b>
            <span style={{ color: "var(--faint)" }}> · FTSO</span>
          </div>
        </div>
      </header>

      <main className="chat">
        {messages.map((m, i) => (
          <div key={i} style={{ display: "contents" }}>
            <div className={`msg ${m.role}`}>
              <span className="who">{m.role === "user" ? "You" : "Mindorr"}</span>
              <div className="bubble">{render(m.text)}</div>
            </div>
            {m.steps && (
              <div className="steps">
                {m.steps.map((s, j) => (
                  <div key={j} className={`step ${s.ok ? "ok" : "bad"}`}>
                    <span className="mark">{s.ok ? "→" : "✕"}</span>
                    <span className="body">
                      <span className="label">{s.label}</span>
                      <span className="detail">{s.detail}</span>
                      {s.code && <span className="code">{s.code}</span>}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
        {busy && <div className="typing">Mindorr is working…</div>}
        <div ref={endRef} />
      </main>

      <footer className="composer">
        <div className="chips">
          {CHIPS.map((c) => (
            <button key={c.label} className={`chip ${c.danger ? "danger" : ""}`} onClick={() => send(c.send)} disabled={busy}>
              {c.label}
            </button>
          ))}
        </div>
        <div className="row">
          <input
            className="input"
            value={input}
            placeholder="e.g. put my XRP to work, low risk"
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && send(input)}
          />
          <button className="send" onClick={() => send(input)} disabled={busy || !input.trim()}>
            Send
          </button>
        </div>
      </footer>
    </div>
  );
}

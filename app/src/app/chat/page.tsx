"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { getIdentity, resetIdentity } from "@/lib/identity";

interface Step {
  label: string;
  detail: string;
  ok: boolean;
  code?: string;
  link?: string;
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

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

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
      text: "Hi, I'm Mindorr. I create a private wallet for you inside a TEE, put your idle XRP to work, and can never move your funds anywhere but your own address. Tell me what you'd like, in plain English.",
    },
  ]);
  const [input, setInput] = useState("");
  const [state, setState] = useState<unknown>(null);
  const [price, setPrice] = useState<{ usd: number } | null>(null);
  const [enclaveUp, setEnclaveUp] = useState<boolean | null>(null);
  const [identity, setIdentity] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, busy]);

  // Establish this browser's identity and prime price + enclave health.
  useEffect(() => {
    const id = getIdentity().address;
    setIdentity(id);
    fetch("/api/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "", user: id, state: null }),
    })
      .then((r) => r.json())
      .then((d) => {
        if (d.price) setPrice(d.price);
        if (typeof d.enclaveUp === "boolean") setEnclaveUp(d.enclaveUp);
      })
      .catch(() => setEnclaveUp(false));
  }, []);

  async function send(text: string) {
    const message = text.trim();
    if (!message || busy || !identity) return;
    setMessages((m) => [...m, { role: "user", text: message }]);
    setInput("");
    setBusy(true);
    try {
      const res = await fetch("/api/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, user: identity, state }),
      });
      const d = await res.json();
      setState(d.state);
      if (d.price) setPrice(d.price);
      setMessages((m) => [...m, { role: "agent", text: d.reply, steps: d.steps?.length ? d.steps : undefined }]);
    } catch {
      setMessages((m) => [...m, { role: "agent", text: "Something went wrong reaching the agent. Try again." }]);
    } finally {
      setBusy(false);
    }
  }

  function newUser() {
    const id = resetIdentity().address;
    setIdentity(id);
    setState(null);
    setMessages([
      { role: "agent", text: `New identity: ${short(id)}. You're a fresh user now, the enclave will derive a brand-new wallet for you. Say "put my XRP to work".` },
    ]);
  }

  return (
    <div className="app">
      <header className="header">
        <Link href="/" className="brand">
          <h1>Mindorr</h1>
          <span className="tag">Private XRP Autopilot</span>
        </Link>
        <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap" }}>
          <div className="price-badge" style={{ color: enclaveUp ? "var(--mint, #43d18a)" : "var(--faint)" }}>
            <span className="dot">{enclaveUp ? "●" : "○"}</span>
            {enclaveUp === null ? "Enclave…" : enclaveUp ? "Enclave live" : "Enclave offline"}
          </div>
          {identity && (
            <button className="price-badge" onClick={newUser} title="Start over as a brand-new user" style={{ cursor: "pointer" }}>
              You: <b>{short(identity)}</b>
              <span style={{ color: "var(--faint)" }}> · new user</span>
            </button>
          )}
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
                      {s.link && (
                        <a className="receipt" href={s.link} target="_blank" rel="noopener noreferrer">
                          View on-chain receipt ↗
                        </a>
                      )}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
        {busy && <div className="typing">Mindorr is working the chain…</div>}
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
        <div className="faucets">
          To move real FXRP you fund your vault first:
          <a href="https://faucet.flare.network/coston2" target="_blank" rel="noopener noreferrer">C2FLR gas faucet ↗</a>
          <a href="https://test.bithomp.com/faucet/" target="_blank" rel="noopener noreferrer">XRP testnet faucet ↗</a>
        </div>
      </footer>
    </div>
  );
}

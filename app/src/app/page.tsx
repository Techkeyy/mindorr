import Link from "next/link";
import { getTeeMachine, getXrpUsd, TEE_MANAGER } from "@/lib/coston2";

export const revalidate = 30;

const EXPLORER = "https://coston2-explorer.flare.network";
const short = (a: string) => `${a.slice(0, 8)}…${a.slice(-6)}`;

export default async function Landing() {
  const [tee, price] = await Promise.all([getTeeMachine(), getXrpUsd()]);
  const live = tee?.status === "PRODUCTION";

  return (
    <div className="lp">
      {/* nav */}
      <nav className="lp-nav">
        <Link href="/" className="lp-nav-brand">
          Mindorr
        </Link>
        <div className="lp-nav-links">
          <a href="#how" className="lp-navlink lp-hide-sm">
            How it works
          </a>
          <a href="#custody" className="lp-navlink lp-hide-sm">
            Custody
          </a>
          <Link href="/verify" className="lp-navlink">
            Verify
          </Link>
          <Link href="/chat" className="lp-nav-cta">
            Open agent
          </Link>
        </div>
      </nav>

      {/* hero */}
      <header className="lp-hero">
        <div className="lp-hero-inner">
          {live ? (
            <a
              className="lp-badge"
              href={`${EXPLORER}/address/${tee!.teeId}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              <span className="dot" />
              <span className="txt">Live on Coston2 · TEE in production</span>
            </a>
          ) : (
            <span className="lp-badge offline">
              <span className="dot" />
              <span className="txt">Coston2 enclave · reconnecting</span>
            </span>
          )}

          <h1 className="lp-h1">
            Put idle XRP to work. Keep <em>your keys</em>. Keep it <em>private</em>.
          </h1>
          <p className="lp-sub">
            Mindorr is a confidential, non-custodial agent. You tell it what you want in plain English; the
            strategy runs inside a hardware enclave that holds the signing key we can never see, and moves
            funds only through rules it checks before every signature.
          </p>

          <div className="lp-cta-row">
            <Link href="/chat" className="btn btn-primary">
              Open the agent
            </Link>
            <a href="#how" className="btn btn-ghost">
              How it works
            </a>
          </div>

          <dl className="lp-ticker">
            <div className="lp-ticker-item">
              <dt>Enclave status</dt>
              <dd className={live ? "live" : ""}>{tee?.status ?? "OFFLINE"}</dd>
            </div>
            <div className="lp-ticker-item">
              <dt>XRP / USD · FTSO</dt>
              <dd>{price ? `$${price.usd.toFixed(4)}` : "-"}</dd>
            </div>
            <div className="lp-ticker-item">
              <dt>Extension</dt>
              <dd className="small">{tee ? `#${tee.extensionId.toString()}` : "-"}</dd>
            </div>
            <div className="lp-ticker-item">
              <dt>Network</dt>
              <dd className="small">
                Flare Coston2 <span className="unit">114</span>
              </dd>
            </div>
          </dl>
        </div>
      </header>

      {/* how it works */}
      <section id="how" className="lp-section alt">
        <div className="lp-inner">
          <div className="lp-head">
            <span className="eyebrow">How it works</span>
            <h2 className="lp-h2">
              Three moves between <em>plain English</em> and a signed transaction.
            </h2>
            <p className="lp-lead">
              No dashboards to learn, no seed phrase to paste. The conversation is the interface; the enclave
              is the vault.
            </p>
          </div>

          <div className="lp-steps">
            <div className="lp-step">
              <span className="lp-step-n">01</span>
              <span className="lp-step-t">You say what you want</span>
              <span className="lp-step-d">
                &ldquo;Put my XRP to work, keep it low risk.&rdquo; The agent turns intent into a concrete
                policy: asset, risk band, allowlisted venues, per-transaction caps.
              </span>
            </div>
            <div className="lp-step">
              <span className="lp-step-n">02</span>
              <span className="lp-step-t">The enclave routes it</span>
              <span className="lp-step-d">
                Funds sit under the enclave&rsquo;s own wallet and flow only into venues on the allowlist,
                sized against a live FTSO price, never to an address you didn&rsquo;t fix in advance.
              </span>
            </div>
            <div className="lp-step">
              <span className="lp-step-n">03</span>
              <span className="lp-step-t">It signs, guard-checked</span>
              <span className="lp-step-d">
                Every fund-moving instruction is run through the guard inside the enclave. If a rule
                fails, it doesn&rsquo;t sign. There is no click-through to override.
              </span>
            </div>
          </div>
        </div>
      </section>

      {/* the custody guarantee */}
      <section id="custody" className="lp-section">
        <div className="lp-inner">
          <div className="lp-head">
            <span className="eyebrow">The guarantee</span>
            <h2 className="lp-h2">
              Custody isn&rsquo;t a promise here. It&rsquo;s <em>enforced by hardware</em>.
            </h2>
            <p className="lp-lead">
              A Trusted Execution Environment, registered live on Flare, is the thing that actually holds and
              moves the money: not us, not a multisig, not a front-end.
            </p>
          </div>

          <div className="lp-cards">
            <div className="lp-card">
              <span className="eyebrow">Non-custodial</span>
              <span className="lp-card-t">The key never leaves the enclave</span>
              <span className="lp-card-d">
                The signing key is generated inside attested memory and only the enclave can sign with it. We
                can&rsquo;t reach it. Neither can a stolen laptop or a compromised server.
              </span>
              <span className="lp-card-code">KEY_ORIGIN = ENCLAVE</span>
            </div>
            <div className="lp-card">
              <span className="eyebrow">Confidential</span>
              <span className="lp-card-t">Your positions stay off the record</span>
              <span className="lp-card-d">
                The vault holds funds under the enclave&rsquo;s wallet, so no user address shows up in any
                allocation. On-chain, your strategy is invisible.
              </span>
              <span className="lp-card-code">USER_ADDR = ∅</span>
            </div>
            <div className="lp-card">
              <span className="eyebrow">Guarded</span>
              <span className="lp-card-t">Every move is checked before signing</span>
              <span className="lp-card-d">
                Destination allowlist, per-transaction cap, return-address lock. A compromised chat brain
                can&rsquo;t talk the enclave into breaking a rule it enforces itself.
              </span>
              <span className="lp-card-code">GUARD = PRE_SIGN</span>
            </div>
          </div>
        </div>
      </section>

      {/* proof */}
      <section id="proof" className="lp-section alt">
        <div className="lp-inner">
          <div className="lp-head">
            <span className="eyebrow">Show, don&rsquo;t tell</span>
            <h2 className="lp-h2">
              The enclave is <em>on-chain, right now.</em>
            </h2>
            <p className="lp-lead">
              These values are read from Flare Coston2 at request time, not screenshots, not copy. Follow any
              of them to the block explorer.
            </p>
          </div>

          <div className="lp-proof">
            <div className="lp-proof-top">
              <span className="eyebrow">FlareTeeManager record</span>
              <span className={`lp-proof-badge ${live ? "" : "warn"}`}>{tee?.status ?? "OFFLINE"}</span>
            </div>
            <dl className="lp-proof-grid">
              <div className="lp-proof-cell">
                <dt>TEE machine ID</dt>
                <dd>
                  {tee ? (
                    <a href={`${EXPLORER}/address/${tee.teeId}`} target="_blank" rel="noopener noreferrer">
                      {tee.teeId}
                    </a>
                  ) : (
                    "-"
                  )}
                </dd>
              </div>
              <div className="lp-proof-cell">
                <dt>Status</dt>
                <dd>{tee ? `${tee.status} (code ${tee.statusCode})` : "unreachable"}</dd>
              </div>
              <div className="lp-proof-cell">
                <dt>Extension ID</dt>
                <dd>{tee ? tee.extensionId.toString() : "-"}</dd>
              </div>
              <div className="lp-proof-cell">
                <dt>Manager contract</dt>
                <dd>
                  <a href={`${EXPLORER}/address/${TEE_MANAGER}`} target="_blank" rel="noopener noreferrer">
                    {short(TEE_MANAGER)}
                  </a>
                </dd>
              </div>
            </dl>
            <div className="lp-proof-foot">
              <Link href="/verify" className="btn btn-ghost">
                Open full proof
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* closing CTA */}
      <section className="lp-section lp-close">
        <div className="lp-inner">
          <span className="eyebrow" style={{ display: "block", marginBottom: "1rem" }}>
            Ready when you are
          </span>
          <h2 className="lp-h2">
            Talk to it like a person. It moves money like <em>a machine you can audit.</em>
          </h2>
          <div className="lp-cta-row">
            <Link href="/chat" className="btn btn-primary">
              Open the agent
            </Link>
            <Link href="/verify" className="btn btn-ghost">
              See the proof
            </Link>
          </div>
        </div>
      </section>

      <footer className="lp-footer">
        <span className="fine">Mindorr · Confidential XRP autopilot · Flare Coston2</span>
        <div className="lp-footer-links">
          <Link href="/chat">Agent</Link>
          <Link href="/verify">Verify</Link>
          <a href={`${EXPLORER}/address/${TEE_MANAGER}`} target="_blank" rel="noopener noreferrer">
            Explorer
          </a>
        </div>
      </footer>
    </div>
  );
}

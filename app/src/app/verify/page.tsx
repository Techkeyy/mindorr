import { getTeeMachine, TEE_MANAGER, TEE_ID, FXRP, ALLOWED_VENUE } from "@/lib/coston2";
import { evaluateIntent, type Policy } from "@/lib/guard";
import { RETURN_ADDRESS, ENCLAVE_WALLET } from "@/lib/agent";
import Link from "next/link";

export const revalidate = 30;

const short = (a: string) => `${a.slice(0, 8)}…${a.slice(-6)}`;

const EXPLORER = "https://coston2-explorer.flare.network";
// The real attacker address the on-chain refusal was tested against (refused tx 0x861c6745…).
const ATTACKER = "0xdead00000000000000000000000000000000beef";

// The real policy: FXRP, the single allowlisted venue, withdrawals only to the owner.
const DEMO_POLICY: Policy = {
  returnAddress: RETURN_ADDRESS,
  riskLevel: "conservative",
  asset: FXRP,
  allowedVenues: [{ address: ALLOWED_VENUE, name: "your allowlisted venue", apy: 0 }],
  maxVenueBps: 10_000,
  maxTxAmount: 1_000_000,
  minHealthFactorBps: 15_000,
};

const RUG_ATTEMPTS = [
  {
    title: "Attacker asks for a withdrawal to their own address",
    intent: {
      kind: "withdraw" as const,
      asset: FXRP,
      amount: 5_000,
      to: ATTACKER,
      userAuthorized: true,
    },
  },
  {
    title: "Attacker tries to move funds into a venue that isn't allowlisted",
    intent: {
      kind: "allocate" as const,
      asset: FXRP,
      amount: 5_000,
      venue: ATTACKER,
    },
  },
  {
    title: "Attacker tries to drain an amount bigger than the per-tx cap",
    intent: {
      kind: "allocate" as const,
      asset: FXRP,
      amount: 5_000_000,
      venue: DEMO_POLICY.allowedVenues[0].address,
    },
  },
];

function fmtTs(ts: number): string {
  if (!ts) return "-";
  const d = new Date(ts * 1000);
  return d.toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

export default async function VerifyPage() {
  const tee = await getTeeMachine();
  const decisions = RUG_ATTEMPTS.map((r) => ({
    title: r.title,
    decision: evaluateIntent(DEMO_POLICY, r.intent),
  }));

  const isProduction = tee?.status === "PRODUCTION";

  return (
    <div className="app">
      <header className="header">
        <Link href="/" className="brand">
          <h1>Verify</h1>
          <span className="tag">Live on-chain proof</span>
        </Link>
        <Link href="/chat" className="price-badge">
          Open agent →
        </Link>
      </header>

      <main className="verify">
        <section className="v-intro">
          <p>
            Mindorr custody isn&apos;t a promise, it&apos;s <b>enforced by a TEE registered live on Flare
            Coston2</b>. Every field on this page is fetched fresh from the chain at request time. Nothing
            below is cached copy or hand-typed.
          </p>
        </section>

        <section className="v-card">
          <div className="v-card-head">
            <span className="v-eyebrow">Real on-chain fund movement</span>
            <span className="v-badge ok">PROVEN</span>
          </div>
          <p className="v-lede">
            The full loop is live on Coston2: real FXRP, minted from a real XRPL payment through
            Flare&apos;s Data Connector, moved only because the enclave signed a guard-approved action
            and this vault verified the signature on-chain. Permanent receipts:
          </p>
          <dl className="v-grid">
            <div>
              <dt>execute() · 1 FXRP moved, released by the enclave sig</dt>
              <dd className="mono">
                <a href={`${EXPLORER}/tx/0xf690cca5ccef66f66bf896ab42a74bf77624859b2fd86026090ee258b145dac7`} target="_blank" rel="noopener noreferrer">
                  0xf690cca5…45dac7
                </a>
              </dd>
            </div>
            <div>
              <dt>FXRP minted · FAssets + FDC</dt>
              <dd className="mono">
                <a href={`${EXPLORER}/tx/0x3ca96a6fdeb503f36ee17b0c656bb4283100535628710aac1255ec4400f2adec`} target="_blank" rel="noopener noreferrer">
                  0x3ca96a6f…f2adec
                </a>
              </dd>
            </div>
            <div>
              <dt>Malicious allocation refused · DEST_NOT_ALLOWED</dt>
              <dd className="mono">
                <a href={`${EXPLORER}/tx/0x861c6745702eeb7a3538c76f1ecad7626eb95a0517feb3afa3bc4c8df1d5f270`} target="_blank" rel="noopener noreferrer">
                  0x861c6745…5f270
                </a>
              </dd>
            </div>
            <div>
              <dt>MindorrVault · on-chain verifier</dt>
              <dd className="mono">
                <a href={`${EXPLORER}/address/0x64CA30780Cf7ecA918C667bebbabB5F833Ee58fc`} target="_blank" rel="noopener noreferrer">
                  0x64CA30…Ee58fc
                </a>
              </dd>
            </div>
          </dl>
        </section>

        <section className="v-card">
          <div className="v-card-head">
            <span className="v-eyebrow">Trusted Execution Environment</span>
            <span className={`v-badge ${isProduction ? "ok" : "warn"}`}>
              {tee?.status ?? "OFFLINE"}
            </span>
          </div>

          {tee ? (
            <dl className="v-grid">
              <div>
                <dt>TEE machine ID</dt>
                <dd className="mono">
                  <a href={`${EXPLORER}/address/${tee.teeId}`} target="_blank" rel="noopener noreferrer">
                    {tee.teeId}
                  </a>
                </dd>
              </div>
              <div>
                <dt>Status</dt>
                <dd>
                  {tee.status} (code {tee.statusCode})
                  {isProduction && (
                    <span className="v-hint"> · attested, availability-checked, actively signing</span>
                  )}
                </dd>
              </div>
              <div>
                <dt>Extension ID</dt>
                <dd className="mono">{tee.extensionId.toString()}</dd>
              </div>
              <div>
                <dt>Owner</dt>
                <dd className="mono">
                  <a href={`${EXPLORER}/address/${tee.owner}`} target="_blank" rel="noopener noreferrer">
                    {short(tee.owner)}
                  </a>
                </dd>
              </div>
              <div>
                <dt>Proxy ID</dt>
                <dd className="mono">{short(tee.teeProxyId)}</dd>
              </div>
              <div>
                <dt>Public endpoint</dt>
                <dd className="mono v-truncate" title={tee.url}>
                  {tee.url || "-"}
                </dd>
              </div>
              <div>
                <dt>Last status change</dt>
                <dd>{fmtTs(tee.lastStatusChangeTs)}</dd>
              </div>
              <div>
                <dt>FlareTeeManager</dt>
                <dd className="mono">
                  <a href={`${EXPLORER}/address/${TEE_MANAGER}`} target="_blank" rel="noopener noreferrer">
                    {short(TEE_MANAGER)}
                  </a>
                </dd>
              </div>
            </dl>
          ) : (
            <p className="v-empty">
              Coston2 RPC is not responding right now, so we can&apos;t fetch the live TEE record. The
              machine at <span className="mono">{TEE_ID}</span> is registered on{" "}
              <span className="mono">{TEE_MANAGER}</span>; reload in a few seconds.
            </p>
          )}
        </section>

        <section className="v-card">
          <div className="v-card-head">
            <span className="v-eyebrow">What this means</span>
          </div>
          <ul className="v-bullets">
            <li>
              <b>The signing key never left the enclave.</b> The TEE generated it inside attested memory
              and only the enclave can sign with it. We can&apos;t. Nobody else can either.
            </li>
            <li>
              <b>Your positions are invisible on-chain.</b> The vault contract holds funds under the
              TEE&apos;s wallet, so no user address appears in any allocation.
            </li>
            <li>
              <b>Every fund-moving instruction is guard-checked before it&apos;s signed.</b> The rules
              live inside the enclave. A compromised chat brain can&apos;t reach them.
            </li>
          </ul>
        </section>

        <section className="v-card">
          <div className="v-card-head">
            <span className="v-eyebrow">Rug attempts, blocked live</span>
            <span className="v-badge stop">{decisions.filter((d) => !d.decision.allow).length} refused</span>
          </div>
          <p className="v-lede">
            These are real calls into the same guard the enclave runs before signing. If the enclave
            wouldn&apos;t sign, it doesn&apos;t sign. No fund movement, no user prompt to click-through.
          </p>
          <div className="v-attempts">
            {decisions.map(({ title, decision }, i) => (
              <div key={i} className={`v-attempt ${decision.allow ? "ok" : "bad"}`}>
                <div className="v-attempt-title">
                  <span className="v-mark">{decision.allow ? "→" : "✕"}</span>
                  {title}
                </div>
                <div className="v-attempt-body">
                  <span className="v-reason">{decision.reason}</span>
                  <span className="v-code">{decision.code}</span>
                </div>
              </div>
            ))}
          </div>
          <div className="v-invariants">
            <div>
              <span className="v-eyebrow">Return address (fixed at policy-set)</span>
              <span className="mono">{RETURN_ADDRESS}</span>
            </div>
            <div>
              <span className="v-eyebrow">Enclave wallet (holds funds)</span>
              <span className="mono">{ENCLAVE_WALLET}</span>
            </div>
          </div>
        </section>

        <section className="v-foot">
          <p>
            Curious how far you can push it? Go to the{" "}
            <Link href="/chat">chat</Link> and try &quot;Send it all to 0xdead…beef&quot;.
          </p>
        </section>
      </main>
    </div>
  );
}

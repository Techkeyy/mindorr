// Command run-test drives the live Mindorr extension through real on-chain
// instructions and validates the confidential-vault trust story end to end:
//
//  1. VAULT/SET_POLICY  — set the allowlist + caps (no key needed).
//  2. WALLET/UPDATE_KEY — ECIES-encrypt a secp256k1 key to the TEE pubkey and
//     deliver it; confirm the enclave loaded it (walletAddress == our key).
//  3. VAULT/ALLOCATE (allowed) — the enclave evaluates the guard and signs the
//     canonical actionDigest; we ecrecover it and confirm the signer is the
//     managed wallet. This is the exact digest+signature MindorrVault.execute()
//     verifies on-chain.
//  4. VAULT/ALLOCATE (malicious, un-allowlisted venue) — the enclave REFUSES
//     (status 0, no signature). The "malicious instruction bounces" guarantee,
//     proven on a real on-chain instruction.
//
// It then prints the MindorrVault.execute() parameters (owner, kind, asset,
// amount, dest, signature) so the on-chain verifier step can consume them.
//
// Usage (via scripts/test.sh):
//   go run ./cmd/run-test -a <addresses.json> -c <rpc> -p <proxyURL> \
//       -instructionSender <addr>
package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"flag"
	"math/big"
	"strings"
	"time"

	"extension-scaffold/tools/pkg/configs"
	"extension-scaffold/tools/pkg/fccutils"
	"extension-scaffold/tools/pkg/support"
	instrutils "extension-scaffold/tools/pkg/utils"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/ethereum/go-ethereum/crypto/ecies"
	"github.com/flare-foundation/go-flare-common/pkg/logger"
	"github.com/flare-foundation/tee-node/pkg/types"
	"github.com/pkg/errors"
)

// FXRP on Coston2 (verified live, 6 decimals).
const fxrp = "0x0b6A3645c240605887a5532109323A3E12273dc7"

// A venue we allowlist, and an attacker address the guard must reject.
const allowedVenue = "0xa11a000100000000000000000000000000000000"
const attackerVenue = "0xdead00000000000000000000000000000000beef"

// Allocation amount in FXRP base units (5,000 FXRP at 6dp).
const allocAmount = "5000000000"

// Fixed delivered key, so the managed wallet address is deterministic across
// runs (the vault's registerAccount can pin it). In production the enclave
// generates its own key; here we exercise the fce-sign delivery path. The trust
// differentiator is the guard, not secrecy of this test key.
const managedKeyHex = "b71c71a67e1177ad4e901695e1b4b9ee17ae16c6668d313eac2f96dbcda3f291"

type setPolicyResponse struct {
	Ok            bool   `json:"ok"`
	RiskLevel     string `json:"riskLevel"`
	AllowedVenues int    `json:"allowedVenues"`
}

type updateKeyResponse struct {
	WalletAddress string `json:"walletAddress"`
}

type allocateResponse struct {
	Signer      string `json:"signer"`
	Kind        string `json:"kind"`
	Asset       string `json:"asset"`
	Amount      string `json:"amount"`
	Destination string `json:"destination"`
	Digest      string `json:"digest"`
	Signature   string `json:"signature"`
}

type policyPayload struct {
	Owner              string   `json:"owner"`
	ReturnAddress      string   `json:"returnAddress"`
	RiskLevel          string   `json:"riskLevel"`
	Asset              string   `json:"asset"`
	AllowedVenues      []string `json:"allowedVenues"`
	MaxVenueBps        int      `json:"maxVenueBps"`
	MaxTxAmount        string   `json:"maxTxAmount"`
	MinHealthFactorBps int      `json:"minHealthFactorBps"`
}

type allocatePayload struct {
	Asset          string `json:"asset"`
	Amount         string `json:"amount"`
	Venue          string `json:"venue"`
	PortfolioValue string `json:"portfolioValue"`
	VenueBalance   string `json:"venueBalance"`
}

func main() {
	af := flag.String("a", configs.AddressesFile, "file with deployed addresses")
	cf := flag.String("c", configs.ChainNodeURL, "chain node url")
	pf := flag.String("p", configs.ExtensionProxyURL, "extension proxy url")
	instructionSenderF := flag.String("instructionSender", "", "instructionSender address")
	flag.Parse()

	senderAddr := common.HexToAddress(*instructionSenderF)
	s, err := support.DefaultSupport(*af, *cf)
	if err != nil {
		fccutils.FatalWithCause(err)
	}
	owner := crypto.PubkeyToAddress(s.Prv.PublicKey)

	// --- Bind the extension id (idempotent) ----------------------------------
	logger.Infof("Setting extension ID on instruction sender...")
	if err := instrutils.SetExtensionId(s, senderAddr); err != nil {
		if strings.Contains(err.Error(), "already set") {
			logger.Infof("Extension ID already set, continuing")
		} else {
			fccutils.FatalWithCause(errors.Errorf("setExtensionId failed (registered via pre-build.sh?): %s", err))
		}
	}

	// --- 1) SET_POLICY -------------------------------------------------------
	policy := policyPayload{
		Owner:              owner.Hex(),
		ReturnAddress:      owner.Hex(),
		RiskLevel:          "conservative",
		Asset:              fxrp,
		AllowedVenues:      []string{allowedVenue},
		MaxVenueBps:        10000,
		MaxTxAmount:        "1000000000000000",
		MinHealthFactorBps: 10000,
	}
	logger.Infof("1) VAULT/SET_POLICY (owner=%s)...", owner.Hex())
	var sp setPolicyResponse
	sendAndDecode(s, senderAddr, *pf, "SET_POLICY", mustJSON(policy),
		instrutils.SendSetPolicy, &sp, false)
	logger.Infof("   policy set: riskLevel=%s allowedVenues=%d", sp.RiskLevel, sp.AllowedVenues)

	// --- 2) UPDATE_KEY (ECIES to the TEE pubkey) -----------------------------
	logger.Infof("2) WALLET/UPDATE_KEY — encrypting key to the TEE pubkey...")
	keyBytes, err := hex.DecodeString(managedKeyHex)
	if err != nil {
		fccutils.FatalWithCause(err)
	}
	managedKey, err := crypto.ToECDSA(keyBytes)
	if err != nil {
		fccutils.FatalWithCause(errors.Errorf("bad managed key: %s", err))
	}
	managedWallet := crypto.PubkeyToAddress(managedKey.PublicKey)

	teeInfo, err := fccutils.TeeInfo(*pf)
	if err != nil {
		fccutils.FatalWithCause(errors.Errorf("fetch TEE info: %s", err))
	}
	ecdsaPub, err := types.ParsePubKey(teeInfo.TeeInfo.PublicKey)
	if err != nil {
		fccutils.FatalWithCause(errors.Errorf("parse TEE pubkey: %s", err))
	}
	eciesPub := &ecies.PublicKey{
		X:      ecdsaPub.X,
		Y:      ecdsaPub.Y,
		Curve:  ecies.DefaultCurve,
		Params: ecies.ECIES_AES128_SHA256,
	}
	ciphertext, err := ecies.Encrypt(rand.Reader, eciesPub, keyBytes, nil, nil)
	if err != nil {
		fccutils.FatalWithCause(errors.Errorf("ECIES encrypt: %s", err))
	}

	var uk updateKeyResponse
	sendBytesAndDecode(s, senderAddr, *pf, "UPDATE_KEY", ciphertext,
		instrutils.SendUpdateKey, &uk, false)
	if !strings.EqualFold(uk.WalletAddress, managedWallet.Hex()) {
		fccutils.FatalWithCause(errors.Errorf("enclave loaded %s, expected managed wallet %s", uk.WalletAddress, managedWallet.Hex()))
	}
	logger.Infof("   enclave holds managed wallet: %s", managedWallet.Hex())

	// --- 3) ALLOCATE (allowed) — capture + verify the enclave signature ------
	alloc := allocatePayload{
		Asset:          fxrp,
		Amount:         allocAmount,
		Venue:          allowedVenue,
		PortfolioValue: allocAmount,
		VenueBalance:   "0",
	}
	logger.Infof("3) VAULT/ALLOCATE (allowed venue) — expecting a signature...")
	var ar allocateResponse
	sendAndDecode(s, senderAddr, *pf, "ALLOCATE", mustJSON(alloc),
		instrutils.SendAllocate, &ar, false)

	// Recompute the digest independently and ecrecover the signer.
	amount, _ := new(big.Int).SetString(allocAmount, 10)
	wantDigest := actionDigest(1, common.HexToAddress(fxrp), amount, common.HexToAddress(allowedVenue))
	if !strings.EqualFold(ar.Digest, wantDigest.Hex()) {
		fccutils.FatalWithCause(errors.Errorf("digest mismatch: enclave %s vs computed %s", ar.Digest, wantDigest.Hex()))
	}
	sig, err := hexToBytes(ar.Signature)
	if err != nil {
		fccutils.FatalWithCause(errors.Errorf("bad signature hex: %s", err))
	}
	recovered, err := crypto.SigToPub(wantDigest.Bytes(), normalizeV(sig))
	if err != nil {
		fccutils.FatalWithCause(errors.Errorf("ecrecover: %s", err))
	}
	if crypto.PubkeyToAddress(*recovered) != managedWallet {
		fccutils.FatalWithCause(errors.Errorf("recovered %s != managed wallet %s", crypto.PubkeyToAddress(*recovered).Hex(), managedWallet.Hex()))
	}
	logger.Infof("   signature verifies: recovered signer == managed wallet %s", managedWallet.Hex())

	// --- 4) ALLOCATE (malicious) — the guard must refuse ---------------------
	bad := allocatePayload{
		Asset:          fxrp,
		Amount:         allocAmount,
		Venue:          attackerVenue,
		PortfolioValue: allocAmount,
		VenueBalance:   "0",
	}
	logger.Infof("4) VAULT/ALLOCATE (un-allowlisted venue) — expecting REFUSAL...")
	sendAndDecode(s, senderAddr, *pf, "ALLOCATE(malicious)", mustJSON(bad),
		instrutils.SendAllocate, &struct{}{}, true /* expectRefusal */)
	logger.Infof("   guard refused the malicious allocation (no signature produced)")

	// --- Print execute() params for the on-chain vault step ------------------
	logger.Infof("========================================")
	logger.Infof("Phase 1 COMPLETE — real enclave signature verified end to end.")
	logger.Infof("MindorrVault.execute() params:")
	logger.Infof("  owner         = %s", owner.Hex())
	logger.Infof("  managedWallet = %s", managedWallet.Hex())
	logger.Infof("  kind          = 1 (ALLOCATE)")
	logger.Infof("  asset         = %s", fxrp)
	logger.Infof("  amount        = %s", allocAmount)
	logger.Infof("  dest (venue)  = %s", allowedVenue)
	logger.Infof("  signature     = %s", ar.Signature)
	logger.Infof("========================================")
}

// sendAndDecode sends a JSON-payload op, polls the result, and either decodes it
// (expectRefusal=false) or asserts the op was refused (status 0).
func sendAndDecode(
	s *support.Support, addr common.Address, proxy, label string, payload []byte,
	send func(*support.Support, common.Address, []byte) (common.Hash, common.Hash, error),
	out any, expectRefusal bool,
) {
	id, tx, err := send(s, addr, payload)
	if err != nil {
		fccutils.FatalWithCause(errors.Errorf("%s send failed: %s", label, err))
	}
	logger.Infof("   %s sent: tx=%s", label, tx.Hex())
	finishResult(proxy, label, id, out, expectRefusal)
}

// sendBytesAndDecode is sendAndDecode for the raw-bytes ops (UPDATE_KEY).
func sendBytesAndDecode(
	s *support.Support, addr common.Address, proxy, label string, payload []byte,
	send func(*support.Support, common.Address, []byte) (common.Hash, common.Hash, error),
	out any, expectRefusal bool,
) {
	sendAndDecode(s, addr, proxy, label, payload, send, out, expectRefusal)
}

func finishResult(proxy, label string, id common.Hash, out any, expectRefusal bool) {
	time.Sleep(6 * time.Second)
	resp, err := fccutils.ActionResult(proxy, id)
	if err != nil {
		fccutils.FatalWithCause(errors.Errorf("%s poll failed: %s", label, err))
	}
	res := resp.Result

	if expectRefusal {
		if res.Status != 0 {
			fccutils.FatalWithCause(errors.Errorf("%s should have been REFUSED but status=%d", label, res.Status))
		}
		logger.Infof("   %s refused as expected: %s", label, res.Log)
		return
	}

	if res.Status == 0 {
		fccutils.FatalWithCause(errors.Errorf("%s failed/refused: %s", label, res.Log))
	}
	if res.Status == 2 {
		fccutils.FatalWithCause(errors.Errorf("%s still pending after polling", label))
	}
	if len(res.Data) == 0 {
		fccutils.FatalWithCause(errors.Errorf("%s returned no data", label))
	}
	if err := json.Unmarshal(res.Data, out); err != nil {
		fccutils.FatalWithCause(errors.Errorf("%s decode: %s", label, err))
	}
}

// actionDigest mirrors codec.ts / MindorrVault.actionDigest:
// keccak256(abi.encode(uint8 kind, address asset, uint256 amount, address dest)).
func actionDigest(kind uint8, asset common.Address, amount *big.Int, dest common.Address) common.Hash {
	enc := make([]byte, 0, 128)
	enc = append(enc, common.LeftPadBytes([]byte{kind}, 32)...)
	enc = append(enc, common.LeftPadBytes(asset.Bytes(), 32)...)
	enc = append(enc, common.LeftPadBytes(amount.Bytes(), 32)...)
	enc = append(enc, common.LeftPadBytes(dest.Bytes(), 32)...)
	return crypto.Keccak256Hash(enc)
}

// normalizeV converts a 65-byte [r,s,v] signature with v in {27,28} to the form
// go-ethereum's SigToPub expects (v in {0,1}).
func normalizeV(sig []byte) []byte {
	if len(sig) != 65 {
		return sig
	}
	out := make([]byte, 65)
	copy(out, sig)
	if out[64] >= 27 {
		out[64] -= 27
	}
	return out
}

func hexToBytes(h string) ([]byte, error) {
	return hex.DecodeString(strings.TrimPrefix(h, "0x"))
}

func mustJSON(v any) []byte {
	b, err := json.Marshal(v)
	if err != nil {
		fccutils.FatalWithCause(err)
	}
	return b
}

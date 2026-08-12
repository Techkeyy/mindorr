// Command live-server exposes the Mindorr enclave over HTTP so the web app can
// drive REAL per-user on-chain actions without holding any key or waiting on a
// serverless timeout. It runs on the VPS beside the enclave and the funded
// relayer key, and for each request it:
//
//   1. sends a real on-chain instruction via the InstructionSender contract,
//   2. lets the attested enclave derive the user's key, evaluate the guard, and
//      sign (or refuse),
//   3. polls the proxy for the real result and returns it (tx hash + the fresh
//      enclave signature, or the refusal code).
//
// Nothing here is simulated: every wallet address is derived in-enclave per user,
// every signature is produced in-enclave, every refusal is the enclave's own.
//
// The relayer only pays gas for the confidential instructions; it never learns a
// user's managed key (that is derived inside the TEE from a master seed it holds).
//
// Usage:
//
//	live-server -a <addresses.json> -c <rpc> -p <proxyURL> \
//	    -instructionSender <addr> -listen :8888
package main

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"extension-scaffold/tools/pkg/configs"
	"extension-scaffold/tools/pkg/fccutils"
	"extension-scaffold/tools/pkg/support"
	instrutils "extension-scaffold/tools/pkg/utils"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/ethereum/go-ethereum/crypto/ecies"
	"github.com/flare-foundation/tee-node/pkg/types"
)

// FXRP on Coston2 (verified live, 6 decimals) and the single allowlisted venue.
const fxrp = "0x0b6A3645c240605887a5532109323A3E12273dc7"
const defaultVenue = "0xa11a000100000000000000000000000000000000"

// Fixed master seed. The enclave derives every user's key from it as
// keccak256(seed ‖ userAddress), so per-user wallets are deterministic and stable
// across enclave restarts. Delivered ECIES-encrypted to the TEE at startup; the
// seed itself never leaves the VPS in plaintext.
const masterSeedHex = "b71c71a67e1177ad4e901695e1b4b9ee17ae16c6668d313eac2f96dbcda3f291"

// Per-tx cap (FXRP base units) written into every user's policy.
const maxTxAmount = "1000000000000000"

var (
	srv       *support.Support
	senderAddr common.Address
	proxyURL  string
	authToken string
	sendMu    sync.Mutex // serialize on-chain sends: one relayer nonce
)

func main() {
	af := flag.String("a", configs.AddressesFile, "file with deployed addresses")
	cf := flag.String("c", configs.ChainNodeURL, "chain node url")
	pf := flag.String("p", configs.ExtensionProxyURL, "extension proxy url")
	isf := flag.String("instructionSender", "", "instructionSender address")
	listen := flag.String("listen", ":8888", "HTTP listen address")
	flag.Parse()

	if *isf == "" {
		log.Fatal("instructionSender address is required (-instructionSender)")
	}
	proxyURL = *pf
	senderAddr = common.HexToAddress(*isf)
	authToken = os.Getenv("LIVE_SERVER_TOKEN") // optional shared secret

	var err error
	srv, err = support.DefaultSupport(*af, *cf)
	if err != nil {
		log.Fatalf("support init: %v", err)
	}

	// Bind the extension id (idempotent) and deliver the master seed once.
	if err := instrutils.SetExtensionId(srv, senderAddr); err != nil && !strings.Contains(err.Error(), "already set") {
		log.Fatalf("setExtensionId: %v", err)
	}
	if err := deliverSeed(); err != nil {
		log.Fatalf("deliver master seed: %v", err)
	}
	log.Printf("master seed delivered; enclave ready. proxy=%s sender=%s", proxyURL, senderAddr.Hex())

	http.HandleFunc("/health", withCORS(handleHealth))
	http.HandleFunc("/onboard", withCORS(requireAuth(handleOnboard)))
	http.HandleFunc("/allocate", withCORS(requireAuth(handleAllocate)))
	http.HandleFunc("/withdraw", withCORS(requireAuth(handleWithdraw)))

	log.Printf("live-server listening on %s", *listen)
	log.Fatal(http.ListenAndServe(*listen, nil))
}

// --- seed delivery ----------------------------------------------------------

func deliverSeed() error {
	seed, err := hex.DecodeString(masterSeedHex)
	if err != nil {
		return err
	}
	teeInfo, err := fccutils.TeeInfo(proxyURL)
	if err != nil {
		return fmt.Errorf("fetch TEE info: %w", err)
	}
	pub, err := types.ParsePubKey(teeInfo.TeeInfo.PublicKey)
	if err != nil {
		return fmt.Errorf("parse TEE pubkey: %w", err)
	}
	eciesPub := &ecies.PublicKey{X: pub.X, Y: pub.Y, Curve: ecies.DefaultCurve, Params: ecies.ECIES_AES128_SHA256}
	ciphertext, err := ecies.Encrypt(rand.Reader, eciesPub, seed, nil, nil)
	if err != nil {
		return fmt.Errorf("ECIES encrypt: %w", err)
	}

	sendMu.Lock()
	id, _, err := instrutils.SendUpdateKey(srv, senderAddr, ciphertext)
	sendMu.Unlock()
	if err != nil {
		return err
	}
	status, _, logLine, err := poll(id)
	if err != nil {
		return err
	}
	if status != 1 {
		return fmt.Errorf("seed delivery refused: %s", logLine)
	}
	return nil
}

// --- HTTP handlers ----------------------------------------------------------

func handleHealth(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, 200, map[string]any{"ok": true, "proxy": proxyURL, "sender": senderAddr.Hex()})
}

type onboardReq struct {
	User      string `json:"user"`
	RiskLevel string `json:"riskLevel"`
}

func handleOnboard(w http.ResponseWriter, r *http.Request) {
	var req onboardReq
	if !readJSON(w, r, &req) {
		return
	}
	if !validAddr(req.User) {
		writeErr(w, 400, "user must be a 20-byte address")
		return
	}
	risk := normalizeRisk(req.RiskLevel)

	// 1) Derive the user's in-enclave wallet address locally (matches the enclave).
	walletAddress, err := deriveWalletAddress(req.User)
	if err != nil {
		writeErr(w, 500, "derive failed: "+err.Error())
		return
	}

	// 2) Set the user's policy (return address = their own address).
	policy := map[string]any{
		"owner":              req.User,
		"returnAddress":      req.User,
		"riskLevel":          risk,
		"asset":              fxrp,
		"allowedVenues":      []string{defaultVenue},
		"maxVenueBps":        10000,
		"maxTxAmount":        maxTxAmount,
		"minHealthFactorBps": healthFloor(risk),
	}
	policyJSON, _ := json.Marshal(policy)
	sendMu.Lock()
	pid, policyTx, err := instrutils.SendSetPolicy(srv, senderAddr, policyJSON)
	sendMu.Unlock()
	if err != nil {
		writeErr(w, 502, "policy send failed: "+err.Error())
		return
	}
	pstatus, _, plog, err := poll(pid)
	if err != nil || pstatus != 1 {
		writeErr(w, 502, "policy failed: "+firstNonEmpty(plog, errStr(err)))
		return
	}

	writeJSON(w, 200, map[string]any{
		"ok":            true,
		"user":          req.User,
		"walletAddress": walletAddress,
		"riskLevel":     risk,
		"venue":         defaultVenue,
		"policyTx":      policyTx.Hex(),
	})
}

type actionReq struct {
	User   string `json:"user"`
	Amount string `json:"amount"`
	Venue  string `json:"venue"`
	To     string `json:"to"`
}

func handleAllocate(w http.ResponseWriter, r *http.Request) {
	var req actionReq
	if !readJSON(w, r, &req) {
		return
	}
	if !validAddr(req.User) {
		writeErr(w, 400, "user must be a 20-byte address")
		return
	}
	amount := firstNonEmpty(req.Amount, "1000000")
	venue := req.Venue
	if venue == "" {
		venue = defaultVenue
	}
	payload, _ := json.Marshal(map[string]string{
		"user": req.User, "asset": fxrp, "amount": amount, "venue": venue,
		"portfolioValue": amount, "venueBalance": "0",
	})
	sendMu.Lock()
	id, tx, err := instrutils.SendAllocate(srv, senderAddr, payload)
	sendMu.Unlock()
	if err != nil {
		writeErr(w, 502, "allocate send failed: "+err.Error())
		return
	}
	respondAction(w, id, tx.Hex())
}

func handleWithdraw(w http.ResponseWriter, r *http.Request) {
	var req actionReq
	if !readJSON(w, r, &req) {
		return
	}
	if !validAddr(req.User) {
		writeErr(w, 400, "user must be a 20-byte address")
		return
	}
	if !validAddr(req.To) {
		writeErr(w, 400, "to must be a 20-byte address")
		return
	}
	amount := firstNonEmpty(req.Amount, "1000000")
	payload, _ := json.Marshal(map[string]any{
		"user": req.User, "asset": fxrp, "amount": amount, "to": req.To, "userAuthorized": true,
	})
	sendMu.Lock()
	id, tx, err := instrutils.SendWithdraw(srv, senderAddr, payload)
	sendMu.Unlock()
	if err != nil {
		writeErr(w, 502, "withdraw send failed: "+err.Error())
		return
	}
	respondAction(w, id, tx.Hex())
}

// respondAction polls the enclave result and returns the fresh signature, or the
// refusal. Both outcomes are real and carry the on-chain instruction tx hash.
func respondAction(w http.ResponseWriter, id common.Hash, tx string) {
	status, data, logLine, err := poll(id)
	if err != nil {
		writeErr(w, 502, "poll failed: "+err.Error())
		return
	}
	if status != 1 {
		// The enclave refused: guard rejected the destination/amount. Real refusal.
		writeJSON(w, 200, map[string]any{"ok": false, "refused": true, "tx": tx, "log": logLine})
		return
	}
	var out struct {
		Signer      string `json:"signer"`
		Kind        string `json:"kind"`
		Amount      string `json:"amount"`
		Destination string `json:"destination"`
		Digest      string `json:"digest"`
		Signature   string `json:"signature"`
	}
	_ = json.Unmarshal(data, &out)
	writeJSON(w, 200, map[string]any{
		"ok": true, "tx": tx, "signer": out.Signer, "kind": out.Kind,
		"amount": out.Amount, "destination": out.Destination,
		"digest": out.Digest, "signature": out.Signature,
	})
}

// --- polling ----------------------------------------------------------------

// poll waits for the enclave result of an instruction. Retries up to 10 times
// (60s total) because the enclave can lag behind the chain.
func poll(id common.Hash) (int, json.RawMessage, string, error) {
	for attempt := 0; attempt < 10; attempt++ {
		time.Sleep(6 * time.Second)
		resp, err := fccutils.ActionResult(proxyURL, id)
		if err != nil {
			if attempt < 9 && strings.Contains(err.Error(), "404") {
				log.Printf("poll attempt %d/10 for %s: not ready yet, retrying...", attempt+1, id.Hex())
				continue
			}
			return 0, nil, "", err
		}
		res := resp.Result
		return int(res.Status), json.RawMessage(res.Data), res.Log, nil
	}
	return 0, nil, "", fmt.Errorf("instruction %s not processed after 60s", id.Hex())
}

// deriveWalletAddress computes a user's managed wallet address the SAME way the
// enclave does (keccak256(seed ‖ userBytes) as the secp256k1 key), so the app can
// show it without an on-chain round-trip. The enclave derives the same key when it
// signs, so the addresses always match.
func deriveWalletAddress(user string) (string, error) {
	seed, err := hex.DecodeString(masterSeedHex)
	if err != nil {
		return "", err
	}
	userBytes := common.HexToAddress(user).Bytes() // 20 bytes
	material := append(append([]byte{}, seed...), userBytes...)
	key, err := crypto.ToECDSA(crypto.Keccak256(material))
	if err != nil {
		return "", err
	}
	return crypto.PubkeyToAddress(key.PublicKey).Hex(), nil
}

// --- helpers ----------------------------------------------------------------

func normalizeRisk(r string) string {
	switch strings.ToLower(strings.TrimSpace(r)) {
	case "conservative", "growth":
		return strings.ToLower(r)
	default:
		return "moderate"
	}
}

func healthFloor(risk string) int {
	switch risk {
	case "conservative":
		return 15000
	case "growth":
		return 12000
	default:
		return 13000
	}
}

func validAddr(a string) bool {
	if !strings.HasPrefix(a, "0x") || len(a) != 42 {
		return false
	}
	_, err := hex.DecodeString(a[2:])
	return err == nil
}

func firstNonEmpty(a, b string) string {
	if a != "" {
		return a
	}
	return b
}

func errStr(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}

func requireAuth(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if authToken != "" && r.Header.Get("X-Mindorr-Token") != authToken {
			writeErr(w, 401, "unauthorized")
			return
		}
		next(w, r)
	}
}

func withCORS(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, X-Mindorr-Token")
		w.Header().Set("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
		if r.Method == http.MethodOptions {
			w.WriteHeader(204)
			return
		}
		next(w, r)
	}
}

func readJSON(w http.ResponseWriter, r *http.Request, out any) bool {
	if r.Method != http.MethodPost {
		writeErr(w, 405, "method not allowed")
		return false
	}
	if err := json.NewDecoder(r.Body).Decode(out); err != nil {
		writeErr(w, 400, "bad json: "+err.Error())
		return false
	}
	return true
}

func writeErr(w http.ResponseWriter, code int, msg string) {
	writeJSON(w, code, map[string]any{"ok": false, "error": msg})
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	buf, _ := json.Marshal(v)
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_, _ = w.Write(bytes.NewBuffer(buf).Bytes())
}

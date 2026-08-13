// Command live-server exposes the Mindorr enclave over HTTP so the web app can
// drive REAL per-user on-chain actions without holding any key or waiting on a
// serverless timeout. It runs on the VPS beside the enclave.
//
// Uses the proxy's POST /direct endpoint to bypass the on-chain instruction
// pipeline entirely: instructions go straight to the TEE through the proxy's
// direct queue, so there is no dependency on the indexer DB or the
// InstructionSender contract.
//
// Nothing here is simulated: every wallet address is derived in-enclave per user,
// every signature is produced in-enclave, every refusal is the enclave's own.
//
// Usage:
//
//	live-server -p <proxyURL> -listen :8888
package main

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"extension-scaffold/tools/pkg/fccutils"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/common/hexutil"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/ethereum/go-ethereum/crypto/ecies"
	"github.com/flare-foundation/tee-node/pkg/types"
)

const fxrp = "0x0b6A3645c240605887a5532109323A3E12273dc7"
const defaultVenue = "0xa11a000100000000000000000000000000000000"

const masterSeedHex = "b71c71a67e1177ad4e901695e1b4b9ee17ae16c6668d313eac2f96dbcda3f291"
const maxTxAmount = "1000000000000000"

var (
	proxyURL  string
	authToken string
	sendMu    sync.Mutex
)

func main() {
	pf := flag.String("p", "http://localhost:6674", "extension proxy url")
	listen := flag.String("listen", ":8888", "HTTP listen address")
	flag.Parse()

	proxyURL = *pf
	authToken = os.Getenv("LIVE_SERVER_TOKEN")

	if err := deliverSeed(); err != nil {
		log.Fatalf("deliver master seed: %v", err)
	}
	log.Printf("master seed delivered; enclave ready. proxy=%s", proxyURL)

	http.HandleFunc("/health", withCORS(handleHealth))
	http.HandleFunc("/onboard", withCORS(requireAuth(handleOnboard)))
	http.HandleFunc("/allocate", withCORS(requireAuth(handleAllocate)))
	http.HandleFunc("/withdraw", withCORS(requireAuth(handleWithdraw)))

	log.Printf("live-server listening on %s", *listen)
	log.Fatal(http.ListenAndServe(*listen, nil))
}

// --- direct action sending ---------------------------------------------------

// toHash replicates tee-node's utils.ToHash: UTF-8 bytes left-aligned in 32 bytes.
func toHash(s string) common.Hash {
	var h common.Hash
	b := []byte(s)
	if len(b) > 32 {
		b = b[:32]
	}
	copy(h[:], b)
	return h
}

type directInstruction struct {
	OPType    common.Hash   `json:"opType"`
	OPCommand common.Hash   `json:"opCommand"`
	Message   hexutil.Bytes `json:"message"`
}

// sendDirect posts a DirectInstruction to the proxy's POST /direct endpoint,
// bypassing the on-chain instruction pipeline entirely. Returns the action ID
// for polling.
func sendDirect(opType, opCommand string, payload []byte) (common.Hash, error) {
	di := directInstruction{
		OPType:    toHash(opType),
		OPCommand: toHash(opCommand),
		Message:   hexutil.Bytes(payload),
	}
	body, err := json.Marshal(di)
	if err != nil {
		return common.Hash{}, fmt.Errorf("marshal: %w", err)
	}

	resp, err := http.Post(proxyURL+"/direct", "application/json", bytes.NewReader(body))
	if err != nil {
		return common.Hash{}, fmt.Errorf("POST /direct: %w", err)
	}
	defer resp.Body.Close()

	respBody, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		return common.Hash{}, fmt.Errorf("POST /direct returned %d: %s", resp.StatusCode, string(respBody))
	}

	var action types.Action
	if err := json.Unmarshal(respBody, &action); err != nil {
		return common.Hash{}, fmt.Errorf("decode action: %w", err)
	}
	return action.Data.ID, nil
}

// --- seed delivery -----------------------------------------------------------

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
	id, err := sendDirect("WALLET", "UPDATE_KEY", ciphertext)
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

// --- HTTP handlers -----------------------------------------------------------

func handleHealth(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, 200, map[string]any{"ok": true, "proxy": proxyURL})
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

	walletAddress, err := deriveWalletAddress(req.User)
	if err != nil {
		writeErr(w, 500, "derive failed: "+err.Error())
		return
	}

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
	pid, err := sendDirect("VAULT", "SET_POLICY", policyJSON)
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
	id, err := sendDirect("VAULT", "ALLOCATE", payload)
	sendMu.Unlock()
	if err != nil {
		writeErr(w, 502, "allocate send failed: "+err.Error())
		return
	}
	respondAction(w, id)
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
	id, err := sendDirect("VAULT", "WITHDRAW", payload)
	sendMu.Unlock()
	if err != nil {
		writeErr(w, 502, "withdraw send failed: "+err.Error())
		return
	}
	respondAction(w, id)
}

func respondAction(w http.ResponseWriter, id common.Hash) {
	status, data, logLine, err := poll(id)
	if err != nil {
		writeErr(w, 502, "poll failed: "+err.Error())
		return
	}
	if status != 1 {
		writeJSON(w, 200, map[string]any{"ok": false, "refused": true, "log": logLine})
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
		"ok": true, "signer": out.Signer, "kind": out.Kind,
		"amount": out.Amount, "destination": out.Destination,
		"digest": out.Digest, "signature": out.Signature,
	})
}

// --- polling -----------------------------------------------------------------

var errResultNotReady = errors.New("action result not ready")

// fetchSubmitResult fetches the result of a direct action. Direct actions use
// the "submit" submission tag. The proxy's result endpoint defaults to
// "threshold", which belongs to the on-chain instruction path and returns 404
// for direct actions unless the tag is supplied explicitly.
func fetchSubmitResult(id common.Hash) (*types.ActionResponse, error) {
	client := http.Client{Timeout: 5 * time.Second}
	resp, err := client.Get(proxyURL + "/action/result/" + id.Hex() + "?submissionTag=submit")
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return nil, err
	}
	if resp.StatusCode == http.StatusNotFound {
		return nil, errResultNotReady
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("action result returned %d: %s", resp.StatusCode, string(body))
	}

	var result types.ActionResponse
	if err := json.Unmarshal(body, &result); err != nil {
		return nil, fmt.Errorf("decode action result: %w", err)
	}
	return &result, nil
}

func poll(id common.Hash) (int, json.RawMessage, string, error) {
	for attempt := 0; attempt < 60; attempt++ {
		if attempt > 0 {
			time.Sleep(time.Second)
		}
		resp, err := fetchSubmitResult(id)
		if err != nil {
			if errors.Is(err, errResultNotReady) {
				continue
			}
			return 0, nil, "", err
		}
		res := resp.Result
		return int(res.Status), json.RawMessage(res.Data), res.Log, nil
	}
	return 0, nil, "", fmt.Errorf("direct action %s not processed after 60s", id.Hex())
}

func deriveWalletAddress(user string) (string, error) {
	seed, err := hex.DecodeString(masterSeedHex)
	if err != nil {
		return "", err
	}
	userBytes := common.HexToAddress(user).Bytes()
	material := append(append([]byte{}, seed...), userBytes...)
	key, err := crypto.ToECDSA(crypto.Keccak256(material))
	if err != nil {
		return "", err
	}
	return crypto.PubkeyToAddress(key.PublicKey).Hex(), nil
}

// --- helpers -----------------------------------------------------------------

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

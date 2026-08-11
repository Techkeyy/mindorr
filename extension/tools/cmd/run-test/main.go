// Command run-test drives the live Mindorr extension through real on-chain
// instructions and validates the results.
//
// Phase 1 (this file): the cheapest real signal — a VAULT/SET_POLICY round-trip.
// It needs no managed key, so it isolates ONE question: does a Mindorr op sent
// on-chain reach the enclave, get handled, and return a retrievable result?
// Once this is green, UPDATE_KEY (encrypted-key delivery) and ALLOCATE (capture
// the enclave signature) are layered on top.
//
// Usage (from tools/, via scripts/test.sh which wires the flags):
//   go run ./cmd/run-test -a <addresses.json> -c <rpc> -p <proxyURL> \
//       -instructionSender <addr>
package main

import (
	"encoding/json"
	"flag"
	"strings"
	"time"

	"extension-scaffold/tools/pkg/configs"
	"extension-scaffold/tools/pkg/fccutils"
	"extension-scaffold/tools/pkg/support"
	instrutils "extension-scaffold/tools/pkg/utils"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/flare-foundation/go-flare-common/pkg/logger"
	"github.com/pkg/errors"
)

// FXRP on Coston2 (verified live, 6 decimals).
const fxrp = "0x0b6A3645c240605887a5532109323A3E12273dc7"

// setPolicyResponse is the SET_POLICY handler's success shape (handlers.ts).
type setPolicyResponse struct {
	Ok            bool   `json:"ok"`
	RiskLevel     string `json:"riskLevel"`
	AllowedVenues int    `json:"allowedVenues"`
}

// policyPayload matches codec.ts parsePolicy exactly. allowedVenues is an array
// of address strings; amounts are base-unit decimal strings.
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

func main() {
	af := flag.String("a", configs.AddressesFile, "file with deployed addresses")
	cf := flag.String("c", configs.ChainNodeURL, "chain node url")
	pf := flag.String("p", configs.ExtensionProxyURL, "extension proxy url")
	instructionSenderF := flag.String("instructionSender", "", "instructionSender address")
	flag.Parse()

	instructionSenderAddress := common.HexToAddress(*instructionSenderF)

	testSupport, err := support.DefaultSupport(*af, *cf)
	if err != nil {
		fccutils.FatalWithCause(err)
	}

	// --- Bind the extension id onto the InstructionSender (idempotent) --------
	logger.Infof("Setting extension ID on instruction sender...")
	err = instrutils.SetExtensionId(testSupport, instructionSenderAddress)
	if err != nil {
		if strings.Contains(err.Error(), "already set") {
			logger.Infof("Extension ID already set, continuing")
		} else {
			fccutils.FatalWithCause(errors.Errorf(
				"setExtensionId failed — is the extension registered (pre-build.sh)? %s", err))
		}
	}

	// --- Phase 1: VAULT/SET_POLICY round-trip --------------------------------
	// The deployer address stands in for the owner and return address here; the
	// point is the round-trip, not the specific policy.
	owner := crypto.PubkeyToAddress(testSupport.Prv.PublicKey).Hex()
	policy := policyPayload{
		Owner:              owner,
		ReturnAddress:      owner,
		RiskLevel:          "conservative",
		Asset:              fxrp,
		AllowedVenues:      []string{"0xa11a000100000000000000000000000000000000"},
		MaxVenueBps:        10000,
		MaxTxAmount:        "1000000000000",
		MinHealthFactorBps: 15000,
	}
	payload, err := json.Marshal(policy)
	if err != nil {
		fccutils.FatalWithCause(err)
	}

	logger.Infof("Sending VAULT/SET_POLICY instruction (owner=%s)...", owner)
	instructionId, txHash, err := instrutils.SendSetPolicy(testSupport, instructionSenderAddress, payload)
	if err != nil {
		fccutils.FatalWithCause(err)
	}
	logger.Infof("Instruction sent. tx=%s id=%s", txHash.Hex(), instructionId.Hex())

	// Give the enclave a moment to pick up and process the instruction.
	time.Sleep(6 * time.Second)

	if err := verifySetPolicy(*pf, instructionId); err != nil {
		fccutils.FatalWithCause(err)
	}
	logger.Infof("Test passed: SET_POLICY processed and result retrieved.")
	logger.Infof("Phase 1 round-trip GREEN — Mindorr ops reach the enclave and return results.")
}

func verifySetPolicy(proxyURL string, instructionId common.Hash) error {
	actionResponse, err := fccutils.ActionResult(proxyURL, instructionId)
	if err != nil {
		return err
	}
	res := actionResponse.Result

	if res.Status == 0 {
		return errors.Errorf("SET_POLICY refused/failed: %s", res.Log)
	}
	if res.Status == 2 {
		return errors.New("SET_POLICY still pending after polling, expected completed")
	}
	if len(res.Data) == 0 {
		return errors.New("expected response data but got none")
	}

	var resp setPolicyResponse
	if err := json.Unmarshal(res.Data, &resp); err != nil {
		return errors.Errorf("failed to unmarshal SET_POLICY response: %s", err)
	}
	if !resp.Ok {
		return errors.Errorf("SET_POLICY returned ok=false: %+v", resp)
	}

	logger.Infof("SET_POLICY response: riskLevel=%s allowedVenues=%d", resp.RiskLevel, resp.AllowedVenues)
	return nil
}

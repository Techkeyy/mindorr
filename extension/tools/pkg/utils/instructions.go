package utils

import (
	"context"
	"math/big"
	"time"

	"extension-scaffold/tools/pkg/contracts/helloworld"
	"extension-scaffold/tools/pkg/fccutils"
	"extension-scaffold/tools/pkg/support"

	"github.com/ethereum/go-ethereum/accounts/abi/bind"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/pkg/errors"
)

// InstructionFee is the value sent with each instruction. Must match the
// registry's required fee, or the send reverts.
var InstructionFee = big.NewInt(1000000)

func DeployInstructionSender(s *support.Support) (common.Address, *helloworld.HelloWorldInstructionSender, error) {
	opts, err := bind.NewKeyedTransactorWithChainID(s.Prv, s.ChainID)
	if err != nil {
		return common.Address{}, nil, errors.Errorf("failed to create transactor: %s", err)
	}

	// Both registry args are the FlareTeeManager diamond proxy: the diamond
	// routes ExtensionManager and MachineManager calls to the right facets.
	address, tx, contract, err := helloworld.DeployHelloWorldInstructionSender(
		opts, s.ChainClient, s.Addresses.FlareTeeManager, s.Addresses.FlareTeeManager,
	)
	if err != nil {
		return common.Address{}, nil, errors.Errorf("failed to deploy contract: %s", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	receipt, err := bind.WaitMined(ctx, s.ChainClient, tx)
	if err != nil {
		return common.Address{}, nil, errors.Errorf("deployment tx not mined within 2 minutes (tx: %s): %s", tx.Hash().Hex(), err)
	}

	if receipt.Status != types.ReceiptStatusSuccessful {
		return common.Address{}, nil, errors.New("contract deployment failed")
	}

	return address, contract, nil
}

func SetExtensionId(s *support.Support, instructionSenderAddress common.Address) error {
	sender, err := helloworld.NewHelloWorldInstructionSender(instructionSenderAddress, s.ChainClient)
	if err != nil {
		return errors.Errorf("failed to bind contract: %s", err)
	}

	opts, err := bind.NewKeyedTransactorWithChainID(s.Prv, s.ChainID)
	if err != nil {
		return errors.Errorf("failed to create transactor: %s", err)
	}

	tx, err := sender.SetExtensionId(opts)
	if err != nil {
		reason := fccutils.DecodeRevertReason(err)
		if reason == "" {
			parsed, _ := helloworld.HelloWorldInstructionSenderMetaData.GetAbi()
			if parsed != nil {
				callData, packErr := parsed.Pack("setExtensionId")
				if packErr == nil {
					from := crypto.PubkeyToAddress(s.Prv.PublicKey)
					reason = fccutils.SimulateAndDecodeRevert(
						s.ChainClient, from, instructionSenderAddress, nil, callData,
					)
				}
			}
		}
		if reason != "" {
			return errors.Errorf("failed to call setExtensionId: %s (revert reason: %s)", err, reason)
		}
		return errors.Errorf("failed to call setExtensionId: %s", err)
	}

	receipt, err := bind.WaitMined(context.Background(), s.ChainClient, tx)
	if err != nil {
		return errors.Errorf("failed waiting for transaction: %s", err)
	}

	if receipt.Status != types.ReceiptStatusSuccessful {
		parsed, _ := helloworld.HelloWorldInstructionSenderMetaData.GetAbi()
		if parsed != nil {
			callData, packErr := parsed.Pack("setExtensionId")
			if packErr == nil {
				from := crypto.PubkeyToAddress(s.Prv.PublicKey)
				reason := fccutils.SimulateAndDecodeRevert(
					s.ChainClient, from, instructionSenderAddress, nil, callData,
				)
				if reason != "" {
					return errors.Errorf("setExtensionId transaction failed (revert reason: %s)", reason)
				}
			}
		}
		return errors.New("setExtensionId transaction failed")
	}

	return nil
}

// --- Mindorr op senders -----------------------------------------------------
//
// Every Mindorr op carries a single `bytes` payload (JSON for the VAULT ops,
// the encrypted key for WALLET/UPDATE_KEY), so one helper covers them all.
// Each returns (instructionId, txHash) — poll the proxy for the result with
// fccutils.ActionResult(proxyURL, instructionId).

// SendUpdateKey delivers the signing key (encrypted to the TEE) via WALLET/UPDATE_KEY.
func SendUpdateKey(s *support.Support, addr common.Address, encryptedKey []byte) (common.Hash, common.Hash, error) {
	return sendBytesOp(s, addr, "sendUpdateKey", encryptedKey, func(sender *helloworld.HelloWorldInstructionSender, o *bind.TransactOpts) (*types.Transaction, error) {
		return sender.SendUpdateKey(o, encryptedKey)
	})
}

// SendCreate derives and reveals a user's managed wallet via WALLET/CREATE.
func SendCreate(s *support.Support, addr common.Address, userJSON []byte) (common.Hash, common.Hash, error) {
	return sendBytesOp(s, addr, "sendCreate", userJSON, func(sender *helloworld.HelloWorldInstructionSender, o *bind.TransactOpts) (*types.Transaction, error) {
		return sender.SendCreate(o, userJSON)
	})
}

// SendSetPolicy sets the owner's policy via VAULT/SET_POLICY. Needs no key.
func SendSetPolicy(s *support.Support, addr common.Address, policyJSON []byte) (common.Hash, common.Hash, error) {
	return sendBytesOp(s, addr, "sendSetPolicy", policyJSON, func(sender *helloworld.HelloWorldInstructionSender, o *bind.TransactOpts) (*types.Transaction, error) {
		return sender.SendSetPolicy(o, policyJSON)
	})
}

// SendAllocate sends a VAULT/ALLOCATE intent; the enclave signs it if the guard allows.
func SendAllocate(s *support.Support, addr common.Address, intentJSON []byte) (common.Hash, common.Hash, error) {
	return sendBytesOp(s, addr, "sendAllocate", intentJSON, func(sender *helloworld.HelloWorldInstructionSender, o *bind.TransactOpts) (*types.Transaction, error) {
		return sender.SendAllocate(o, intentJSON)
	})
}

// SendWithdraw sends a VAULT/WITHDRAW intent; the enclave signs only to the return address.
func SendWithdraw(s *support.Support, addr common.Address, intentJSON []byte) (common.Hash, common.Hash, error) {
	return sendBytesOp(s, addr, "sendWithdraw", intentJSON, func(sender *helloworld.HelloWorldInstructionSender, o *bind.TransactOpts) (*types.Transaction, error) {
		return sender.SendWithdraw(o, intentJSON)
	})
}

// sendBytesOp binds the sender, sends one single-`bytes` instruction with the fee,
// decodes any revert reason, waits for the receipt, and parses the instruction id.
func sendBytesOp(
	s *support.Support,
	addr common.Address,
	fnName string,
	message []byte,
	call func(*helloworld.HelloWorldInstructionSender, *bind.TransactOpts) (*types.Transaction, error),
) (common.Hash, common.Hash, error) {
	sender, err := helloworld.NewHelloWorldInstructionSender(addr, s.ChainClient)
	if err != nil {
		return common.Hash{}, common.Hash{}, errors.Errorf("failed to bind contract: %s", err)
	}

	opts, err := bind.NewKeyedTransactorWithChainID(s.Prv, s.ChainID)
	if err != nil {
		return common.Hash{}, common.Hash{}, errors.Errorf("failed to create transactor: %s", err)
	}
	opts.Value = InstructionFee

	decodeRevert := func() string {
		parsed, _ := helloworld.HelloWorldInstructionSenderMetaData.GetAbi()
		if parsed == nil {
			return ""
		}
		callData, packErr := parsed.Pack(fnName, message)
		if packErr != nil {
			return ""
		}
		from := crypto.PubkeyToAddress(s.Prv.PublicKey)
		return fccutils.SimulateAndDecodeRevert(s.ChainClient, from, addr, InstructionFee, callData)
	}

	tx, err := call(sender, opts)
	if err != nil {
		reason := fccutils.DecodeRevertReason(err)
		if reason == "" {
			reason = decodeRevert()
		}
		if reason != "" {
			return common.Hash{}, common.Hash{}, errors.Errorf("failed to send %s: %s (revert reason: %s)", fnName, err, reason)
		}
		return common.Hash{}, common.Hash{}, errors.Errorf("failed to send %s: %s", fnName, err)
	}

	receipt, err := bind.WaitMined(context.Background(), s.ChainClient, tx)
	if err != nil {
		return common.Hash{}, common.Hash{}, errors.Errorf("failed waiting for transaction: %s", err)
	}
	if receipt.Status != 1 {
		if reason := decodeRevert(); reason != "" {
			return common.Hash{}, common.Hash{}, errors.Errorf("%s transaction failed with status %d (revert reason: %s)", fnName, receipt.Status, reason)
		}
		return common.Hash{}, common.Hash{}, errors.Errorf("%s transaction failed with status: %d", fnName, receipt.Status)
	}
	if len(receipt.Logs) == 0 {
		return common.Hash{}, common.Hash{}, errors.New("no logs found in receipt")
	}

	instructionSent, err := s.TeeVerification.ParseTeeInstructionsSent(*receipt.Logs[0])
	if err != nil {
		return common.Hash{}, common.Hash{}, errors.Errorf("failed to parse TeeInstructionsSent event: %s", err)
	}
	return instructionSent.InstructionId, receipt.TxHash, nil
}

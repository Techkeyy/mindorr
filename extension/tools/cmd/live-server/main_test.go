package main

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/ethereum/go-ethereum/common"
	"github.com/flare-foundation/tee-node/pkg/types"
)

func TestFetchSubmitResultUsesSubmitTag(t *testing.T) {
	id := common.HexToHash("0x1234")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got, want := r.URL.Path, "/action/result/"+id.Hex(); got != want {
			t.Fatalf("path = %q, want %q", got, want)
		}
		if got := r.URL.Query().Get("submissionTag"); got != "submit" {
			t.Fatalf("submissionTag = %q, want submit", got)
		}
		if err := json.NewEncoder(w).Encode(types.ActionResponse{
			Result: types.ActionResult{
				ID:            id,
				SubmissionTag: types.Submit,
				Status:        1,
			},
		}); err != nil {
			t.Fatal(err)
		}
	}))
	defer server.Close()

	oldProxyURL := proxyURL
	proxyURL = server.URL
	defer func() { proxyURL = oldProxyURL }()

	result, err := fetchSubmitResult(id)
	if err != nil {
		t.Fatalf("fetchSubmitResult() error = %v", err)
	}
	if result.Result.ID != id || result.Result.Status != 1 {
		t.Fatalf("unexpected result: %+v", result.Result)
	}
}

func TestFetchSubmitResultNotReady(t *testing.T) {
	server := httptest.NewServer(http.NotFoundHandler())
	defer server.Close()

	oldProxyURL := proxyURL
	proxyURL = server.URL
	defer func() { proxyURL = oldProxyURL }()

	_, err := fetchSubmitResult(common.HexToHash("0x1234"))
	if !errors.Is(err, errResultNotReady) {
		t.Fatalf("error = %v, want errResultNotReady", err)
	}
}

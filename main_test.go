package main

import (
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

func newTestMux(upURL string) http.Handler {
	return newMux(mustURL(nil, upURL), &tunnelManager{})
}

func mustURL(t *testing.T, raw string) *url.URL {
	u, err := url.Parse(raw)
	if err != nil {
		if t == nil {
			panic(err)
		}
		t.Fatal(err)
	}
	return u
}

func TestProxyForwardsAPI(t *testing.T) {
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/health" {
			t.Errorf("upstream 收到路径 %q，期望 /api/v1/health", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"status":"ok"}`)
	}))
	defer up.Close()

	ts := httptest.NewServer(newTestMux(up.URL))
	defer ts.Close()

	resp, err := http.Get(ts.URL + "/api/v1/health")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 || string(body) != `{"status":"ok"}` {
		t.Fatalf("status=%d body=%s", resp.StatusCode, body)
	}
}

func TestUpstreamDownReturns502JSON(t *testing.T) {
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	urlRaw := up.URL
	up.Close() // 立即关闭，制造不可达

	ts := httptest.NewServer(newTestMux(urlRaw))
	defer ts.Close()

	resp, err := http.Get(ts.URL + "/api/v1/nodes")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadGateway {
		t.Fatalf("期望 502，得到 %d", resp.StatusCode)
	}
	if ct := resp.Header.Get("Content-Type"); ct != "application/json; charset=utf-8" {
		t.Fatalf("502 应返回 JSON Content-Type，得到 %q", ct)
	}
}

func TestStaticUIServed(t *testing.T) {
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	defer up.Close()
	ts := httptest.NewServer(newTestMux(up.URL))
	defer ts.Close()

	resp, err := http.Get(ts.URL + "/")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("期望 200，得到 %d", resp.StatusCode)
	}
}

func TestCTLStatusInitial(t *testing.T) {
	ts := httptest.NewServer(newTestMux("http://127.0.0.1:1"))
	defer ts.Close()

	resp, err := http.Get(ts.URL + "/ctl/status")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if !strings.Contains(string(body), `"connected":false`) {
		t.Fatalf("初始状态应 disconnected，得到 %s", body)
	}
}

func TestCTLConnectValidation(t *testing.T) {
	ts := httptest.NewServer(newTestMux("http://127.0.0.1:1"))
	defer ts.Close()

	resp, err := http.Post(ts.URL+"/ctl/connect", "application/json",
		strings.NewReader(`{"host":"203.0.113.9","user":"root","password":""}`))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 400 {
		t.Fatalf("缺密码应 400，得到 %d", resp.StatusCode)
	}
}

package main

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestNeedsTranslation(t *testing.T) {
	cases := []struct {
		name string
		in   string
		lang string
		want bool
	}{
		{"japanese_to_ru", "新作アニメの第3話、作画が神すぎて鳥肌立った…😭✨", "ru", true},
		{"chinese_to_ru", "今天在上海试驾了最新款的电动车！🚗⚡️", "ru", true},
		{"korean_to_ru", "오늘 서울 날씨 진짜 미쳤다 🌸☀️", "ru", true},
		{"english_to_ru", "Just shipped v2.0 of our local engine 🚀", "ru", true},
		{"mixed_ru_en_to_ru", "Зацените новый релиз Apple Silicon GPU!", "ru", true},
		{"pure_ru_to_ru", "Привет мир! Сегодня отличная погода в Москве 😊", "ru", false},
		{"pure_ru_to_en", "Привет мир! Сегодня отличная погода в Москве 😊", "en", true},
		{"ru_with_url_and_mention", "Посмотрите ссылку https://x.com/test @user_123 😊", "ru", false},
		{"spanish_to_en", "Hola amigos!", "en", true},
		{"emoji_and_url_only", "🔥🚀 https://t.co/abc123 @elonmusk", "ru", false},
		{"empty", "   ", "ru", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := needsTranslation(tc.in, tc.lang); got != tc.want {
				t.Fatalf("needsTranslation(%q, %q) = %v, want %v", tc.in, tc.lang, got, tc.want)
			}
		})
	}
}

func TestProtectAndRestoreURLs(t *testing.T) {
	in := "Check this https://example.com/a and https://t.co/xyz now!"
	masked, urls := protectURLs(in)
	if len(urls) != 2 {
		t.Fatalf("expected 2 urls, got %d", len(urls))
	}
	if strings.Contains(masked, "https://") {
		t.Fatalf("masked still contains url: %q", masked)
	}
	restored := restoreURLs("Посмотрите ⟪0⟫ и ⟪1⟫ прямо сейчас!", urls)
	if restored != "Посмотрите https://example.com/a и https://t.co/xyz прямо сейчас!" {
		t.Fatalf("unexpected restored: %q", restored)
	}

	dropped := restoreURLs("Посмотрите прямо сейчас!", []string{"https://t.co/drop"})
	if dropped != "Посмотрите прямо сейчас! https://t.co/drop" {
		t.Fatalf("unexpected fallback restore: %q", dropped)
	}
}

func TestCleanTranslation(t *testing.T) {
	cases := []struct {
		in   string
		want string
	}{
		{"<think>some reasoning</think>\nПеревод:   Привет мир!  ", "Привет мир!"},
		{"Примечание: Модель с 35 миллиардами параметров.", "Модель с 35 миллиардами параметров."},
		{"Note: Перевод на русский: Точный текст", "Точный текст"},
		{"1. Тернарная квантизация.\n\n*Correction: ...*", "1. Тернарная квантизация."},
	}
	for _, tc := range cases {
		if got := cleanTranslation(tc.in); got != tc.want {
			t.Fatalf("cleanTranslation(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

func TestSplitLongLine(t *testing.T) {
	// Should preserve decimals like 55.6 while splitting across sentence boundaries.
	in := "Qwen3.8-27B went from 55.6GB to 5.9GB. That is an 89.4% reduction! How does it work? Very well."
	pieces := splitLongLine(in, 45)
	if len(pieces) < 3 {
		t.Fatalf("expected at least 3 sentence pieces, got %d: %#v", len(pieces), pieces)
	}
	joined := strings.Join(pieces, " ")
	if joined != in {
		t.Fatalf("round-trip mismatch:\ngot:  %q\nwant: %q", joined, in)
	}
}

func TestParseVMStatFreeMB(t *testing.T) {
	sample := `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                    14000.
Pages active:                                 190000.
Pages inactive:                               190000.
Pages speculative:                              1000.
Pages wired down:                             240000.
Pages purgeable:                                5000.`
	got := parseVMStatFreeMB(sample)
	want := ((14000 + 190000 + 1000 + 5000) * 16384) >> 20
	if got != want {
		t.Fatalf("parseVMStatFreeMB = %d, want %d", got, want)
	}
}

func TestOriginGuard(t *testing.T) {
	mgr := NewLlamaManager(ManagerConfig{
		ExePath:   "/bin/false",
		ModelPath: "Ternary-Bonsai-2-2B-Q2_0.gguf",
	})
	h := newHTTPHandler(mgr)

	reqBad := httptest.NewRequest(http.MethodGet, "/status", nil)
	reqBad.Header.Set("Origin", "https://evil.example")
	recBad := httptest.NewRecorder()
	h.ServeHTTP(recBad, reqBad)
	if recBad.Code != http.StatusForbidden {
		t.Fatalf("expected 403 for web origin, got %d", recBad.Code)
	}

	reqExt := httptest.NewRequest(http.MethodGet, "/status", nil)
	reqExt.Header.Set("Origin", "chrome-extension://abcdefghijklmnop")
	recExt := httptest.NewRecorder()
	h.ServeHTTP(recExt, reqExt)
	if recExt.Code != http.StatusOK {
		t.Fatalf("expected 200 for extension origin, got %d", recExt.Code)
	}
	var st StatusInfo
	if err := json.Unmarshal(recExt.Body.Bytes(), &st); err != nil {
		t.Fatal(err)
	}
	if st.MemTotalMB <= 0 || st.MemFreeMB <= 0 {
		t.Fatalf("expected positive macOS memory telemetry in /status, got %+v", st)
	}
}

func TestOnDemandLinePreservingLifecycleAndIdleUnload(t *testing.T) {
	dir := t.TempDir()
	pidFile := filepath.Join(dir, "mock.pid")
	mockScript := filepath.Join(dir, "mock_llama_server.py")
	pyBody := `#!/usr/bin/env python3
import http.server, json, os, signal, sys

port = int(sys.argv[1])
pid_file = sys.argv[2]
with open(pid_file, "w") as f:
    f.write(str(os.getpid()))

class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args): pass
    def do_GET(self):
        if self.path == "/health":
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b'{"status":"ok"}')
            return
        self.send_response(404)
        self.end_headers()
    def do_POST(self):
        length = int(self.headers.get("Content-Length", "0"))
        payload = json.loads(self.rfile.read(length).decode())
        last_user = payload["messages"][-1]["content"]
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        resp = {"choices": [{"message": {"content": "TR:" + last_user}}]}
        self.wfile.write(json.dumps(resp).encode())

def stop(*_):
    sys.exit(0)
signal.signal(signal.SIGTERM, stop)
http.server.HTTPServer(("127.0.0.1", port), Handler).serve_forever()
`
	if err := os.WriteFile(mockScript, []byte(pyBody), 0755); err != nil {
		t.Fatal(err)
	}

	var calls atomic.Int32
	mgr := NewLlamaManager(ManagerConfig{
		ExePath:      "/usr/bin/python3",
		ModelPath:    "Ternary-Bonsai-2-2B-Q2_0.gguf",
		IdleTimeout:  800 * time.Millisecond,
		StartTimeout: 5 * time.Second,
		ArgsBuilder: func(_ string, port int, _ string) []string {
			calls.Add(1)
			return []string{mockScript, strconv.Itoa(port), pidFile}
		},
	})
	defer mgr.Stop()

	// Pure Russian input to target "ru" should NOT spawn the server.
	trRu, freshRu, err := mgr.TranslateTexts(context.Background(), []string{"Привет, это уже русский текст"}, "ru")
	if err != nil {
		t.Fatal(err)
	}
	if freshRu || trRu[0] != "Привет, это уже русский текст" || calls.Load() != 0 {
		t.Fatalf("expected no-op for Russian text, got fresh=%v text=%q calls=%d", freshRu, trRu[0], calls.Load())
	}
	if st := mgr.Status(); st.State != "unloaded" || st.ModelVRAMMB != 0 {
		t.Fatalf("expected unloaded state with 0 VRAM, got %+v", st)
	}

	// Multi-line text should preserve empty lines 1-to-1 and spawn mock llama-server on demand.
	h := newHTTPHandler(mgr)
	body, _ := json.Marshal(translateReqBody{
		Texts:      []string{"First line\n\nSecond line"},
		TargetLang: "ru",
	})
	req := httptest.NewRequest(http.MethodPost, "/translate", bytes.NewReader(body))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d (%s)", rec.Code, rec.Body.String())
	}
	var out translateRespBody
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	if !out.OK || !out.LoadedFresh || len(out.Translations) != 1 || out.Translations[0] != "TR:First line\n\nTR:Second line" {
		t.Fatalf("unexpected translate response: %+v", out)
	}
	if st := mgr.Status(); st.State != "loaded" {
		t.Fatalf("expected loaded state, got %+v", st)
	}

	// Second request hits warm server.
	req2 := httptest.NewRequest(http.MethodPost, "/translate", bytes.NewReader(body))
	rec2 := httptest.NewRecorder()
	h.ServeHTTP(rec2, req2)
	var out2 translateRespBody
	_ = json.Unmarshal(rec2.Body.Bytes(), &out2)
	if out2.LoadedFresh {
		t.Fatalf("expected warm hit (loaded_fresh=false)")
	}

	// Wait past IdleTimeout and assert automatic unload.
	deadline := time.Now().Add(4 * time.Second)
	for time.Now().Before(deadline) {
		if st := mgr.Status(); st.State == "unloaded" && st.ModelVRAMMB == 0 {
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatalf("expected manager to auto-unload after idle timeout, still %+v", mgr.Status())
}

// Local HTTP bridge for the X Downloader Chrome extension.
// Keeps 0 MB VRAM idle and spawns llama-server with Ternary-Bonsai-2-4B-Q2_0.gguf
// strictly on-demand, unloading it automatically after 150 seconds of inactivity.
package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"math"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
	"unicode"
	"unicode/utf8"
)

const (
	defaultAddr        = "127.0.0.1:18791"
	defaultIdleSeconds = 150
	defaultStartWait   = 90 * time.Second
	maxBatchTexts      = 10
	maxLineRunes       = 550
)

var (
	errStopped   = errors.New("запуск локальной модели прерван")
	errBusy      = errors.New("модель сейчас выполняет перевод")
	urlRegex     = regexp.MustCompile(`https?://[^\s]+`)
	mentionRegex = regexp.MustCompile(`@[A-Za-z0-9_]{1,15}`)
	thinkRegex   = regexp.MustCompile(`(?is)<think>.*?</think>`)
	prefixRegex  = regexp.MustCompile(`(?i)^\s*(?:перевод(?:\s+на\s+\S+)?|примечание|заметка|translation|note)\s*:\s*`)
	tokenGapRe   = regexp.MustCompile(`⟪\s*(\d+)\s*⟫`)

	vmPageSizeRe = regexp.MustCompile(`page size of (\d+) bytes`)
	gpuMemRe     = regexp.MustCompile(`"In use system memory"=(\d+)`)
)

var targetLangNames = map[string]string{
	"ru": "Russian",
	"en": "English",
	"de": "German",
	"es": "Spanish",
	"fr": "French",
	"zh": "Simplified Chinese",
	"ja": "Japanese",
	"ko": "Korean",
	"tr": "Turkish",
}

func normalizeTargetLang(code string) (string, string) {
	c := strings.ToLower(strings.TrimSpace(code))
	if name, ok := targetLangNames[c]; ok {
		return c, name
	}
	return "ru", "Russian"
}

type chatMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type chatRequest struct {
	Model       string        `json:"model"`
	Messages    []chatMessage `json:"messages"`
	Temperature float64       `json:"temperature"`
	MaxTokens   int           `json:"max_tokens"`
	Stop        []string      `json:"stop,omitempty"`
}

type chatResponse struct {
	Choices []struct {
		Message *struct {
			Content string `json:"content"`
		} `json:"message"`
	} `json:"choices"`
	Error *struct {
		Message string `json:"message"`
	} `json:"error"`
}

type llamaProc struct {
	cmd     *exec.Cmd
	baseURL string
	apiKey  string
	done    chan struct{}
	err     error
	tail    *tailBuffer
	users   int
	lastUse time.Time
}

type startOp struct {
	p       *llamaProc
	stopped bool
	done    chan struct{}
	err     error
}

type StatusInfo struct {
	OK               bool   `json:"ok"`
	State            string `json:"state"`
	Model            string `json:"model"`
	IdleRemainingSec int    `json:"idle_remaining_sec"`
	IdleTimeoutSec   int    `json:"idle_timeout_sec"`
	ModelFileMB      int    `json:"model_file_mb"`
	ModelVRAMMB      int    `json:"model_vram_mb"`
	MemTotalMB       int    `json:"mem_total_mb"`
	MemFreeMB        int    `json:"mem_free_mb"`
	GPUInUseMB       int    `json:"gpu_in_use_mb"`
}

// ManagerConfig configures LlamaManager.
type ManagerConfig struct {
	ExePath      string
	ModelPath    string
	IdleTimeout  time.Duration
	StartTimeout time.Duration
	ArgsBuilder  func(modelPath string, port int, key string) []string
}

type memSnapshot struct {
	at        time.Time
	memFreeMB int
	gpuUseMB  int
}

// LlamaManager manages an on-demand llama-server child process and unloads it after IdleTimeout.
type LlamaManager struct {
	cfg            ManagerConfig
	httpClient     *http.Client
	modelFileBytes int64
	memTotalMB     int

	memMu   sync.Mutex
	memSnap memSnapshot

	mu       sync.Mutex
	cur      *llamaProc
	starting *startOp
	stopIdle chan struct{}
}

func NewLlamaManager(cfg ManagerConfig) *LlamaManager {
	if cfg.IdleTimeout <= 0 {
		cfg.IdleTimeout = defaultIdleSeconds * time.Second
	}
	if cfg.StartTimeout <= 0 {
		cfg.StartTimeout = defaultStartWait
	}
	if cfg.ArgsBuilder == nil {
		cfg.ArgsBuilder = defaultLlamaArgs
	}
	var modelBytes int64
	if info, err := os.Stat(cfg.ModelPath); err == nil && !info.IsDir() {
		modelBytes = info.Size()
	}
	return &LlamaManager{
		cfg:            cfg,
		modelFileBytes: modelBytes,
		memTotalMB:     readTotalMemMB(),
		httpClient: &http.Client{
			Timeout: 90 * time.Second,
		},
	}
}

func defaultLlamaArgs(modelPath string, port int, key string) []string {
	return []string{
		"-m", modelPath,
		"--host", "127.0.0.1",
		"--port", strconv.Itoa(port),
		"--api-key", key,
		"-c", "4096",
		"-np", "1",
		"--cache-reuse", "64",
		"--no-webui",
		"--jinja",
		"--reasoning", "off",
		"-ngl", "999",
		"-fa", "on",
	}
}

func resolveRuntimePath() (string, error) {
	if p := strings.TrimSpace(os.Getenv("XVD_LLAMA_SERVER")); p != "" {
		if info, err := os.Stat(p); err == nil && !info.IsDir() {
			return p, nil
		}
		return "", fmt.Errorf("XVD_LLAMA_SERVER not found at %s", p)
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	candidates := []string{
		filepath.Join(home, "rugrab-mac-packs", "llm-runtime-macos", "v2", "llama-server"),
		filepath.Join(home, "Library", "Application Support", "RuGrab", "Models", "llm-runtime", "v2", "llama-server"),
	}
	for _, c := range candidates {
		if info, err := os.Stat(c); err == nil && !info.IsDir() {
			return c, nil
		}
	}
	return "", fmt.Errorf("llama-server not found in %v", candidates)
}

func resolveModelPath() (string, error) {
	if p := strings.TrimSpace(os.Getenv("XVD_MODEL_PATH")); p != "" {
		if info, err := os.Stat(p); err == nil && !info.IsDir() {
			return p, nil
		}
		return "", fmt.Errorf("XVD_MODEL_PATH not found at %s", p)
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	candidates := []string{
		filepath.Join(home, "rugrab-mac-packs", "llm-bonsai2-4b", "v1", "Ternary-Bonsai-2-4B-Q2_0.gguf"),
		filepath.Join(home, "Library", "Application Support", "RuGrab", "Models", "llm-bonsai2-4b", "v1", "Ternary-Bonsai-2-4B-Q2_0.gguf"),
		filepath.Join(home, "rugrab-mac-packs", "llm-bonsai2-2b", "v1", "Ternary-Bonsai-2-2B-Q2_0.gguf"),
		filepath.Join(home, "Library", "Application Support", "RuGrab", "Models", "llm-bonsai2-2b", "v1", "Ternary-Bonsai-2-2B-Q2_0.gguf"),
	}
	for _, c := range candidates {
		if info, err := os.Stat(c); err == nil && !info.IsDir() {
			return c, nil
		}
	}
	return "", fmt.Errorf("Bonsai-2 4B model not found in %v", candidates)
}

// Acquire returns a healthy llama-server base URL and API key, launching it on demand if unloaded.
func (m *LlamaManager) Acquire(ctx context.Context) (baseURL, apiKey string, loadedFresh bool, release func(), err error) {
	m.mu.Lock()
	for {
		if err := ctx.Err(); err != nil {
			m.mu.Unlock()
			return "", "", false, nil, err
		}
		if op := m.starting; op != nil {
			m.mu.Unlock()
			select {
			case <-op.done:
			case <-ctx.Done():
				return "", "", false, nil, ctx.Err()
			}
			if op.err != nil && !errors.Is(op.err, context.Canceled) && !errors.Is(op.err, context.DeadlineExceeded) {
				return "", "", false, nil, op.err
			}
			m.mu.Lock()
			continue
		}
		if m.cur != nil {
			select {
			case <-m.cur.done:
				m.clearLocked()
			default:
			}
		}
		if m.cur != nil {
			break
		}
		if err := m.startLocked(ctx); err != nil {
			m.mu.Unlock()
			return "", "", false, nil, err
		}
		loadedFresh = true
	}

	p := m.cur
	p.users++
	p.lastUse = time.Now()
	baseURL = p.baseURL
	apiKey = p.apiKey
	m.mu.Unlock()

	var once sync.Once
	release = func() {
		once.Do(func() {
			m.mu.Lock()
			p.users--
			p.lastUse = time.Now()
			m.mu.Unlock()
		})
	}
	return baseURL, apiKey, loadedFresh, release, nil
}

// Status reports current VRAM residency, remaining idle seconds, and host memory telemetry.
func (m *LlamaManager) Status() StatusInfo {
	timeoutSec := int(m.cfg.IdleTimeout.Seconds())
	modelName := filepath.Base(m.cfg.ModelPath)
	modelFileMB := int(m.modelFileBytes >> 20)

	m.mu.Lock()
	state := "unloaded"
	rem := 0
	pid := 0

	if m.starting != nil {
		state = "loading"
		rem = timeoutSec
		if m.starting.p != nil && m.starting.p.cmd != nil && m.starting.p.cmd.Process != nil {
			pid = m.starting.p.cmd.Process.Pid
		}
	} else if m.cur != nil {
		state = "loaded"
		if m.cur.users > 0 {
			rem = timeoutSec
		} else {
			left := m.cfg.IdleTimeout - time.Since(m.cur.lastUse)
			if left > 0 {
				rem = int(math.Ceil(left.Seconds()))
			}
		}
		if m.cur.cmd != nil && m.cur.cmd.Process != nil {
			pid = m.cur.cmd.Process.Pid
		}
	}
	m.mu.Unlock()

	memFreeMB, gpuUseMB, modelVRAMMB := m.collectMemStats(pid, state != "unloaded", modelFileMB)

	return StatusInfo{
		OK:               true,
		State:            state,
		Model:            modelName,
		IdleRemainingSec: rem,
		IdleTimeoutSec:   timeoutSec,
		ModelFileMB:      modelFileMB,
		ModelVRAMMB:      modelVRAMMB,
		MemTotalMB:       m.memTotalMB,
		MemFreeMB:        memFreeMB,
		GPUInUseMB:       gpuUseMB,
	}
}

func (m *LlamaManager) collectMemStats(pid int, active bool, modelFileMB int) (memFreeMB, gpuUseMB, modelVRAMMB int) {
	m.memMu.Lock()
	snap := m.memSnap
	stale := snap.at.IsZero() || time.Since(snap.at) >= time.Second
	m.memMu.Unlock()

	if stale {
		freeMB := readFreeMemMB()
		gpuMB := readGPUInUseMB()
		m.memMu.Lock()
		m.memSnap = memSnapshot{
			at:        time.Now(),
			memFreeMB: freeMB,
			gpuUseMB:  gpuMB,
		}
		snap = m.memSnap
		m.memMu.Unlock()
	}

	if active {
		if pid > 0 {
			modelVRAMMB = readProcessRSSMB(pid)
		}
		if modelFileMB > modelVRAMMB {
			modelVRAMMB = modelFileMB
		}
	}
	return snap.memFreeMB, snap.gpuUseMB, modelVRAMMB
}

func readTotalMemMB() int {
	ctx, cancel := context.WithTimeout(context.Background(), 1500*time.Millisecond)
	defer cancel()
	out, err := exec.CommandContext(ctx, "sysctl", "-n", "hw.memsize").Output()
	if err != nil {
		return 0
	}
	bytesVal, err := strconv.ParseInt(strings.TrimSpace(string(out)), 10, 64)
	if err != nil || bytesVal <= 0 {
		return 0
	}
	return int(bytesVal >> 20)
}

func readFreeMemMB() int {
	ctx, cancel := context.WithTimeout(context.Background(), 1500*time.Millisecond)
	defer cancel()
	out, err := exec.CommandContext(ctx, "vm_stat").Output()
	if err != nil {
		return 0
	}
	return parseVMStatFreeMB(string(out))
}

func parseVMStatFreeMB(raw string) int {
	var pageSize int64 = 16384
	if m := vmPageSizeRe.FindStringSubmatch(raw); len(m) == 2 {
		if v, err := strconv.ParseInt(m[1], 10, 64); err == nil && v > 0 {
			pageSize = v
		}
	}
	var freePages int64
	for _, line := range strings.Split(raw, "\n") {
		colon := strings.IndexByte(line, ':')
		if colon <= 0 {
			continue
		}
		key := strings.TrimSpace(line[:colon])
		switch key {
		case "Pages free", "Pages inactive", "Pages speculative", "Pages purgeable":
			valStr := strings.TrimSpace(strings.TrimSuffix(strings.TrimSpace(line[colon+1:]), "."))
			if v, err := strconv.ParseInt(valStr, 10, 64); err == nil && v > 0 {
				freePages += v
			}
		}
	}
	return int((freePages * pageSize) >> 20)
}

func readGPUInUseMB() int {
	ctx, cancel := context.WithTimeout(context.Background(), 1500*time.Millisecond)
	defer cancel()
	out, err := exec.CommandContext(ctx, "ioreg", "-r", "-d", "1", "-c", "AGXAccelerator").Output()
	if err != nil {
		return 0
	}
	m := gpuMemRe.FindStringSubmatch(string(out))
	if len(m) != 2 {
		return 0
	}
	bytesVal, err := strconv.ParseInt(m[1], 10, 64)
	if err != nil || bytesVal <= 0 {
		return 0
	}
	return int(bytesVal >> 20)
}

func readProcessRSSMB(pid int) int {
	ctx, cancel := context.WithTimeout(context.Background(), 1000*time.Millisecond)
	defer cancel()
	out, err := exec.CommandContext(ctx, "ps", "-o", "rss=", "-p", strconv.Itoa(pid)).Output()
	if err != nil {
		return 0
	}
	kb, err := strconv.ParseInt(strings.TrimSpace(string(out)), 10, 64)
	if err != nil || kb <= 0 {
		return 0
	}
	return int(kb >> 10)
}

// UnloadIfIdle stops llama-server only if no translation is actively running or loading.
func (m *LlamaManager) UnloadIfIdle() error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.starting != nil {
		return errBusy
	}
	if m.cur != nil && m.cur.users > 0 {
		return errBusy
	}
	m.stopLocked()
	return nil
}

// Stop terminates any running or loading llama-server process and waits for exit.
func (m *LlamaManager) Stop() {
	m.mu.Lock()
	op := m.starting
	if op != nil {
		op.stopped = true
		if op.p != nil && op.p.cmd.Process != nil {
			_ = op.p.cmd.Process.Signal(syscall.SIGTERM)
		}
	}
	m.stopLocked()
	m.mu.Unlock()

	if op != nil {
		select {
		case <-op.done:
		case <-time.After(6 * time.Second):
			if op.p != nil && op.p.cmd.Process != nil {
				_ = op.p.cmd.Process.Kill()
			}
		}
	}
}

func (m *LlamaManager) startLocked(ctx context.Context) error {
	op := &startOp{done: make(chan struct{})}
	m.starting = op
	m.mu.Unlock()

	p, err := m.launch(ctx, op)

	m.mu.Lock()
	m.starting = nil
	if err == nil && op.stopped {
		err = errStopped
	}
	if err == nil {
		select {
		case <-p.done:
			err = fmt.Errorf("llama-server exited immediately: %s", lastNonEmptyLine(p.tail.String()))
		default:
		}
	}
	if err != nil && p != nil {
		m.mu.Unlock()
		terminateAndWait(p)
		m.mu.Lock()
	}
	if err == nil {
		p.lastUse = time.Now()
		m.cur = p
		stop := make(chan struct{})
		m.stopIdle = stop
		go m.idleLoop(stop)
		log.Printf("llama-server loaded on %s (idle timeout %s)", p.baseURL, m.cfg.IdleTimeout)
	}
	op.err = err
	close(op.done)
	return err
}

func (m *LlamaManager) launch(ctx context.Context, op *startOp) (*llamaProc, error) {
	port, err := freePort()
	if err != nil {
		return nil, fmt.Errorf("не удалось выбрать свободный порт: %w", err)
	}
	key := randomHex(16)
	args := m.cfg.ArgsBuilder(m.cfg.ModelPath, port, key)
	cmd := exec.Command(m.cfg.ExePath, args...)
	// Critical on macOS: llama-server looks up libggml-metal and libllama dylibs in cwd.
	cmd.Dir = filepath.Dir(m.cfg.ExePath)
	tail := &tailBuffer{max: 16 << 10}
	cmd.Stdout = tail
	cmd.Stderr = tail

	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("не удалось запустить llama-server: %w", err)
	}

	p := &llamaProc{
		cmd:     cmd,
		baseURL: "http://127.0.0.1:" + strconv.Itoa(port) + "/v1",
		apiKey:  key,
		done:    make(chan struct{}),
		tail:    tail,
	}
	go m.reap(p)

	m.mu.Lock()
	op.p = p
	stopped := op.stopped
	m.mu.Unlock()
	if stopped {
		terminateAndWait(p)
		return nil, errStopped
	}

	healthURL := "http://127.0.0.1:" + strconv.Itoa(port) + "/health"
	if err := m.waitHealthy(ctx, healthURL, key, p); err != nil {
		terminateAndWait(p)
		m.mu.Lock()
		stopped := op.stopped
		m.mu.Unlock()
		if stopped && ctx.Err() == nil {
			return nil, errStopped
		}
		return nil, err
	}
	return p, nil
}

func (m *LlamaManager) waitHealthy(ctx context.Context, healthURL, key string, p *llamaProc) error {
	deadline := time.Now().Add(m.cfg.StartTimeout)
	hc := &http.Client{Timeout: 2 * time.Second}
	for {
		req, _ := http.NewRequestWithContext(ctx, http.MethodGet, healthURL, nil)
		req.Header.Set("Authorization", "Bearer "+key)
		if resp, err := hc.Do(req); err == nil {
			_, _ = io.Copy(io.Discard, resp.Body)
			resp.Body.Close()
			if resp.StatusCode == http.StatusOK {
				return nil
			}
		}
		select {
		case <-p.done:
			msg := lastNonEmptyLine(p.tail.String())
			if msg == "" {
				msg = "неизвестная ошибка"
			}
			return fmt.Errorf("llama-server завершился при запуске: %s", msg)
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(100 * time.Millisecond):
		}
		if time.Now().After(deadline) {
			return errors.New("таймаут загрузки модели Bonsai-2 4B в видеопамять")
		}
	}
}

func (m *LlamaManager) reap(p *llamaProc) {
	p.err = p.cmd.Wait()
	close(p.done)
	m.mu.Lock()
	if m.cur == p {
		m.clearLocked()
	}
	m.mu.Unlock()
}

// stopLocked terminates m.cur and releases m.mu while waiting for exit.
func (m *LlamaManager) stopLocked() {
	p := m.cur
	if p == nil {
		return
	}
	m.clearLocked()
	m.mu.Unlock()
	terminateAndWait(p)
	m.mu.Lock()
	log.Printf("llama-server unloaded from VRAM")
}

func (m *LlamaManager) clearLocked() {
	m.cur = nil
	if m.stopIdle != nil {
		close(m.stopIdle)
		m.stopIdle = nil
	}
}

func (m *LlamaManager) idleLoop(stop chan struct{}) {
	interval := m.cfg.IdleTimeout / 5
	if interval > 5*time.Second {
		interval = 5 * time.Second
	}
	if interval < 200*time.Millisecond {
		interval = 200 * time.Millisecond
	}
	tick := time.NewTicker(interval)
	defer tick.Stop()

	for {
		select {
		case <-stop:
			return
		case <-tick.C:
		}
		m.mu.Lock()
		if m.stopIdle == stop && m.cur != nil && m.cur.users == 0 && time.Since(m.cur.lastUse) >= m.cfg.IdleTimeout {
			m.stopLocked()
			m.mu.Unlock()
			return
		}
		m.mu.Unlock()
	}
}

func terminateAndWait(p *llamaProc) {
	if p == nil || p.cmd.Process == nil {
		return
	}
	_ = p.cmd.Process.Signal(syscall.SIGTERM)
	select {
	case <-p.done:
		return
	case <-time.After(3 * time.Second):
	}
	_ = p.cmd.Process.Kill()
	select {
	case <-p.done:
	case <-time.After(2 * time.Second):
	}
}

func freePort() (int, error) {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, err
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port, nil
}

func randomHex(nBytes int) string {
	b := make([]byte, nBytes)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func lastNonEmptyLine(s string) string {
	lines := strings.Split(strings.ReplaceAll(s, "\r", ""), "\n")
	for i := len(lines) - 1; i >= 0; i-- {
		t := strings.TrimSpace(lines[i])
		if t != "" {
			if len(t) > 200 {
				return t[:200]
			}
			return t
		}
	}
	return ""
}

type tailBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
	max int
}

func (t *tailBuffer) Write(p []byte) (int, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.buf.Write(p)
	if over := t.buf.Len() - t.max; over > 0 {
		t.buf.Next(over)
	}
	return len(p), nil
}

func (t *tailBuffer) String() string {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.buf.String()
}

// needsTranslation returns false if text has no letters outside URLs/@mentions, or if targetLang is
// "ru" and 100% of letters are already Russian Cyrillic.
func needsTranslation(s, targetLang string) bool {
	code, _ := normalizeTargetLang(targetLang)
	stripped := urlRegex.ReplaceAllString(s, " ")
	stripped = mentionRegex.ReplaceAllString(stripped, " ")
	letters := 0
	russian := 0
	for _, r := range stripped {
		if !unicode.IsLetter(r) {
			continue
		}
		letters++
		if (r >= 'а' && r <= 'я') || (r >= 'А' && r <= 'Я') || r == 'ё' || r == 'Ё' {
			russian++
		}
	}
	if letters == 0 {
		return false
	}
	if code == "ru" {
		return russian < letters
	}
	return true
}

// protectURLs replaces URLs with ⟪i⟫ placeholders so the model never corrupts links.
func protectURLs(s string) (string, []string) {
	var urls []string
	masked := urlRegex.ReplaceAllStringFunc(s, func(u string) string {
		tag := fmt.Sprintf("⟪%d⟫", len(urls))
		urls = append(urls, u)
		return tag
	})
	return masked, urls
}

// restoreURLs puts extracted URLs back into placeholders and re-appends any dropped ones.
func restoreURLs(translated string, urls []string) string {
	if len(urls) == 0 {
		return translated
	}
	used := make([]bool, len(urls))
	out := tokenGapRe.ReplaceAllStringFunc(translated, func(tok string) string {
		m := tokenGapRe.FindStringSubmatch(tok)
		if len(m) != 2 {
			return tok
		}
		idx, err := strconv.Atoi(m[1])
		if err != nil || idx < 0 || idx >= len(urls) {
			return tok
		}
		used[idx] = true
		return urls[idx]
	})
	var missing []string
	for i, u := range urls {
		if !used[i] && !strings.Contains(out, u) {
			missing = append(missing, u)
		}
	}
	if len(missing) > 0 {
		out = strings.TrimSpace(out)
		if out != "" {
			out += " "
		}
		out += strings.Join(missing, " ")
	}
	return out
}

// splitLongLine splits a single long paragraph into <=maxRunes pieces along sentence boundaries.
func splitLongLine(line string, maxRunes int) []string {
	line = strings.TrimSpace(line)
	if line == "" || utf8.RuneCountInString(line) <= maxRunes {
		return []string{line}
	}

	var sentences []string
	runes := []rune(line)
	start := 0
	for i := 0; i < len(runes); i++ {
		r := runes[i]
		isEnd := (r == '.' || r == '!' || r == '?' || r == '。' || r == '！' || r == '？')
		if !isEnd {
			continue
		}
		// Keep decimal numbers like 55.6 intact
		if r == '.' && i+1 < len(runes) && unicode.IsDigit(runes[i+1]) {
			continue
		}
		if i+1 < len(runes) && !unicode.IsSpace(runes[i+1]) && r != '。' && r != '！' && r != '？' {
			continue
		}
		part := strings.TrimSpace(string(runes[start : i+1]))
		if part != "" {
			sentences = append(sentences, part)
		}
		start = i + 1
	}
	if start < len(runes) {
		if tail := strings.TrimSpace(string(runes[start:])); tail != "" {
			sentences = append(sentences, tail)
		}
	}
	if len(sentences) == 0 {
		sentences = []string{line}
	}

	var out []string
	var cur strings.Builder
	curRunes := 0
	flush := func() {
		if cur.Len() > 0 {
			out = append(out, cur.String())
			cur.Reset()
			curRunes = 0
		}
	}

	for _, sent := range sentences {
		sr := utf8.RuneCountInString(sent)
		if sr > maxRunes {
			flush()
			words := strings.Fields(sent)
			for _, w := range words {
				wr := utf8.RuneCountInString(w)
				if curRunes > 0 && curRunes+1+wr > maxRunes {
					flush()
				}
				if wr > maxRunes {
					flush()
					wRunes := []rune(w)
					for j := 0; j < len(wRunes); j += maxRunes {
						out = append(out, string(wRunes[j:min(j+maxRunes, len(wRunes))]))
					}
					continue
				}
				if cur.Len() > 0 {
					cur.WriteByte(' ')
					curRunes++
				}
				cur.WriteString(w)
				curRunes += wr
			}
			flush()
			continue
		}
		if curRunes > 0 && curRunes+1+sr > maxRunes {
			flush()
		}
		if cur.Len() > 0 {
			cur.WriteByte(' ')
			curRunes++
		}
		cur.WriteString(sent)
		curRunes += sr
	}
	flush()
	if len(out) == 0 {
		return []string{line}
	}
	return out
}

func cleanTranslation(s string) string {
	s = thinkRegex.ReplaceAllString(s, "")
	s = strings.TrimSpace(s)
	if strings.Contains(s, "\n") {
		for _, line := range strings.Split(s, "\n") {
			trimmed := strings.TrimSpace(line)
			if trimmed != "" {
				s = trimmed
				break
			}
		}
	}
	for {
		next := prefixRegex.ReplaceAllString(s, "")
		if next == s {
			break
		}
		s = strings.TrimSpace(next)
	}
	return strings.TrimSpace(s)
}

func buildPromptMessages(maskedPiece, targetLang string) []chatMessage {
	code, langName := normalizeTargetLang(targetLang)
	if code == "ru" {
		sysPrompt := "You are an accurate translator into Russian. Translate each user line into natural, grammatically correct Russian using Cyrillic script (keep Latin only for brand/model names like Qwen, Bonsai, PrismML, NVIDIA, RTX, VRAM, FP16). Translate questions as questions — never answer them. Output ONLY the single translated line."
		return []chatMessage{
			{Role: "system", Content: sysPrompt},
			{
				Role:    "user",
				Content: "A 35-billion-parameter model has reportedly gone from a 70GB checkpoint to just 8GB while retaining 98% of its benchmark performance. 🚀",
			},
			{
				Role:    "assistant",
				Content: "Модель с 35 миллиардами параметров, по сообщениям, сжалась с чекпоинта 70 ГБ всего до 8 ГБ, сохранив 98% производительности в бенчмарках. 🚀",
			},
			{
				Role:    "user",
				Content: "1. Does ternary quantization change storage requirements?",
			},
			{
				Role:    "assistant",
				Content: "1. Меняет ли тернарная квантизация требования к хранению данных?",
			},
			{
				Role:    "user",
				Content: "この映画のラスト、マジで鳥肌立った…🎬🔥",
			},
			{
				Role:    "assistant",
				Content: "От концовки этого фильма реально побежали мурашки…🎬🔥",
			},
			{Role: "user", Content: maskedPiece},
		}
	}

	sysPrompt := fmt.Sprintf(
		"You are an accurate translator into %s. Translate each user line into natural, grammatically correct %s. "+
			"Translate questions as questions — never answer them. Never add notes or explanations. Output ONLY the single translated line.",
		langName, langName,
	)
	return []chatMessage{
		{Role: "system", Content: sysPrompt},
		{Role: "user", Content: maskedPiece},
	}
}

func (m *LlamaManager) translatePiece(ctx context.Context, baseURL, apiKey, piece, targetLang string) (string, error) {
	masked, urls := protectURLs(piece)
	if !needsTranslation(masked, targetLang) {
		return piece, nil
	}

	msgs := buildPromptMessages(masked, targetLang)
	runes := utf8.RuneCountInString(masked)
	maxTok := min(1024, max(128, runes*3+64))

	payload, err := json.Marshal(chatRequest{
		Model:       "local",
		Messages:    msgs,
		Temperature: 0.0,
		MaxTokens:   maxTok,
		Stop:        []string{"\n"},
	})
	if err != nil {
		return "", err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, baseURL+"/chat/completions", bytes.NewReader(payload))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	if apiKey != "" {
		req.Header.Set("Authorization", "Bearer "+apiKey)
	}

	resp, err := m.httpClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("ошибка связи с llama-server: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return "", err
	}
	if resp.StatusCode/100 != 2 {
		return "", fmt.Errorf("llama-server вернул HTTP %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}

	var cr chatResponse
	if err := json.Unmarshal(body, &cr); err != nil {
		return "", fmt.Errorf("некорректный JSON от llama-server: %w", err)
	}
	if cr.Error != nil && cr.Error.Message != "" {
		return "", fmt.Errorf("ошибка модели: %s", cr.Error.Message)
	}
	if len(cr.Choices) == 0 || cr.Choices[0].Message == nil {
		return "", errors.New("модель вернула пустой ответ")
	}

	out := cleanTranslation(cr.Choices[0].Message.Content)
	out = restoreURLs(out, urls)
	if out == "" {
		return piece, nil
	}
	return out, nil
}

func (m *LlamaManager) TranslateTexts(ctx context.Context, texts []string, targetLang string) (translations []string, loadedFresh bool, err error) {
	langCode, _ := normalizeTargetLang(targetLang)
	translations = make([]string, len(texts))
	needIdx := make([]int, 0, len(texts))
	for i, t := range texts {
		if !needsTranslation(t, langCode) {
			translations[i] = t
			continue
		}
		needIdx = append(needIdx, i)
	}
	if len(needIdx) == 0 {
		return translations, false, nil
	}

	baseURL, apiKey, fresh, release, err := m.Acquire(ctx)
	if err != nil {
		return nil, false, err
	}
	defer release()

	for _, idx := range needIdx {
		lines := strings.Split(texts[idx], "\n")
		outLines := make([]string, len(lines))
		for li, line := range lines {
			if strings.TrimSpace(line) == "" || !needsTranslation(line, langCode) {
				outLines[li] = line
				continue
			}
			pieces := splitLongLine(line, maxLineRunes)
			outPieces := make([]string, 0, len(pieces))
			for _, piece := range pieces {
				tr, err := m.translatePiece(ctx, baseURL, apiKey, piece, langCode)
				if err != nil {
					return nil, fresh, err
				}
				outPieces = append(outPieces, tr)
			}
			outLines[li] = strings.Join(outPieces, " ")
		}
		translations[idx] = strings.Join(outLines, "\n")
	}
	return translations, fresh, nil
}

type translateReqBody struct {
	Texts      []string `json:"texts"`
	TargetLang string   `json:"target_lang"`
}

type translateRespBody struct {
	OK           bool     `json:"ok"`
	Translations []string `json:"translations,omitempty"`
	LoadedFresh  bool     `json:"loaded_fresh"`
	ElapsedMs    int64    `json:"elapsed_ms"`
	Error        string   `json:"error,omitempty"`
}

func newHTTPHandler(mgr *LlamaManager) http.Handler {
	mux := http.NewServeMux()

	mux.HandleFunc("/status", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"ok": false, "error": "method not allowed"})
			return
		}
		writeJSON(w, http.StatusOK, mgr.Status())
	})

	mux.HandleFunc("/unload", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"ok": false, "error": "method not allowed"})
			return
		}
		if err := mgr.UnloadIfIdle(); err != nil {
			status := http.StatusInternalServerError
			if errors.Is(err, errBusy) {
				status = http.StatusConflict
			}
			writeJSON(w, status, map[string]any{"ok": false, "error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, mgr.Status())
	})

	mux.HandleFunc("/translate", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeJSON(w, http.StatusMethodNotAllowed, translateRespBody{OK: false, Error: "method not allowed"})
			return
		}
		r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
		var req translateReqBody
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeJSON(w, http.StatusBadRequest, translateRespBody{OK: false, Error: "некорректный запрос"})
			return
		}
		if len(req.Texts) == 0 || len(req.Texts) > maxBatchTexts {
			writeJSON(w, http.StatusBadRequest, translateRespBody{OK: false, Error: fmt.Sprintf("ожидается от 1 до %d текстов", maxBatchTexts)})
			return
		}

		start := time.Now()
		translations, loadedFresh, err := mgr.TranslateTexts(r.Context(), req.Texts, req.TargetLang)
		elapsed := time.Since(start).Milliseconds()
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, translateRespBody{
				OK:          false,
				LoadedFresh: loadedFresh,
				ElapsedMs:   elapsed,
				Error:       err.Error(),
			})
			return
		}
		writeJSON(w, http.StatusOK, translateRespBody{
			OK:           true,
			Translations: translations,
			LoadedFresh:  loadedFresh,
			ElapsedMs:    elapsed,
		})
	})

	return originGuardMiddleware(mux)
}

func originGuardMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if origin != "" && !strings.HasPrefix(origin, "chrome-extension://") {
			writeJSON(w, http.StatusForbidden, map[string]any{"ok": false, "error": "forbidden origin"})
			return
		}
		if origin != "" {
			w.Header().Set("Access-Control-Allow-Origin", origin)
		} else {
			w.Header().Set("Access-Control-Allow-Origin", "*")
		}
		w.Header().Set("Vary", "Origin")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		w.Header().Set("Access-Control-Allow-Private-Network", "true")

		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func main() {
	addr := strings.TrimSpace(os.Getenv("XVD_ADDR"))
	if addr == "" {
		addr = defaultAddr
	}
	idleSec := defaultIdleSeconds
	if raw := strings.TrimSpace(os.Getenv("XVD_IDLE_SECONDS")); raw != "" {
		if n, err := strconv.Atoi(raw); err == nil && n > 0 {
			idleSec = n
		}
	}

	exePath, err := resolveRuntimePath()
	if err != nil {
		log.Fatal(err)
	}
	modelPath, err := resolveModelPath()
	if err != nil {
		log.Fatal(err)
	}

	mgr := NewLlamaManager(ManagerConfig{
		ExePath:     exePath,
		ModelPath:   modelPath,
		IdleTimeout: time.Duration(idleSec) * time.Second,
	})

	srv := &http.Server{
		Addr:              addr,
		Handler:           newHTTPHandler(mgr),
		ReadHeaderTimeout: 5 * time.Second,
		WriteTimeout:      120 * time.Second,
	}

	sigCh := make(chan os.Signal, 2)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		<-sigCh
		log.Printf("shutting down bridge and llama-server...")
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = srv.Shutdown(ctx)
		mgr.Stop()
	}()

	log.Printf("xvd-translate-bridge listening on http://%s (model=%s, idle=%ds, 0 MB VRAM until translate click)", addr, filepath.Base(modelPath), idleSec)
	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		mgr.Stop()
		log.Fatal(err)
	}
	mgr.Stop()
}

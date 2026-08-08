package main

import (
	"bufio"
	"bytes"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/pkg/sftp"
	"golang.org/x/crypto/ssh"
)

type request struct {
	RequestID string          `json:"requestId"`
	Type      string          `json:"type"`
	Payload   json.RawMessage `json:"payload"`
}

type response struct {
	RequestID string         `json:"requestId"`
	OK        bool           `json:"ok"`
	Payload   any            `json:"payload,omitempty"`
	Error     *responseError `json:"error,omitempty"`
}

type responseError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

type connectPayload struct {
	Profile struct {
		Host           string `json:"host"`
		Port           int    `json:"port"`
		Username       string `json:"username"`
		PrivateKeyPath string `json:"privateKeyPath"`
	} `json:"profile"`
	UserConsent bool `json:"userConsent"`
}

type trustHostPayload struct {
	Host        string `json:"host"`
	Fingerprint string `json:"fingerprint"`
}

type executePayload struct {
	Command string `json:"command"`
}

type listDirectoryPayload struct {
	Path string `json:"path"`
}

type fileEntry struct {
	Name       string `json:"name"`
	Path       string `json:"path"`
	IsDir      bool   `json:"isDirectory"`
	Size       int64  `json:"size"`
	ModifiedAt string `json:"modifiedAt"`
	Perms      string `json:"permissions"`
}

type knownHostsStore struct {
	Hosts map[string]string `json:"hosts"`
}

type companion struct {
	sshClient  *ssh.Client
	sftpClient *sftp.Client

	knownHostsPath string
	knownHosts     knownHostsStore
	mu             sync.Mutex
}

func main() {
	storePath, err := resolveKnownHostsPath()
	if err != nil {
		panic(err)
	}

	c := &companion{knownHostsPath: storePath, knownHosts: knownHostsStore{Hosts: map[string]string{}}}
	if err := c.loadKnownHosts(); err != nil {
		_ = writeMessage(os.Stdout, fail("", "UNKNOWN", err.Error()))
	}

	for {
		req, err := readMessage(os.Stdin)
		if err != nil {
			if errors.Is(err, io.EOF) {
				return
			}
			_ = writeMessage(os.Stdout, fail("", "UNKNOWN", err.Error()))
			continue
		}

		res := c.handle(req)
		_ = writeMessage(os.Stdout, res)
	}
}

func (c *companion) handle(req request) response {
	switch req.Type {
	case "connect":
		var payload connectPayload
		if err := json.Unmarshal(req.Payload, &payload); err != nil {
			return fail(req.RequestID, "UNKNOWN", "Invalid connect payload")
		}
		if err := c.connect(payload); err != nil {
			return mapError(req.RequestID, err)
		}
		return ok(req.RequestID, map[string]string{"status": "connected"})
	case "trust-host":
		var payload trustHostPayload
		if err := json.Unmarshal(req.Payload, &payload); err != nil {
			return fail(req.RequestID, "UNKNOWN", "Invalid trust payload")
		}
		if err := c.trustHost(payload.Host, payload.Fingerprint); err != nil {
			return mapError(req.RequestID, err)
		}
		return ok(req.RequestID, map[string]string{"status": "trusted"})
	case "disconnect":
		_ = c.disconnect()
		return ok(req.RequestID, map[string]string{"status": "disconnected"})
	case "execute-command":
		var payload executePayload
		if err := json.Unmarshal(req.Payload, &payload); err != nil {
			return fail(req.RequestID, "UNKNOWN", "Invalid command payload")
		}
		out, err := c.execute(payload.Command)
		if err != nil {
			return mapError(req.RequestID, err)
		}
		return ok(req.RequestID, map[string]string{"output": out})
	case "list-directory":
		var payload listDirectoryPayload
		if err := json.Unmarshal(req.Payload, &payload); err != nil {
			return fail(req.RequestID, "UNKNOWN", "Invalid list directory payload")
		}
		entries, err := c.listDirectory(payload.Path)
		if err != nil {
			return mapError(req.RequestID, err)
		}
		return ok(req.RequestID, map[string]any{"entries": entries})
	default:
		return fail(req.RequestID, "UNKNOWN", "Unsupported request type")
	}
}

func (c *companion) connect(payload connectPayload) error {
	if !payload.UserConsent {
		return fmt.Errorf("%w: user consent is required", errAuth)
	}
	if payload.Profile.Host == "" || payload.Profile.Username == "" {
		return fmt.Errorf("%w: host and username are required", errAuth)
	}

	keyPath := expandHome(payload.Profile.PrivateKeyPath)
	if keyPath == "" {
		keyPath = expandHome("~/.ssh/id_ed25519")
	}
	privateKey, err := os.ReadFile(keyPath)
	if err != nil {
		return fmt.Errorf("%w: key read failed: %v", errAuth, err)
	}

	signer, err := ssh.ParsePrivateKey(privateKey)
	if err != nil {
		return fmt.Errorf("%w: invalid private key", errAuth)
	}

	port := payload.Profile.Port
	if port == 0 {
		port = 22
	}

	host := payload.Profile.Host
	callback := c.buildHostKeyCallback(host)

	cfg := &ssh.ClientConfig{
		User:            payload.Profile.Username,
		Auth:            []ssh.AuthMethod{ssh.PublicKeys(signer)},
		HostKeyCallback: callback,
		Timeout:         12 * time.Second,
	}

	addr := fmt.Sprintf("%s:%d", host, port)
	client, err := ssh.Dial("tcp", addr, cfg)
	if err != nil {
		return mapDialError(err)
	}

	sftpClient, err := sftp.NewClient(client)
	if err != nil {
		_ = client.Close()
		return fmt.Errorf("%w: sftp init failed", errNetwork)
	}

	_ = c.disconnect()
	c.sshClient = client
	c.sftpClient = sftpClient
	return nil
}

func mapDialError(err error) error {
	var untrusted *hostUntrustedError
	if errors.As(err, &untrusted) {
		return untrusted
	}
	var mismatch *hostMismatchError
	if errors.As(err, &mismatch) {
		return mismatch
	}
	if strings.Contains(strings.ToLower(err.Error()), "unable to authenticate") {
		return fmt.Errorf("%w: authentication failed", errAuth)
	}
	var nerr net.Error
	if errors.As(err, &nerr) {
		return fmt.Errorf("%w: %v", errNetwork, err)
	}
	return fmt.Errorf("%w: %v", errNetwork, err)
}

func (c *companion) buildHostKeyCallback(host string) ssh.HostKeyCallback {
	return func(_ string, _ net.Addr, key ssh.PublicKey) error {
		fingerprint := ssh.FingerprintSHA256(key)
		c.mu.Lock()
		defer c.mu.Unlock()

		trusted, ok := c.knownHosts.Hosts[host]
		if !ok {
			return &hostUntrustedError{Host: host, Fingerprint: fingerprint}
		}
		if trusted != fingerprint {
			return &hostMismatchError{Host: host, Expected: trusted, Got: fingerprint}
		}
		return nil
	}
}

func (c *companion) trustHost(host, fingerprint string) error {
	if host == "" || fingerprint == "" {
		return fmt.Errorf("%w: host and fingerprint are required", errAuth)
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.knownHosts.Hosts[host] = fingerprint
	return c.saveKnownHosts()
}

func (c *companion) disconnect() error {
	if c.sftpClient != nil {
		_ = c.sftpClient.Close()
		c.sftpClient = nil
	}
	if c.sshClient != nil {
		err := c.sshClient.Close()
		c.sshClient = nil
		return err
	}
	return nil
}

func (c *companion) execute(command string) (string, error) {
	if c.sshClient == nil {
		return "", fmt.Errorf("%w: not connected", errNetwork)
	}
	session, err := c.sshClient.NewSession()
	if err != nil {
		return "", fmt.Errorf("%w: unable to open session", errNetwork)
	}
	defer session.Close()

	var b bytes.Buffer
	session.Stdout = &b
	session.Stderr = &b

	if err := session.Run(command); err != nil {
		return "", fmt.Errorf("%w: %v", errRemoteCommand, err)
	}
	return b.String(), nil
}

func (c *companion) listDirectory(path string) ([]fileEntry, error) {
	if c.sftpClient == nil {
		return nil, fmt.Errorf("%w: not connected", errNetwork)
	}
	if path == "" {
		path = "/"
	}

	entries, err := c.sftpClient.ReadDir(path)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", errRemoteCommand, err)
	}

	sort.Slice(entries, func(i, j int) bool {
		if entries[i].IsDir() == entries[j].IsDir() {
			return entries[i].Name() < entries[j].Name()
		}
		return entries[i].IsDir()
	})

	items := make([]fileEntry, 0, len(entries))
	for _, entry := range entries {
		items = append(items, fileEntry{
			Name:       entry.Name(),
			Path:       filepath.Join(path, entry.Name()),
			IsDir:      entry.IsDir(),
			Size:       entry.Size(),
			ModifiedAt: entry.ModTime().Format(time.RFC3339),
			Perms:      entry.Mode().String(),
		})
	}
	return items, nil
}

func (c *companion) loadKnownHosts() error {
	c.mu.Lock()
	defer c.mu.Unlock()

	content, err := os.ReadFile(c.knownHostsPath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return c.saveKnownHosts()
		}
		return err
	}

	if len(content) == 0 {
		c.knownHosts = knownHostsStore{Hosts: map[string]string{}}
		return nil
	}

	if err := json.Unmarshal(content, &c.knownHosts); err != nil {
		return err
	}
	if c.knownHosts.Hosts == nil {
		c.knownHosts.Hosts = map[string]string{}
	}
	return nil
}

func (c *companion) saveKnownHosts() error {
	if c.knownHosts.Hosts == nil {
		c.knownHosts.Hosts = map[string]string{}
	}
	data, err := json.MarshalIndent(c.knownHosts, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(c.knownHostsPath), 0o700); err != nil {
		return err
	}
	return os.WriteFile(c.knownHostsPath, data, 0o600)
}

func resolveKnownHostsPath() (string, error) {
	cfg, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(cfg, "vm-desktop", "known_hosts.json"), nil
}

var (
	errAuth          = errors.New("auth")
	errNetwork       = errors.New("network")
	errRemoteCommand = errors.New("remote-command")
	errHostMismatch  = errors.New("host-mismatch")
	errHostUntrusted = errors.New("host-untrusted")
)

type hostUntrustedError struct {
	Host        string
	Fingerprint string
}

func (e *hostUntrustedError) Error() string {
	return fmt.Sprintf("%s is untrusted. Fingerprint %s", e.Host, e.Fingerprint)
}

func (e *hostUntrustedError) Unwrap() error { return errHostUntrusted }

type hostMismatchError struct {
	Host     string
	Expected string
	Got      string
}

func (e *hostMismatchError) Error() string {
	return fmt.Sprintf("host key changed for %s (expected %s, got %s)", e.Host, e.Expected, e.Got)
}

func (e *hostMismatchError) Unwrap() error { return errHostMismatch }

func mapError(requestID string, err error) response {
	switch {
	case errors.Is(err, errAuth):
		return fail(requestID, "AUTH_FAILED", cleanError(err))
	case errors.Is(err, errHostMismatch):
		return fail(requestID, "HOST_KEY_MISMATCH", cleanError(err))
	case errors.Is(err, errHostUntrusted):
		return fail(requestID, "HOST_UNTRUSTED", cleanError(err))
	case errors.Is(err, errNetwork):
		return fail(requestID, "TIMEOUT", cleanError(err))
	case errors.Is(err, errRemoteCommand):
		return fail(requestID, "REMOTE_COMMAND_FAILED", cleanError(err))
	default:
		return fail(requestID, "UNKNOWN", cleanError(err))
	}
}

func cleanError(err error) string {
	parts := strings.SplitN(err.Error(), ": ", 2)
	if len(parts) == 2 {
		return parts[1]
	}
	return err.Error()
}

func ok(requestID string, payload any) response {
	return response{RequestID: requestID, OK: true, Payload: payload}
}

func fail(requestID, code, message string) response {
	return response{RequestID: requestID, OK: false, Error: &responseError{Code: code, Message: message}}
}

func readMessage(r io.Reader) (request, error) {
	var req request
	lenBuf := make([]byte, 4)
	if _, err := io.ReadFull(r, lenBuf); err != nil {
		return req, err
	}
	msgLen := binary.LittleEndian.Uint32(lenBuf)
	if msgLen == 0 {
		return req, io.EOF
	}
	msg := make([]byte, msgLen)
	if _, err := io.ReadFull(r, msg); err != nil {
		return req, err
	}
	if err := json.Unmarshal(msg, &req); err != nil {
		return req, err
	}
	return req, nil
}

func writeMessage(w io.Writer, res response) error {
	writer := bufio.NewWriter(w)
	payload, err := json.Marshal(res)
	if err != nil {
		return err
	}
	lenBuf := make([]byte, 4)
	binary.LittleEndian.PutUint32(lenBuf, uint32(len(payload)))
	if _, err = writer.Write(lenBuf); err != nil {
		return err
	}
	if _, err = writer.Write(payload); err != nil {
		return err
	}
	return writer.Flush()
}

func expandHome(path string) string {
	if path == "" || path[0] != '~' {
		return path
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return path
	}
	if path == "~" {
		return home
	}
	if len(path) > 1 && (path[1] == '/' || path[1] == '\\') {
		return filepath.Join(home, path[2:])
	}
	return path
}

func hostManifestPath() string {
	switch runtime.GOOS {
	case "darwin":
		return filepath.Join(os.Getenv("HOME"), "Library", "Application Support", "Google", "Chrome", "NativeMessagingHosts", "com.harith.vm_desktop.json")
	case "windows":
		return `%LOCALAPPDATA%\\Google\\Chrome\\User Data\\NativeMessagingHosts\\com.harith.vm_desktop.json`
	default:
		return filepath.Join(os.Getenv("HOME"), ".config", "google-chrome", "NativeMessagingHosts", "com.harith.vm_desktop.json")
	}
}

func init() {
	if os.Getenv("VM_DESKTOP_SHOW_HOST_MANIFEST_PATH") == "1" {
		_, _ = fmt.Fprintln(os.Stderr, hostManifestPath())
	}
	if os.Getenv("VM_DESKTOP_OPENSSH_CHECK") == "1" {
		_, _ = exec.LookPath("ssh")
	}
}
